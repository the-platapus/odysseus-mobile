// Device side of failure reports: capture llama.cpp's log while a model loads or answers,
// notice when either crashed the app, remember where each model file came from, and offer
// the report. The report itself is built in ./report.ts.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { Alert, Linking, Platform, Share } from 'react-native';
import { BuildInfo, addNativeLogListener, getBackendDevicesInfo, loadLlamaModelInfo, toggleNativeLog } from 'llama.rn';
import appJson from '../../app.json';
import { GITHUB_REPO, LOAD_FAILURE_TEMPLATE, REPLY_CRASH_TEMPLATE } from '../repo';
import { LoadFailure, ReplyProgress, buildIssue, diagnose, issueUrl, reportText } from './report';

const PENDING_LOAD_KEY = 'pending_model_load_v1';
const PENDING_REPLY_KEY = 'pending_reply_v1';
const MODEL_SOURCES_KEY = 'model_sources_v1';
const MAX_LOG_LINES = 400;
// The on-disk copy is rewritten from the in-memory tail whenever it grows past this, so it
// stays small but still ends with the lines right before a crash.
const MAX_FILE_LINES = 2000;
// How often a running reply saves how far it got.
const REPLY_SAVE_MS = 2000;

export type ModelSource = NonNullable<LoadFailure['source']>;

const fileNameOf = (uri: string) => decodeURIComponent(uri.split('/').pop() ?? uri);
const loadLogFile = () => new File(Paths.cache, 'model-load.log');
const replyLogFile = () => new File(Paths.cache, 'reply.log');

let captured: string[] = [];
let subscription: { remove: () => void } | null = null;

/** Start capturing llama.cpp's native log, in memory and in `file` so it survives a crash. */
async function startLogCapture(file: File) {
  captured = [];
  let fileLines = 0;
  try {
    file.create({ overwrite: true });
  } catch {
    // logging to disk is best effort
  }
  subscription?.remove();
  subscription = addNativeLogListener((level, text) => {
    const line = `[${level}] ${text.replace(/\s+$/, '')}`;
    captured.push(line);
    if (captured.length > MAX_LOG_LINES) captured.shift();
    try {
      // Also on disk, so the log survives if the app crashes or is killed.
      if (++fileLines > MAX_FILE_LINES) {
        file.write(captured.join('\n') + '\n');
        fileLines = captured.length;
      } else {
        file.write(line + '\n', { append: true });
      }
    } catch {
      // ignore: the in-memory copy is still there
    }
  });
  try {
    await toggleNativeLog(true);
  } catch {
    // without native logs the report just has less detail
  }
}

/** Stop capturing. Returns the captured log lines. */
async function stopLogCapture(): Promise<string[]> {
  try {
    await toggleNativeLog(false);
  } catch {
    // nothing to undo
  }
  subscription?.remove();
  subscription = null;
  return captured.slice();
}

/** The log a capture saved to `file` before the app died. */
function readSavedLog(file: File): string[] {
  try {
    return file.textSync().split('\n').filter(Boolean).slice(-MAX_LOG_LINES);
  } catch {
    return []; // no log saved
  }
}

/** Call right before initLlama. Marks the load as in progress and starts capturing the native log. */
export async function beginModelLoad(uri: string) {
  await AsyncStorage.setItem(PENDING_LOAD_KEY, JSON.stringify({ uri, startedAt: Date.now() }));
  await startLogCapture(loadLogFile());
}

/** Call when initLlama returns or throws. Returns the captured log lines. */
export async function endModelLoad(): Promise<string[]> {
  const log = await stopLogCapture();
  await AsyncStorage.removeItem(PENDING_LOAD_KEY);
  return log;
}

/**
 * If the last model load never finished (the app crashed or was killed while loading), return
 * that model and the log saved before it died. Clears the marker, so it's reported only once.
 */
export async function takeInterruptedLoad(): Promise<{ uri: string; log: string[] } | null> {
  const raw = await AsyncStorage.getItem(PENDING_LOAD_KEY);
  if (!raw) return null;
  await AsyncStorage.removeItem(PENDING_LOAD_KEY);
  let uri = '';
  try {
    uri = JSON.parse(raw).uri ?? '';
  } catch {
    return null;
  }
  if (!uri) return null;
  return { uri, log: readSavedLog(loadLogFile()) };
}

// Replies get the same treatment as loads. A phone that runs out of memory mid-reply kills the
// app without warning (iOS doesn't even keep a crash log for it), so the marker and the log are
// written while the reply runs and checked on the next launch.

type ReplyInfo = Omit<ReplyProgress, 'tokens' | 'seconds'>;
type PendingReply = ReplyInfo & { uri: string; startedAt: number; savedAt: number; tokens: number };

let pendingReply: PendingReply | null = null;

/** Call right before a completion starts. Marks a reply as in progress and starts capturing the native log. */
export async function beginReply(uri: string, info: ReplyInfo) {
  const now = Date.now();
  pendingReply = { ...info, uri, startedAt: now, savedAt: now, tokens: 0 };
  await AsyncStorage.setItem(PENDING_REPLY_KEY, JSON.stringify(pendingReply));
  await startLogCapture(replyLogFile());
}

