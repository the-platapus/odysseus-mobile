// Built-in "files" MCP server: the mobile counterpart of Odysseus' native file tools
// (ls / read_file / write_file / edit_file / grep). Every path is confined to one root folder,
// either the app's workspace or a phone folder the user picked; the model sees that root as "/".

import { McpServer, ServerTool, ToolArgs } from '../server';
import { textResult, errorResult } from '../protocol';

export type FsEntry = {
  name: string;
  isDirectory: boolean;
  size: number | null;
  modified: number | null;
};

/** Storage backend. Paths are segment arrays relative to the root; [] is the root itself. */
export interface FsAdapter {
  describeRoot(): string;
  stat(path: string[]): Promise<FsEntry | null>;
  list(path: string[]): Promise<FsEntry[]>;
  readText(path: string[]): Promise<string>;
  /** Creates missing parent folders. Replaces an existing file. */
  writeText(path: string[], content: string): Promise<void>;
  /** Creates missing parent folders. Succeeds if the folder exists. */
  mkdir(path: string[]): Promise<void>;
  remove(path: string[]): Promise<void>;
}

const MAX_READ_BYTES = 1024 * 1024;
const MAX_READ_CHARS = 3500;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;

/**
 * Normalize a model-supplied path to root-relative segments. Absolute paths are taken as
 * relative to the root; "..", NUL and other control characters are refused.
 */
export function resolvePath(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'string') throw new Error('Path must be a string.');
  if (/[\x00-\x1f]/.test(input)) throw new Error('Path contains control characters.');
  const segments: string[] = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new Error('Path may not contain "..": it must stay inside the folder.');
    segments.push(segment);
  }
  return segments;
}

export const displayPath = (segments: string[]) => '/' + segments.join('/');

