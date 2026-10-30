// Device side of model load failure reports: capture llama.cpp's log while a model loads,
// notice when a load crashed the app, remember where each model file came from, and offer
// the report. The report itself is built in ./report.ts.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { Alert, Linking, Platform, Share } from 'react-native';
import { BuildInfo, addNativeLogListener, getBackendDevicesInfo, loadLlamaModelInfo, toggleNativeLog } from 'llama.rn';
import appJson from '../../app.json';
import { GITHUB_REPO, LOAD_FAILURE_TEMPLATE } from '../repo';
import { LoadFailure, buildIssue, diagnose, issueUrl, reportText } from './report';

const PENDING_LOAD_KEY = 'pending_model_load_v1';
const MODEL_SOURCES_KEY = 'model_sources_v1';
const MAX_LOG_LINES = 400;
// The on-disk copy is rewritten from the in-memory tail whenever it grows past this, so it
// stays small but still ends with the lines right before a crash.
const MAX_FILE_LINES = 2000;

export type ModelSource = NonNullable<LoadFailure['source']>;

const fileNameOf = (uri: string) => decodeURIComponent(uri.split('/').pop() ?? uri);
const loadLogFile = () => new File(Paths.cache, 'model-load.log');

let captured: string[] = [];
let subscription: { remove: () => void } | null = null;

/** Call right before initLlama. Marks the load as in progress and starts capturing the native log. */
export async function beginModelLoad(uri: string) {
  await AsyncStorage.setItem(PENDING_LOAD_KEY, JSON.stringify({ uri, startedAt: Date.now() }));
  captured = [];
  const file = loadLogFile();
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
      // Also on disk, so the log survives if the load crashes the app.
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

/** Call when initLlama returns or throws. Returns the captured log lines. */
export async function endModelLoad(): Promise<string[]> {
  try {
    await toggleNativeLog(false);
  } catch {
    // nothing to undo
  }
  subscription?.remove();
  subscription = null;
  await AsyncStorage.removeItem(PENDING_LOAD_KEY);
  return captured.slice();
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
  let log: string[] = [];
  try {
    log = loadLogFile().textSync().split('\n').filter(Boolean).slice(-MAX_LOG_LINES);
  } catch {
    // no log saved
  }
  return { uri, log };
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

/** Gather everything a report needs about a failed load. */
export async function collectLoadFailure(input: {
  kind: LoadFailure['kind'];
  uri: string;
  error?: string;
  log: string[];
  settings: LoadFailure['settings'];
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
  const intro =
    failure.kind === 'crash'
      ? `Last time, the app closed while loading ${failure.fileName}, so it wasn't loaded again automatically.`
      : `${failure.fileName} couldn't be loaded.`;
  const message = [
    intro,
    ...(cause ? ['', cause] : []),
    '',
    "Report it so it can be fixed? GitHub opens a pre-filled issue for you to check before submitting. It includes the model, your phone model, OS version and RAM, and llama.cpp's log.",
  ].join('\n');

  Alert.alert(failure.kind === 'crash' ? 'Model crashed the app' : 'Model failed to load', message, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Share', onPress: () => Share.share({ message: reportText(issue) }).catch(() => {}) },
    {
      text: 'Report on GitHub',
      onPress: () =>
        Linking.openURL(issueUrl(GITHUB_REPO, LOAD_FAILURE_TEMPLATE, issue)).catch((e) => alert(`Could not open GitHub: ${e.message}`)),
    },
  ]);
}
