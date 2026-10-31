// Model load failure reports: a likely cause in plain words, and a GitHub issue pre-filled with
// what's needed to fix it. No React Native imports, so it can be tested outside the app.
//
// "Failed to load model" is all the JS error says. The reason is in llama.cpp's own log (an
// unknown architecture, running out of memory, a truncated file), so the report carries the
// log lines captured during the load, plus the GGUF metadata and the device.

/** How far a reply got before the app closed, from its last save (every couple of seconds). */
export type ReplyProgress = {
  /** 'plain': the bare User:/Assistant: prompt. 'template': the model's chat template. 'agent': the template with tools. */
  mode: 'plain' | 'template' | 'agent';
  thinking: boolean;
  promptChars: number;
  tokens: number;
  seconds: number;
};

export type LoadFailure = {
  /** 'error': initLlama threw. 'crash': the app closed while loading, or while answering when `reply` is set (found on next launch). */
  kind: 'error' | 'crash';
  reply?: ReplyProgress;
  error?: string;
  fileName: string;
  fileSize: number | null;
  source: { origin: 'cookbook' | 'recommended' | 'import'; repo?: string; path?: string; expectedSize?: number } | null;
  metadata: Record<string, unknown> | null;
  device: {
    brand: string | null;
    model: string | null;
    os: string | null;
    osVersion: string | null;
    apiLevel: number | null;
    ramBytes: number | null;
    abis: string[];
  };
  app: { version: string; llamaCppBuild: string };
  settings: Record<string, string | number | boolean>;
  backends: string[];
  log: string[];
};

export type IssueFields = { title: string; model: string; error: string; device: string; log: string };

const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;

/** Keep file names, drop the private directories in front of them. */
export const redactPaths = (text: string) =>
  text
    .replace(/(file:\/\/)?\/(?:data|storage|private|var|Users|sdcard)\/[^\s'"]*\/([^/\s'"]+)/g, '…/$2')
    .replace(/content:\/\/[^\s'"]+/g, 'content://…');

/** The likeliest cause, in words a tester understands, or null when nothing points to one. */
export function diagnose(f: LoadFailure): string | null {
  const log = f.log.join('\n');
  if (f.reply) {
    const when = f.reply.tokens ? 'while answering' : 'while reading the prompt, before it wrote anything';
    return `The app closed ${when}. That usually means the phone ran out of memory: phones close apps that use too much without warning. Try a smaller model or a smaller quantization.`;
  }
  const meta = f.metadata ?? {};
  const arch = log.match(/unknown model architecture: '([^']+)'/);
  if (arch) return `This model's architecture (${arch[1]}) isn't supported by this app's llama.cpp version yet.`;
  if (meta['general.type'] === 'mmproj' || meta['general.architecture'] === 'clip') {
    return 'This file is a vision projector (mmproj), not a model. Download the model file from the same repo instead.';
  }
  const parts = Number(meta['split.count'] ?? 0);
  if (parts > 1) return `This file is one part of a model split into ${parts} files, which the app can't load yet.`;
  const expected = f.source?.expectedSize;
  if (expected && f.fileSize !== null && f.fileSize < expected) {
    return `The file is incomplete (${gb(f.fileSize)} of ${gb(expected)}). Delete it and download it again.`;
  }
  if (/failed to (allocate|create context)|out of memory|cannot allocate|unable to allocate|insufficient memory|ErrorOutOfDeviceMemory/i.test(log)) {
    return 'The phone ran out of memory loading this model. Try a smaller model or a smaller quantization.';
  }
  if (/invalid magic|failed to read magic|not a gguf|tensor data is not within the file bounds|unexpected end of file|failed to read/i.test(log)) {
    return 'The file looks damaged or incomplete. Delete it and download it again.';
  }
  if (/wrong number of tensors|missing tensor|tensor '[^']+' not found|wrong shape/i.test(log)) {
    return "The file doesn't match what this app's llama.cpp expects for its architecture (often a newer or modified format).";
  }
  if (f.kind === 'crash') {
    return 'The app closed while loading this model. That usually means the phone ran out of memory.';
  }
  return null;
}

const META_KEYS = [
  'general.architecture',
  'general.name',
  'general.basename',
  'general.size_label',
  'general.type',
  'general.file_type',
  'split.count',
];

function metadataLines(meta: Record<string, unknown> | null): string[] {
  if (!meta) return ['- GGUF metadata: could not be read'];
  const arch = String(meta['general.architecture'] ?? '');
  const keys = [...META_KEYS, `${arch}.context_length`, `${arch}.block_count`, `${arch}.expert_count`];
  return keys
    .filter((k) => meta[k] !== undefined && meta[k] !== '')
    .map((k) => `- \`${k}\`: ${String(meta[k]).slice(0, 80)}`);
}

/**
 * The log lines worth sending: every error or warning, then the last lines before the end,
 * in their original order and with private paths removed.
 */
export function relevantLog(lines: string[], tail = 25): string[] {
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (/error|fail|warn|unknown|unsupported|abort|assert|exception/i.test(line)) keep.add(i);
  });
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => redactPaths(lines[i]).slice(0, 220));
}