const formatSize = (bytes: number | null) => {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const looksBinary = (text: string) => text.slice(0, 4096).includes('\u0000');

export function createFilesystemServer(fs: FsAdapter): McpServer {
  const requireFile = async (path: string[]) => {
    if (path.length === 0) throw new Error('A file path is required.');
    const entry = await fs.stat(path);
    if (!entry) throw new Error(`No such file: ${displayPath(path)}`);
    if (entry.isDirectory) throw new Error(`${displayPath(path)} is a folder, not a file.`);
    return entry;
  };

  const readTextFile = async (path: string[]) => {
    const entry = await requireFile(path);
    if ((entry.size ?? 0) > MAX_READ_BYTES) {
      throw new Error(`${displayPath(path)} is ${formatSize(entry.size)}; files over 1 MB can't be read.`);
    }
    const text = await fs.readText(path);
    if (looksBinary(text)) throw new Error(`${displayPath(path)} looks like a binary file.`);
    return text;
  };

  const tools: ServerTool[] = [
    {
      name: 'list_directory',
      description: 'List the files and folders in a folder. Use "/" for the top level.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder path, e.g. "/" or "/notes"' } },
      },
      handler: async (args: ToolArgs) => {
        const path = resolvePath(args.path);
        if (path.length > 0) {
          const entry = await fs.stat(path);
          if (!entry) return errorResult(`No such folder: ${displayPath(path)}`);
          if (!entry.isDirectory) return errorResult(`${displayPath(path)} is a file, not a folder.`);
        }
        const entries = (await fs.list(path)).sort((a, b) =>
          a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
        );
        if (entries.length === 0) return textResult(`${displayPath(path)} is empty.`);
        const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) =>
          e.isDirectory ? `[DIR]  ${e.name}/` : `[FILE] ${e.name}  (${formatSize(e.size)})`
        );
        if (entries.length > MAX_LIST_ENTRIES) lines.push(`…and ${entries.length - MAX_LIST_ENTRIES} more`);
        return textResult(`${displayPath(path)}:\n${lines.join('\n')}`);
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file. For long files, pass offset (first line, 1-based) and limit (number of lines).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, e.g. "/notes/todo.txt"' },
          offset: { type: 'integer', description: 'First line to read, 1-based' },
          limit: { type: 'integer', description: 'Number of lines to read' },
        },
        required: ['path'],
      },
      handler: async (args: ToolArgs) => {
        const path = resolvePath(args.path);
        const lines = (await readTextFile(path)).split('\n');
        const start = Math.max(1, Number(args.offset ?? 1));
        const end = args.limit ? Math.min(lines.length, start + Number(args.limit) - 1) : lines.length;
        let body = lines.slice(start - 1, end).join('\n');
        let note = start > 1 || end < lines.length ? `(lines ${start}-${end} of ${lines.length})` : '';
        if (body.length > MAX_READ_CHARS) {
          const shownLines = body.slice(0, MAX_READ_CHARS).split('\n').length;
          body = body.slice(0, MAX_READ_CHARS);
          note = `(showing lines ${start}-${start + shownLines - 1} of ${lines.length}; ` +
            `call again with offset=${start + shownLines - 1} to continue)`;
        }
        return textResult(`${displayPath(path)} ${note}\n${body}`.trim());
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file with the given content. Missing folders are created.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, e.g. "/notes/todo.txt"' },
          content: { type: 'string', description: 'The full file content' },
        },
        required: ['path', 'content'],
      },
      handler: async (args: ToolArgs) => {
        const path = resolvePath(args.path);
        if (path.length === 0) return errorResult('A file path is required.');
        const existing = await fs.stat(path);
        if (existing?.isDirectory) return errorResult(`${displayPath(path)} is a folder.`);
        const content = String(args.content);
        await fs.writeText(path, content);
        return textResult(`${existing ? 'Overwrote' : 'Created'} ${displayPath(path)} (${content.length} characters).`);
      },
    },
    {
      name: 'edit_file',
      description: 'Replace one exact, unique piece of text in a file with new text.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_text: { type: 'string', description: 'Exact text to replace; must appear exactly once' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      handler: async (args: ToolArgs) => {
        const path = resolvePath(args.path);
        const oldText = String(args.old_text);
        if (!oldText) return errorResult('old_text must not be empty.');
        const text = await readTextFile(path);
        const count = text.split(oldText).length - 1;
        if (count === 0) return errorResult(`old_text was not found in ${displayPath(path)}. Read the file first.`);
        if (count > 1) return errorResult(`old_text appears ${count} times; include more surrounding text so it is unique.`);
        await fs.writeText(path, text.replace(oldText, () => String(args.new_text)));
        return textResult(`Edited ${displayPath(path)}.`);
      },
    },
    {
      name: 'create_directory',
      description: 'Create a folder (and any missing parent folders).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder path, e.g. "/projects/new"' } },
        required: ['path'],
      },
      handler: async (args: ToolArgs) => {
        const path = resolvePath(args.path);
        if (path.length === 0) return errorResult('A folder path is required.');
        const existing = await fs.stat(path);
        if (existing && !existing.isDirectory) return errorResult(`${displayPath(path)} is a file.`);
        await fs.mkdir(path);
        return textResult(existing ? `${displayPath(path)} already exists.` : `Created folder ${displayPath(path)}.`);
      },
    },
    {
      name: 'delete_path',
      description: 'Delete a file, or a folder and everything in it. This cannot be undone.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File or folder path' } },
        required: ['path'],
      },
      handler: async (args: ToolArgs) => {
        const path = resolvePath(args.path);
        if (path.length === 0) return errorResult('Refusing to delete the root folder.');
        const entry = await fs.stat(path);
        if (!entry) return errorResult(`No such file or folder: ${displayPath(path)}`);
        await fs.remove(path);
        return textResult(`Deleted ${entry.isDirectory ? 'folder' : 'file'} ${displayPath(path)}.`);
      },
    },
    {
      name: 'search_files',
      description: 'Find files whose name or text content contains a word or phrase (case-insensitive).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for' },
          path: { type: 'string', description: 'Folder to search in; default "/"' },
        },
        required: ['query'],
      },
      handler: async (args: ToolArgs) => {
        const query = String(args.query).toLowerCase();
        if (!query.trim()) return errorResult('query must not be empty.');
        const results: string[] = [];
        let scanned = 0;
        const queue: string[][] = [resolvePath(args.path)];
        while (queue.length && results.length < MAX_SEARCH_RESULTS && scanned < MAX_SEARCH_FILES) {
          const dir = queue.shift()!;
          let entries: FsEntry[];
          try {
            entries = await fs.list(dir);
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (results.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_FILES) break;
            const path = [...dir, entry.name];
            if (entry.isDirectory) {
              queue.push(path);
              continue;
            }
            scanned++;
            if (entry.name.toLowerCase().includes(query)) results.push(`${displayPath(path)}  (name match)`);
            if ((entry.size ?? 0) > MAX_SEARCH_FILE_BYTES) continue;
            let text: string;
            try {
              text = await fs.readText(path);
            } catch {
              continue;
            }
            if (looksBinary(text)) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                results.push(`${displayPath(path)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
              }
            }
          }
        }
        if (results.length === 0) return textResult(`No matches for "${args.query}".`);
        const capped = results.length >= MAX_SEARCH_RESULTS ? `\n(stopped at ${MAX_SEARCH_RESULTS} matches)` : '';
        return textResult(results.join('\n') + capped);
      },
    },
  ];

  return new McpServer({
    info: { name: 'odysseus-mobile-files', version: '1.0.0' },
    instructions: `File tools work inside ${fs.describeRoot()}. Its top level is "/".`,
    tools,
  });
}
