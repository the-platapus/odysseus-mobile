// Device-side backends for the MCP framework: expo-file-system for the files server and
// AsyncStorage for settings and memories. Everything in src/mcp outside this file and
// runtime.ts is plain TypeScript with no React Native imports.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import type { FsAdapter, FsEntry } from './builtin/filesystem';
import type { MemoryEntry, MemoryStore } from './builtin/memory';
import { McpSettings, normalizeSettings } from './config';

const SETTINGS_KEY = 'mcp_settings_v1';
const MEMORY_KEY = 'mcp_memory_v1';

export async function loadSettings(): Promise<McpSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeSettings(null);
  }
}

export async function saveSettings(settings: McpSettings) {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export const asyncStorageMemoryStore: MemoryStore = {
  async load(): Promise<MemoryEntry[]> {
    const raw = await AsyncStorage.getItem(MEMORY_KEY);
    if (!raw) return [];
    // Unlike a missing key, a corrupt value must not read as "no memories": the next save
    // would overwrite everything (the bug Odysseus fixed in issue #5673).
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Memory store is unreadable; nothing was changed.');
    return parsed;
  },
  async save(entries: MemoryEntry[]) {
    await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(entries));
  },
};

// --- Files -----------------------------------------------------------------------------------

export type FsRoot = {
  dir: Directory;
  /** How the model and the UI refer to the root. */
  label: string;
  isWorkspace: boolean;
  /** Set when a picked phone folder could not be opened and the workspace is used instead. */
  error?: string;
};

/** The app's private folder for agent files. Separate from documentDirectory so models (.gguf) stay out of reach. */
export function workspaceDirectory(): Directory {
  const dir = new Directory(Paths.document, 'workspace');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const WORKSPACE_LABEL = "the app's private workspace folder";

export function resolveFsRoot(uri: string | null): FsRoot {
  if (uri) {
    try {
      const dir = new Directory(uri);
      dir.list(); // throws if the folder or our access to it is gone
      // Android SAF names carry the volume ("primary:Documents"); show just the folder.
      return { dir, label: `the phone folder "${dir.name.split(':').pop()}"`, isWorkspace: false };
    } catch {
      return {
        dir: workspaceDirectory(),
        label: WORKSPACE_LABEL,
        isWorkspace: true,
        error: 'The picked phone folder is no longer accessible. Pick it again.',
      };
    }
  }
  return { dir: workspaceDirectory(), label: WORKSPACE_LABEL, isWorkspace: true };
}

/** Ask the user for a phone folder (Android: Storage Access Framework; iOS: Files). */
export async function pickPhoneFolder(): Promise<Directory | null> {
  try {
    return await Directory.pickDirectoryAsync();
  } catch (e: any) {
    if (/cancel/i.test(e?.message ?? '')) return null;
    throw e;
  }
}

const toEntry = (item: File | Directory): FsEntry =>
  item instanceof Directory
    ? { name: item.name, isDirectory: true, size: null, modified: null }
    : { name: item.name, isDirectory: false, size: item.size ?? null, modified: item.modificationTime ?? null };

// Only .txt gets a text MIME type: on Android, SAF appends an extension when the MIME type
// doesn't match the name (notes.md -> notes.md.txt), and octet-stream never triggers that.
const mimeFor = (name: string) => (name.toLowerCase().endsWith('.txt') ? 'text/plain' : 'application/octet-stream');

/**
 * FsAdapter over a Directory. Paths are resolved by listing each level and matching names
 * instead of joining URIs, because Android SAF (content://) folders can't be addressed by
 * path. The same code then serves the app workspace (file://) and picked phone folders.
 */
export class ExpoFsAdapter implements FsAdapter {
  private root: Directory;
  private label: string;
  private isSaf: boolean;

  constructor(root: FsRoot) {
    this.root = root.dir;
    this.label = root.label;
    this.isSaf = !root.dir.uri.startsWith('file:');
  }

  describeRoot() {
    return this.label;
  }

  private find(path: string[]): File | Directory | null {
    let current: File | Directory = this.root;
    for (const segment of path) {
      if (!(current instanceof Directory)) return null;
      const next: File | Directory | undefined = current.list().find((item) => item.name === segment);
      if (!next) return null;
      current = next;
    }
    return current;
  }

  private ensureDir(path: string[]): Directory {
    let current = this.root;
    for (const segment of path) {
      const next = current.list().find((item) => item.name === segment);
      if (next && !(next instanceof Directory)) throw new Error(`"${segment}" is a file, not a folder.`);
      current = next instanceof Directory ? next : current.createDirectory(segment);
    }
    return current;
  }

  async stat(path: string[]): Promise<FsEntry | null> {
    if (path.length === 0) return { name: '', isDirectory: true, size: null, modified: null };
    const item = this.find(path);
    return item ? toEntry(item) : null;
  }

  async list(path: string[]): Promise<FsEntry[]> {
    const item = this.find(path);
    if (!(item instanceof Directory)) throw new Error('Not a folder.');
    return item.list().map(toEntry);
  }

  async readText(path: string[]): Promise<string> {
    const item = this.find(path);
    if (!(item instanceof File)) throw new Error('Not a file.');
    return item.text();
  }

  async writeText(path: string[], content: string): Promise<void> {
    const parent = this.ensureDir(path.slice(0, -1));
    const name = path[path.length - 1];
    let file = parent.list().find((item) => item.name === name);
    if (file instanceof Directory) throw new Error(`"${name}" is a folder.`);
    if (file && this.isSaf) {
      // Some SAF providers open existing documents for writing without truncating them, which
      // would leave the tail of longer old content behind. Recreating the document avoids that.
      file.delete();
      file = undefined;
    }
    (file ?? parent.createFile(name, mimeFor(name))).write(content);
  }

  async mkdir(path: string[]): Promise<void> {
    this.ensureDir(path);
  }

  async remove(path: string[]): Promise<void> {
    const item = this.find(path);
    if (!item) throw new Error('No such file or folder.');
    item.delete();
  }
}

const uniqueName = (dir: Directory, name: string) => {
  const taken = new Set(dir.list().map((item) => item.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Copy files the user picks anywhere on the phone into the app workspace. Returns the names copied. */
export async function importFilesToWorkspace(): Promise<string[]> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  const workspace = workspaceDirectory();
  const imported: string[] = [];
  for (const asset of result.assets) {
    const source = new File(asset.uri);
    const name = uniqueName(workspace, asset.name || source.name);
    await source.copy(new File(workspace, name));
    try {
      source.delete(); // the picker's cache copy
    } catch {
      // harmless if the cache copy is already gone
    }
    imported.push(name);
  }
  return imported;
}
