// The model download in progress, kept on disk so it can be resumed after the app is closed or
// the connection drops. A download is written to "<name>.gguf.part" and renamed only once its
// size matches exactly, so a half-downloaded file can never look like a finished model.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const PENDING_DOWNLOAD_KEY = 'pending_download_v1';

export type PendingDownload = {
  url: string;
  partUri: string;
  finalUri: string;
  /** What the Cookbook passed in, so a resume can download the same file again. */
  model: { id: string; name: string; recommended?: boolean };
  file: { path: string; size: number; quant: string };
};

export const partUriFor = (finalUri: string) => `${finalUri}.part`;

export async function savePendingDownload(download: PendingDownload) {
  await AsyncStorage.setItem(PENDING_DOWNLOAD_KEY, JSON.stringify(download));
}

export async function clearPendingDownload() {
  await AsyncStorage.removeItem(PENDING_DOWNLOAD_KEY);
}

/** The interrupted download and how much of it is on disk, or null if there's none to resume. */
export async function loadPendingDownload(): Promise<(PendingDownload & { bytesOnDisk: number }) | null> {
  let pending: PendingDownload;
  try {
    const raw = await AsyncStorage.getItem(PENDING_DOWNLOAD_KEY);
    if (!raw) return null;
    pending = JSON.parse(raw);
  } catch {
    return null;
  }
  const info = await FileSystem.getInfoAsync(pending.partUri);
  if (!info.exists) {
    await clearPendingDownload();
    return null;
  }
  return { ...pending, bytesOnDisk: info.size ?? 0 };
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
