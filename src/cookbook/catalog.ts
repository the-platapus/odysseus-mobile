// Cookbook data: Hugging Face models turned into catalog entries, the filter pills, and the
// "Recommended" list parsed from the repo README. No React Native imports, so it can be tested
// outside the app.

import { whyRepoUnsupported } from '../engines/support';

export type Feature = 'thinking' | 'tools' | 'moe';

export type CatalogModel = {
  id: string; // Hugging Face repo, e.g. "unsloth/Qwen3-1.7B-GGUF"
  name: string;
  paramsB: number | null;
  /** Estimated phone RAM needed, in GB (the README's rule of thumb). */
  ramGb: number | null;
  family: string | null;
  features: Feature[];
  architecture: string | null;
  contextLength: number | null;
  downloads: number;
  // Only set for entries from the README's "Tested models" table:
  recommended?: boolean;
  file?: string;
  testedOn?: string;
};

export type HfApiModel = {
  id: string;
  downloads?: number;
  tags?: string[];
  gguf?: { total?: number; architecture?: string; context_length?: number; chat_template?: string };
};

// --- Hugging Face API ------------------------------------------------------------------------

export function hfModelsUrl({ search, limit = 100 }: { search?: string; limit?: number } = {}) {
  const params = [
    'filter=gguf',
    'pipeline_tag=text-generation',
    // Search results are ranked by downloads; the default list shows what's trending.
    `sort=${search ? 'downloads' : 'trendingScore'}`,
    'direction=-1',
    `limit=${limit}`,
    // gguf metadata gives exact parameter counts, the architecture and the chat template.
    ...['gguf', 'downloads', 'tags'].map((field) => `expand%5B%5D=${field}`),
  ];
  if (search) params.unshift(`search=${encodeURIComponent(search)}`);
  return `https://huggingface.co/api/models?${params.join('&')}`;
}

// --- Model facts -----------------------------------------------------------------------------

// Same rule of thumb as the README: ~0.7 GB per billion parameters at 4 bits, plus 1.5 GB for the system.
export const GB_PER_BILLION_PARAMS = 0.7;
export const SYSTEM_RAM_GB = 1.5;
export const ramNeededGb = (paramsB: number) => Math.ceil(paramsB * GB_PER_BILLION_PARAMS + SYSTEM_RAM_GB);

/** "Qwen3-1.7B-Instruct" -> 1.7; MoE names give the total ("24B-A2B" -> 24). */
export function paramsFromName(name: string): number | null {
  const match = name.match(/[-_/ ](\d+(?:\.\d+)?)[Bb](?![a-zA-Z])/);
  return match ? parseFloat(match[1]) : null;
}

// Checked against the repo name first, then its base_model tags. Order matters: the first match wins.
const FAMILIES: [RegExp, string][] = [
  [/qwen|qwq/i, 'qwen'],
  [/llama/i, 'llama'],
  [/gemma/i, 'gemma'],
  [/phi-?\d|phi/i, 'phi'],
  [/mistral|mixtral|ministral|magistral/i, 'mistral'],
  [/deepseek/i, 'deepseek'],
  [/lfm/i, 'lfm'],
  [/glm/i, 'glm'],
  [/granite/i, 'granite'],
  [/smollm/i, 'smollm'],
  [/nemotron/i, 'nemotron'],
  [/olmo/i, 'olmo'],
  [/minicpm/i, 'minicpm'],
  [/exaone/i, 'exaone'],
  [/falcon/i, 'falcon'],
  [/hermes/i, 'hermes'],
];

export function familyOf(id: string, tags: string[] = []): string | null {
  const baseModels = tags.filter((t) => t.startsWith('base_model:')).join(' ');
  for (const text of [id, baseModels]) {
    for (const [pattern, family] of FAMILIES) if (pattern.test(text)) return family;
  }
  return null;
}

