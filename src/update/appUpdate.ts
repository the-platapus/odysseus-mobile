// Device side of app updates: check this repo's GitHub releases once per launch, remember
// "Later" per release, and on Android download the APK and hand it to the system installer.
// Which release is newer, and which file to take, is decided in ./releases.ts.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { Linking, Platform } from 'react-native';
import appJson from '../../app.json';
import { GITHUB_REPO } from '../repo';
import { GithubAsset, RunningBuild, Update, checkForUpdate } from './releases';

/** The tag of the release the user said "Later" to. A newer release asks again. */
const DISMISSED_KEY = 'update_dismissed_v1';
const APK_MIME = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const MANAGE_UNKNOWN_APP_SOURCES = 'android.settings.MANAGE_UNKNOWN_APP_SOURCES';

// expo-intent-launcher throws on import in a build made before it was added (a development
// build still in use), so it's only loaded where its native half exists.
const intentLauncher = (): typeof import('expo-intent-launcher') | null =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Platform.OS === 'android' && requireOptionalNativeModule('ExpoIntentLauncher') ? require('expo-intent-launcher') : null;

/** Whether this build can hand an APK to Android's installer; without it, the release page has the APK. */
export const canInstallApk = () => intentLauncher() !== null;

/** This build: app.json's version, plus the release app.config.js recorded if GitHub Actions built it. */
export function runningBuild(): RunningBuild {
  const release = Constants.expoConfig?.extra?.release;
  return {
    version: appJson.expo.version,
    release: typeof release?.runNumber === 'number' && typeof release?.tag === 'string' ? release : null,
  };
}

// The APK is ~150 MB, so only the one being offered is kept, in the cache.
const updatesDir = () => new Directory(Paths.cache, 'updates');
const apkFile = (asset: GithubAsset) => new File(updatesDir(), asset.name);

function deleteApksExcept(keep: string | null) {
  try {
    const dir = updatesDir();
    if (!dir.exists) return;
    for (const item of dir.list()) if (item.name !== keep) item.delete();
  } catch {
    // the cache gets cleared by the system eventually
  }
}

let checked = false;

/**
 * The update to offer, once per launch. null when this build is the newest, the user said
 * "Later" to this release, or GitHub can't be reached (offline, rate-limited): nothing to show.
 */
export async function findUpdateToOffer(): Promise<Update | null> {
  if (checked || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return null;
  checked = true;
  try {
    const found = await checkForUpdate(GITHUB_REPO, runningBuild(), Platform.OS, Device.supportedCpuArchitectures ?? []);
    const update = found && (await AsyncStorage.getItem(DISMISSED_KEY)) !== found.release.tag_name ? found : null;
    // The APK of an update that's installed, superseded or put off isn't needed any more.
    deleteApksExcept(update?.asset?.name ?? null);
    return update;
  } catch (e: any) {
    console.log(`Update check skipped: ${e?.message ?? e}`);
    return null;
  }
}

export const dismissUpdate = (update: Update) => AsyncStorage.setItem(DISMISSED_KEY, update.release.tag_name).catch(() => {});

export const openReleasePage = (update: Update) => Linking.openURL(update.release.html_url).catch(() => {});

/**
 * Download the APK, reporting progress from 0 to 1. A complete earlier download is used as it
 * is: allowing installs from this app can restart it, and the user then taps Update again.
 */
export function downloadApk(asset: GithubAsset, onProgress: (fraction: number) => void): { done: Promise<File>; cancel: () => void } {
  const file = apkFile(asset);
  if (file.exists && file.size === asset.size) return { done: Promise.resolve(file), cancel: () => {} };
  deleteApksExcept(null);
  updatesDir().create({ intermediates: true, idempotent: true });
  const task = File.createDownloadTask(asset.browser_download_url, file, {
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten / (totalBytes > 0 ? totalBytes : asset.size)),
  });
  const done = task.downloadAsync().then((downloaded) => {
    if (!downloaded || downloaded.size !== asset.size) {
      throw new Error(`The download stopped at ${downloaded?.size ?? 0} of ${asset.size} bytes.`);
    }
    return downloaded;
  });
  return { done, cancel: () => task.cancel() };
}

/**
 * Hand the APK to Android's package installer. If the update goes through, Android replaces
 * the app (closing it), and its installer offers to open the new one. This resolves when the
 * user is back without it: they cancelled, installs from this app aren't allowed (the installer
 * says so and links to the setting), or the installer showed an error.
 */
export async function installApk(file: File) {
  const launcher = intentLauncher();
  if (!launcher) throw new Error('this build of the app has no way to open it');
  const params = { data: file.contentUri, type: APK_MIME, flags: FLAG_GRANT_READ_URI_PERMISSION };
  try {
    // Only the package installer handles this action; VIEW can also go to file managers.
    await launcher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', params);
  } catch {
    await launcher.startActivityAsync('android.intent.action.VIEW', params);
  }
}

/** Android's "Install unknown apps" setting for this app. */
export async function openInstallSettings() {
  const launcher = intentLauncher();
  if (!launcher) return;
  try {
    await launcher.startActivityAsync(MANAGE_UNKNOWN_APP_SOURCES, { data: `package:${appJson.expo.android.package}` });
  } catch {
    // some phones only have the list of all apps
    await launcher.startActivityAsync(MANAGE_UNKNOWN_APP_SOURCES).catch(() => {});
  }
}
