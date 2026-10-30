// Model downloads in progress, kept on disk so they can be resumed after the app is closed or
// the connection drops. A download is written to "<name>.gguf.part" and renamed only once its
// size matches exactly, so a half-downloaded file can never look like a finished model.
// Several can run at once, so each is stored under its own key, by the file it ends up as.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const PENDING_DOWNLOAD_PREFIX = 'pending_download_v2:';
// Before downloads could run side by side there was at most one, under this key.
const LEGACY_PENDING_DOWNLOAD_KEY = 'pending_download_v1';

export type PendingDownload = {
  url: string;
  partUri: string;
  finalUri: string;
  /** What the Cookbook passed in, so a resume can download the same file again. */
  model: { id: string; name: string; recommended?: boolean };
  file: { path: string; size: number; quant: string };
};

export const partUriFor = (finalUri: string) => `${finalUri}.part`;

const keyFor = (finalUri: string) => PENDING_DOWNLOAD_PREFIX + finalUri;

export async function savePendingDownload(download: PendingDownload) {
  await AsyncStorage.setItem(keyFor(download.finalUri), JSON.stringify(download));
}

export async function clearPendingDownload(finalUri: string) {
  await AsyncStorage.removeItem(keyFor(finalUri));
}

let legacyMigrated = false;

async function migrateLegacyPendingDownload() {
  if (legacyMigrated) return;
  const raw = await AsyncStorage.getItem(LEGACY_PENDING_DOWNLOAD_KEY);
  if (raw) {
    try {
      await savePendingDownload(JSON.parse(raw));
    } catch {
      // unreadable: nothing to carry over
    }
    await AsyncStorage.removeItem(LEGACY_PENDING_DOWNLOAD_KEY);
  }
  legacyMigrated = true;
}

/**
 * The interrupted downloads and how much of each is on disk. Records without a part file are
 * dropped, except for downloads that `isActive` says are running: those may not have written
 * their first bytes yet.
 */
export async function loadPendingDownloads(
  isActive: (finalUri: string) => boolean
): Promise<(PendingDownload & { bytesOnDisk: number })[]> {
  let entries: readonly (readonly [string, string | null])[];
  try {
    await migrateLegacyPendingDownload();
    const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(PENDING_DOWNLOAD_PREFIX));
    entries = await AsyncStorage.multiGet(keys);
  } catch {
    return [];
  }
  const pending: (PendingDownload & { bytesOnDisk: number })[] = [];
  for (const [key, raw] of entries) {
    let download: PendingDownload;
    try {
      download = JSON.parse(raw ?? '');
    } catch {
      await AsyncStorage.removeItem(key);
      continue;
    }
    const info = await FileSystem.getInfoAsync(download.partUri);
    // Asked after the wait, so a download that started meanwhile counts as running.
    if (isActive(download.finalUri)) continue;
    if (!info.exists) {
      await AsyncStorage.removeItem(key);
      continue;
    }
    pending.push({ ...download, bytesOnDisk: info.size ?? 0 });
  }
  return pending;
}

/**
 * The `resumeData` to continue from the bytes already on disk, or undefined to start over.
 * Android's downloader takes a byte count and asks the server for the rest (an HTTP Range
 * request). iOS resume data is an opaque blob from its download session that only exists
 * after a pause, so there a download that was cut off starts again.
 */
export function resumeDataFor(bytesOnDisk: number, expectedSize: number): string | undefined {
  if (Platform.OS !== 'android') return undefined;
  return bytesOnDisk > 0 && bytesOnDisk < expectedSize ? String(bytesOnDisk) : undefined;
}