export function buildIssue(f: LoadFailure): IssueFields {
  const cause = diagnose(f);
  const src = f.source;
  const model = [
    `- File: \`${f.fileName}\`${f.fileSize !== null ? ` (${gb(f.fileSize)})` : ''}`,
    src?.repo
      ? `- From: [${src.repo}](https://huggingface.co/${src.repo})${src.path ? ` → \`${src.path}\`` : ''} via ${src.origin === 'recommended' ? 'Recommended' : 'the Cookbook'}`
      : `- From: ${src?.origin === 'import' || !src ? 'imported from the phone' : src.origin}`,
    ...(src?.expectedSize ? [`- Expected size: ${gb(src.expectedSize)}`] : []),
    ...metadataLines(f.metadata),
  ].join('\n');

  const r = f.reply;
  const error = [
    r
      ? `The app closed while the model was answering (crash or killed by the system). By its last save the reply had ${r.tokens} tokens after ${r.seconds} s (${r.mode} prompt of ${r.promptChars} characters, thinking ${r.thinking ? 'on' : 'off'}).`
      : f.kind === 'crash'
        ? 'The app closed while loading the model (crash or killed by the system).'
        : `\`${redactPaths(f.error ?? 'Unknown error')}\``,
    ...(cause ? ['', `Likely cause: ${cause}`] : []),
  ].join('\n');

  const d = f.device;
  const device = [
    `- Phone: ${[d.brand, d.model].filter(Boolean).join(' ') || 'unknown'}`,
    `- OS: ${d.os ?? '?'} ${d.osVersion ?? ''}${d.apiLevel ? ` (API ${d.apiLevel})` : ''}`,
    `- RAM: ${d.ramBytes ? gb(d.ramBytes) : 'unknown'}`,
    `- CPU ABIs: ${d.abis.join(', ') || 'unknown'}`,
    `- Backends: ${f.backends.join(', ') || 'unknown'}`,
    `- App: ${f.app.version}, llama.cpp build ${f.app.llamaCppBuild}`,
    `- Settings: ${Object.entries(f.settings).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  ].join('\n');

  return {
    title: `${r ? 'App closed while answering' : 'Model failed to load'}: ${f.fileName}`.slice(0, 120),
    model,
    error,
    device,
    log: relevantLog(f.log).join('\n') || '(no llama.cpp log was captured)',
  };
}

/**
 * A "new issue" URL that opens the repo's issue form with every field filled in. Only the
 * title and form fields are passed: GitHub rejects parameters like labels from visitors who
 * lack permission for them, so the label comes from the template. Log lines are dropped from
 * the start until the URL fits, since GitHub refuses URLs that are too long.
 */
export function issueUrl(repo: string, template: string, issue: IssueFields, maxLength = 7500): string {
  const build = (log: string) =>
    `https://github.com/${repo}/issues/new?template=${encodeURIComponent(template)}` +
    (['title', 'model', 'error', 'device'] as const).map((k) => `&${k}=${encodeURIComponent(issue[k])}`).join('') +
    `&log=${encodeURIComponent(log)}`;
  let lines = issue.log.split('\n');
  let url = build(lines.join('\n'));
  while (url.length > maxLength && lines.length > 1) {
    lines = lines.slice(1);
    url = build(`…(earlier lines trimmed)\n${lines.join('\n')}`);
  }
  return url.length > maxLength ? build('(log too long to include; use Share instead)') : url;
}

/** The same report as plain text, for sharing outside GitHub. */
export const reportText = (issue: IssueFields) =>
  [issue.title, '', '## Model', issue.model, '', '## Error', issue.error, '', '## Device', issue.device, '', '## llama.cpp log', '```', issue.log, '```'].join('\n');