const displayName = (id: string) => (id.split('/').pop() ?? id).replace(/[-_]GGUF$/i, '').replace(/-/g, ' ');

export function fromHfModel(m: HfApiModel): CatalogModel {
  const tags = (m.tags ?? []).map((t) => t.toLowerCase());
  const template = m.gguf?.chat_template ?? '';
  const id = m.id.toLowerCase();
  const paramsB = m.gguf?.total ? Math.round(m.gguf.total / 1e8) / 10 : paramsFromName(m.id);

  const features: Feature[] = [];
  // The chat template is the best evidence: it's what llama.cpp will actually use.
  if (/enable_thinking|<think>|reasoning_content/.test(template) || tags.includes('reasoning') || /think|reason|qwq|-r1\b/.test(id)) {
    features.push('thinking');
  }
  if (/\btools\b|tool_call/.test(template) || tags.some((t) => ['tool-calling', 'function-calling', 'tool-use'].includes(t))) {
    features.push('tools');
  }
  if (tags.includes('moe') || /moe|-a\d+(\.\d+)?b\b|\d+x\d+b/.test(id)) features.push('moe');

  return {
    id: m.id,
    name: displayName(m.id),
    paramsB,
    ramGb: paramsB ? ramNeededGb(paramsB) : null,
    family: familyOf(m.id, m.tags),
    features,
    architecture: m.gguf?.architecture ?? null,
    contextLength: m.gguf?.context_length ?? null,
    downloads: m.downloads ?? 0,
  };
}

// --- Filters ---------------------------------------------------------------------------------

export const SIZE_BUCKETS = [
  { key: 'tiny', label: '≤2B', min: 0, max: 2 },
  { key: 'small', label: '2–4B', min: 2, max: 4 },
  { key: 'medium', label: '4–9B', min: 4, max: 9 },
  { key: 'large', label: '9B+', min: 9, max: Infinity },
] as const;

export const FEATURES: { key: Feature; label: string }[] = [
  { key: 'thinking', label: 'thinking' },
  { key: 'tools', label: 'tools' },
  { key: 'moe', label: 'MoE' },
];

export type Filters = {
  fitsPhone: boolean;
  size: string | null;
  feature: Feature | null;
  family: string | null;
};

export const NO_FILTERS: Filters = { fitsPhone: false, size: null, feature: null, family: null };

export const fitsPhone = (m: CatalogModel, phoneRamGb: number | null) =>
  phoneRamGb === null || m.ramGb === null || m.ramGb <= phoneRamGb;

/** Why no engine in the app can run this repo's models, judged by the architecture Hugging Face reports. */
export const whyCantRun = (m: CatalogModel) => whyRepoUnsupported('gguf', m.architecture);

/** Fits the phone's RAM and an engine can run it. */
export const runsHere = (m: CatalogModel, phoneRamGb: number | null) => fitsPhone(m, phoneRamGb) && !whyCantRun(m);

const inBucket = (m: CatalogModel, key: string) => {
  const bucket = SIZE_BUCKETS.find((b) => b.key === key);
  // min is exclusive except for the first bucket, so 2B is "≤2B" and 4B is "2–4B".
  return !!bucket && m.paramsB !== null && m.paramsB <= bucket.max && (bucket.min === 0 ? true : m.paramsB > bucket.min);
};

export function matchesFilters(m: CatalogModel, f: Filters, phoneRamGb: number | null): boolean {
  if (f.fitsPhone && !runsHere(m, phoneRamGb)) return false;
  if (f.size && !inBucket(m, f.size)) return false;
  if (f.feature && !m.features.includes(f.feature)) return false;
  if (f.family && m.family !== f.family) return false;
  return true;
}

