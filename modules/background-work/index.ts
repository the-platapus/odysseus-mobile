// Keeps downloads and replies running while the app is in the background, and shows them as
// notifications (Live Updates on Android 16). Android only: on iOS these calls do nothing,
// because iOS downloads already continue in the background on their own, and iOS doesn't let
// an app use the GPU in the background, so a reply can't continue there.

import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

export type WorkKind = 'download' | 'generation';

export type WorkContent = {
  title: string;
  text: string;
  /** 0–100 shows a progress bar; leave it out for text-only work like a reply. */
  progress?: number;
};

/** Notification buttons: "cancel-download"; "timeout" when Android ended the service (6 h limit). */
export type WorkAction = 'cancel-download' | 'timeout';

type NativeModule = {
  start(kind: WorkKind, title: string, text: string, progress: number | null): void;
  update(kind: WorkKind, title: string, text: string, progress: number | null): void;
  stop(kind: WorkKind, doneTitle: string | null, doneText: string | null): void;
  dismissFinished(): void;
  addListener(event: 'onAction', listener: (event: { action: WorkAction }) => void): { remove(): void };
};

const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeModule>('BackgroundWork') : null;

// Android drops notification updates that come faster than a few per second, and every
// update costs battery, so at most one per second per kind; the latest content always wins.
const UPDATE_INTERVAL_MS = 1000;
const throttles: Partial<Record<WorkKind, { last: number; pending: WorkContent | null; timer: ReturnType<typeof setTimeout> | null }>> = {};

const progressOf = (content: WorkContent) =>
  typeof content.progress === 'number' && Number.isFinite(content.progress) ? Math.round(content.progress) : null;

let permissionAsked = false;

// Bumped by every start and stop. startWork can wait on the permission prompt, and if the work
// was stopped (a short reply finished) during that wait, starting late would leave a
// notification and wake lock that nothing stops.
const epochs: Partial<Record<WorkKind, number>> = {};
const bump = (kind: WorkKind) => (epochs[kind] = (epochs[kind] ?? 0) + 1);

// The notification needs this on Android 13+. Without it the work still keeps running, just
// without anything to see in the notification shade.
async function askNotificationPermission() {
  if (permissionAsked || Platform.OS !== 'android' || Number(Platform.Version) < 33) return;
  permissionAsked = true;
  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  } catch {
    // keep going without notifications
  }
}

export async function startWork(kind: WorkKind, content: WorkContent) {
  if (!native) return;
  const epoch = bump(kind);
  await askNotificationPermission();
  if (epochs[kind] !== epoch) return; // stopped or restarted while the prompt was open
  throttles[kind] = { last: Date.now(), pending: null, timer: null };
  try {
    native.start(kind, content.title, content.text, progressOf(content));
  } catch (e: any) {
    console.log(`App Alert: Background work could not start: ${e?.message ?? e}`);
  }
}

export function updateWork(kind: WorkKind, content: WorkContent) {
  if (!native) return;
  const t = throttles[kind];
  if (!t) return; // not started
  const send = (c: WorkContent) => {
    t.last = Date.now();
    t.pending = null;
    try {
      native.update(kind, c.title, c.text, progressOf(c));
    } catch {
      // the notification just stays as it was
    }
  };
  const wait = UPDATE_INTERVAL_MS - (Date.now() - t.last);
  if (wait <= 0 && !t.timer) return send(content);
  t.pending = content;
  if (!t.timer) {
    t.timer = setTimeout(() => {
      t.timer = null;
      if (t.pending) send(t.pending);
    }, Math.max(wait, 0));
  }
}

/** End the work. `done` posts a separate "finished" notification, meant for when the user is away. */
export function stopWork(kind: WorkKind, done?: { title: string; text: string }) {
  if (!native) return;
  bump(kind);
  const t = throttles[kind];
  if (t?.timer) clearTimeout(t.timer);
  delete throttles[kind];
  try {
    native.stop(kind, done?.title ?? null, done?.text ?? null);
  } catch {
    // nothing left to stop
  }
}

/** Clear "finished" notifications, e.g. once the user is back in the app. */
export function dismissFinishedWork() {
  try {
    native?.dismissFinished();
  } catch {
    // nothing to clear
  }
}

export function addWorkActionListener(listener: (action: WorkAction) => void): { remove(): void } {
  if (!native) return { remove() {} };
  return native.addListener('onAction', (event) => listener(event.action));
}