/** Call for every streamed token. Saves how far the reply got every couple of seconds. */
export function noteReplyToken() {
  const reply = pendingReply;
  if (!reply) return;
  reply.tokens++;
  const now = Date.now();
  if (now - reply.savedAt < REPLY_SAVE_MS) return;
  reply.savedAt = now;
  AsyncStorage.setItem(PENDING_REPLY_KEY, JSON.stringify(reply)).catch(() => {});
}

/** Call when the completion returns, throws or is stopped. */
export async function endReply() {
  pendingReply = null;
  await stopLogCapture();
  await AsyncStorage.removeItem(PENDING_REPLY_KEY);
}

/**
 * If the app closed while a model was answering, return that model, how far the reply got by
 * its last save, and the log saved before the app died. Clears the marker, so it's reported only once.
 */
export async function takeInterruptedReply(): Promise<{ uri: string; reply: ReplyProgress; log: string[] } | null> {
  const raw = await AsyncStorage.getItem(PENDING_REPLY_KEY);
  if (!raw) return null;
  await AsyncStorage.removeItem(PENDING_REPLY_KEY);
  let saved: PendingReply;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved?.uri) return null;
  const { uri, startedAt, savedAt, mode, thinking, promptChars, tokens } = saved;
  return {
    uri,
    reply: { mode, thinking, promptChars, tokens, seconds: Math.round((savedAt - startedAt) / 1000) },
    log: readSavedLog(replyLogFile()),
  };
}

async function readSources(): Promise<Record<string, ModelSource>> {
  try {
    const raw = await AsyncStorage.getItem(MODEL_SOURCES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Remember which repo and file a downloaded model came from, for reports. */
export async function recordModelSource(uri: string, source: ModelSource) {
  const all = await readSources();
  all[fileNameOf(uri)] = source;
  await AsyncStorage.setItem(MODEL_SOURCES_KEY, JSON.stringify(all));
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

/** Gather everything a report needs about a failed load, or a reply the app closed during. */
export async function collectLoadFailure(input: {
  kind: LoadFailure['kind'];
  uri: string;
  error?: string;
  log: string[];
  settings: LoadFailure['settings'];
  reply?: ReplyProgress;
}): Promise<LoadFailure> {
  const { kind, uri } = input;
  let fileSize: number | null = null;
  try {
    const file = new File(uri);
    fileSize = file.exists ? file.size : null;
  } catch {
    // unreadable path
  }
  const source = (await readSources())[fileNameOf(uri)] ?? null;
  // After a crash the header isn't read: if reading it were what crashed, the app would
  // crash again on every launch.
  const metadata = kind === 'error' ? ((await withTimeout(loadLlamaModelInfo(uri), 5000)) as Record<string, unknown> | null) : null;
  const backends = (await withTimeout(getBackendDevicesInfo(), 3000)) ?? [];

  return {
    kind,
    ...(input.reply ? { reply: input.reply } : {}),
    error: input.error,
    fileName: fileNameOf(uri),
    fileSize,
    source,
    metadata,
    device: {
      brand: Device.brand,
      model: Device.modelName,
      os: Device.osName ?? Platform.OS,
      osVersion: Device.osVersion,
      apiLevel: Device.platformApiLevel,
      ramBytes: Device.totalMemory,
      abis: Device.supportedCpuArchitectures ?? [],
    },
    app: { version: appJson.expo.version, llamaCppBuild: `b${BuildInfo.number} (${BuildInfo.commit})` },
    settings: input.settings,
    backends: backends.map((b) => `${b.backend}${b.deviceName ? `: ${b.deviceName}` : ''}`),
    log: input.log,
  };
}

/**
 * Tell the user what went wrong and offer to report it. GitHub opens with the issue form
 * filled in, so nothing is sent until they press Submit there; Share is for testers
 * without a GitHub account.
 */
export function offerLoadFailureReport(failure: LoadFailure) {
  const issue = buildIssue(failure);
  const cause = diagnose(failure);
  const intro = failure.reply
    ? `Last time, the app closed while ${failure.fileName} was answering. If you closed it yourself, you can ignore this.`
    : failure.kind === 'crash'
      ? `Last time, the app closed while loading ${failure.fileName}, so it wasn't loaded again automatically.`
      : `${failure.fileName} couldn't be loaded.`;
  const title = failure.reply ? 'App closed while answering' : failure.kind === 'crash' ? 'Model crashed the app' : 'Model failed to load';
  const template = failure.reply ? REPLY_CRASH_TEMPLATE : LOAD_FAILURE_TEMPLATE;
  const message = [
    intro,
    ...(cause ? ['', cause] : []),
    '',
    "Report it so it can be fixed? GitHub opens a pre-filled issue for you to check before submitting. It includes the model, your phone model, OS version and RAM, and llama.cpp's log.",
  ].join('\n');

  Alert.alert(title, message, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Share', onPress: () => Share.share({ message: reportText(issue) }).catch(() => {}) },
    {
      text: 'Report on GitHub',
      onPress: () =>
        Linking.openURL(issueUrl(GITHUB_REPO, template, issue)).catch((e) => alert(`Could not open GitHub: ${e.message}`)),
    },
  ]);
}