export function matchesQuery(m: CatalogModel, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${m.id} ${m.name} ${m.family ?? ''} ${m.architecture ?? ''}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** Counts for the pills, like Odysseus' tag chips. Families are listed most common first. */
export function chipCounts(models: CatalogModel[], phoneRamGb: number | null) {
  const families = new Map<string, number>();
  for (const m of models) if (m.family) families.set(m.family, (families.get(m.family) ?? 0) + 1);
  return {
    all: models.length,
    fitsPhone: models.filter((m) => runsHere(m, phoneRamGb)).length,
    sizes: Object.fromEntries(SIZE_BUCKETS.map((b) => [b.key, models.filter((m) => inBucket(m, b.key)).length])),
    features: Object.fromEntries(FEATURES.map((f) => [f.key, models.filter((m) => m.features.includes(f.key)).length])),
    families: [...families].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

// --- Recommended models from the README ------------------------------------------------------

const REPO_ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

// Escaped pipes (\|) are swapped out before splitting so they stay inside their cell.
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/\\\|/g, '\u0000')
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/\u0000/g, '|'));

/** Plain text of a Markdown cell; for links, the link text (or a Hugging Face repo from the URL). */
function cellText(cell: string, wantRepo = false): string {
  const link = cell.match(/\[([^\]]*)\]\(([^)]*)\)/);
  if (link && wantRepo) {
    const fromUrl = link[2].match(/huggingface\.co\/([^/?#\s]+\/[^/?#\s]+)/);
    if (fromUrl) return fromUrl[1];
  }
  // Underscores are left alone: they're part of quant names like Q4_K_M.
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

const COLUMN_NAMES: Record<string, RegExp> = {
  model: /^(model|name)$/i,
  repo: /^(repo|repository|hugging ?face( repo)?|hf( repo)?)$/i,
  file: /^(file|gguf|gguf file)$/i,
  features: /^(features|tags|capabilities|works with)$/i,
  testedOn: /^(tested on|tested|devices?|phones?)$/i,
};

/**
 * Read the "Tested models" table from the README. Columns are matched by header name, so they
 * can be reordered; only Repo is required. Rows with an invalid repo are skipped.
 */
export function parseRecommended(markdown: string): CatalogModel[] {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+(tested|recommended) models\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const level = (lines[start].match(/^#+/) ?? ['##'])[0].length;

  const table: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= level) break;
    const line = lines[i].trim();
    if (line.startsWith('|')) table.push(line);
    else if (table.length) break; // the first table ends at the first non-table line
  }
  if (table.length < 2) return [];

  const header = splitRow(table[0]).map((h) => cellText(h));
  const column = (key: string) => header.findIndex((h) => COLUMN_NAMES[key].test(h));
  const cols = { model: column('model'), repo: column('repo'), file: column('file'), features: column('features'), testedOn: column('testedOn') };
  if (cols.repo < 0) return [];

  const out: CatalogModel[] = [];
  for (const line of table.slice(1)) {
    if (/^\|?[\s:|-]+$/.test(line)) continue; // the |---|---| separator
    const cells = splitRow(line);
    const get = (i: number, wantRepo = false) => (i >= 0 && i < cells.length ? cellText(cells[i], wantRepo) : '');
    const repo = get(cols.repo, true);
    if (!REPO_ID.test(repo)) continue;
    const file = get(cols.file);
    const name = get(cols.model) || displayName(repo);
    const words = get(cols.features).toLowerCase();
    const features = FEATURES.map((f) => f.key).filter((key) => words.includes(key.toLowerCase()));
    const paramsB = paramsFromName(` ${name}`) ?? paramsFromName(repo);
    out.push({
      id: repo,
      name,
      paramsB,
      ramGb: paramsB ? ramNeededGb(paramsB) : null,
      family: familyOf(`${repo} ${name}`),
      features,
      architecture: null,
      contextLength: null,
      downloads: 0,
      recommended: true,
      ...(file.toLowerCase().endsWith('.gguf') ? { file } : {}),
      ...(get(cols.testedOn) ? { testedOn: get(cols.testedOn) } : {}),
    });
  }
  return out;
}
