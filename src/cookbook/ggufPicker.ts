// Picks which .gguf file of a Hugging Face repo to download.
//
// The old rule (first file containing "q4_k_m.gguf", else the first .gguf) chose files that can
// never load on about 1 in 6 trending repos: vision projectors (mmproj-*.gguf), part 1 of a
// split model (-00001-of-00004.gguf), or a full-precision BF16/F16 file several times the size
// of a phone's RAM. This ranks every loadable file instead, and looks in subfolders too.

export type HfTreeEntry = {
  type: 'file' | 'directory' | string;
  path: string;
  size?: number;
  lfs?: { size?: number };
};

export type GgufFile = { path: string; size: number; quant: string };

export type PickResult =
  | { ok: true; file: GgufFile; fits: boolean }
  | { ok: false; error: string };

const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
// Companion files that ship next to models: adapters, tokenizer-only files, and the small
// draft models used for speculative decoding. ("-mtp.gguf" files are full models with
// multi-token-prediction heads, so "mtp" is deliberately not listed.)
const AUXILIARY = /(?:^|[-_.])(lora|adapter|vocab|imatrix|draft|dflash|dspark)(?:[-_.]|$)/i;
// No usable language model is this small; anything under it is a companion file.
const MIN_MODEL_BYTES = 20 * 1024 * 1024;

// Phone-friendly order: 4-bit first (best quality per GB), then 5/3-bit, then larger, then
// very low bit-widths, and full precision last. Unknown names sit just before full precision.
const QUANT_RANK: [RegExp, string][] = [
  [/Q4_K_M/, 'Q4_K_M'],
  [/Q4_K_S/, 'Q4_K_S'],
  [/Q4_K_XL/, 'Q4_K_XL'],
  [/IQ4_XS/, 'IQ4_XS'],
  [/IQ4_NL/, 'IQ4_NL'],
  [/Q4_0/, 'Q4_0'],
  [/Q4_1/, 'Q4_1'],
  [/MXFP4/, 'MXFP4'],
  [/Q5_K_M/, 'Q5_K_M'],
  [/Q5_K_S/, 'Q5_K_S'],
  [/Q5_K_XL/, 'Q5_K_XL'],
  [/Q3_K_L/, 'Q3_K_L'],
  [/Q3_K_M/, 'Q3_K_M'],
  [/Q3_K_XL/, 'Q3_K_XL'],
  [/Q5_0|Q5_1/, 'Q5_0'],
  [/Q6_K/, 'Q6_K'],
  [/Q8_0|Q8_K/, 'Q8_0'],
  [/IQ3_/, 'IQ3'],
  [/Q3_K_S/, 'Q3_K_S'],
  [/Q2_K/, 'Q2_K'],
  [/IQ2_/, 'IQ2'],
  [/TQ\d/, 'TQ'],
  [/IQ1_/, 'IQ1'],
];
const UNKNOWN_RANK = QUANT_RANK.length;
const FULL_PRECISION = /(?:^|[-_.])(F16|BF16|F32|FP16|FP32)(?:[-_.]|$)/;

const basename = (path: string) => path.split('/').pop() ?? path;
const sizeOf = (entry: HfTreeEntry) => entry.lfs?.size ?? entry.size ?? 0;

export function quantOf(path: string): { rank: number; quant: string } {
  const name = basename(path).toUpperCase();
  for (let i = 0; i < QUANT_RANK.length; i++) {
    if (QUANT_RANK[i][0].test(name)) return { rank: i, quant: QUANT_RANK[i][1] };
  }
  const full = name.replace(/\.GGUF$/, '').match(FULL_PRECISION);
  if (full) return { rank: UNKNOWN_RANK + 1, quant: full[1] };
  return { rank: UNKNOWN_RANK, quant: 'unknown' };
}

/** Why a .gguf file can't be loaded as a chat model on its own, or null if it can. */
export function unloadableReason(path: string, size = 0): string | null {
  const name = basename(path).toLowerCase();
  if (!name.endsWith('.gguf')) return 'not a GGUF file';
  if (name.includes('mmproj')) return 'a vision projector (mmproj), not a model';
  const shard = name.match(SHARD);
  if (shard) return `part ${Number(shard[1])} of a model split into ${Number(shard[2])} files`;
  const aux = name.match(AUXILIARY);
  if (aux) return `a companion file (${aux[1]}), not a model`;
  if (size > 0 && size < MIN_MODEL_BYTES) return 'too small to be a model';
  return null;
}

/**
 * Choose the file to download.
 * @param tree      repo listing (use `?recursive=true` so subfolders are included)
 * @param preferred exact path to use, e.g. from the Recommended list
 * @param maxBytes  largest file the phone can likely hold in RAM; the best-ranked file under it
 *                  wins, otherwise the best-ranked file overall is returned with fits=false
 */
export function pickGgufFile(tree: HfTreeEntry[], preferred?: string, maxBytes?: number): PickResult {
  const files = tree.filter((e) => e.type === 'file' && e.path.toLowerCase().endsWith('.gguf'));
  const fitsIn = (size: number) => !maxBytes || !size || size <= maxBytes;

  if (preferred) {
    const entry = files.find((e) => e.path === preferred || basename(e.path) === preferred);
    if (!entry) return { ok: false, error: `The file ${preferred} is no longer in this repo.` };
    const size = sizeOf(entry);
    return { ok: true, file: { path: entry.path, size, quant: quantOf(entry.path).quant }, fits: fitsIn(size) };
  }

  const loadable = files
    .filter((e) => unloadableReason(e.path, sizeOf(e)) === null)
    .map((e) => ({ path: e.path, size: sizeOf(e), ...quantOf(e.path) }))
    .sort((a, b) => a.rank - b.rank || a.size - b.size);

  if (loadable.length === 0) {
    if (files.some((e) => SHARD.test(e.path))) {
      return { ok: false, error: 'This model is only available split into several files, which the app can’t load yet.' };
    }
    if (files.length > 0) return { ok: false, error: 'This repo has no model file the app can load, only companion files (vision projector, adapter or draft model).' };
    return { ok: false, error: 'No .gguf model file found in this repo.' };
  }

  // Files with unrecognised names (often draft heads or experiments) only count when the repo
  // has nothing with a known quant; a fitting "unknown" must not win over a real quant.
  const known = loadable.filter((f) => f.rank < UNKNOWN_RANK);
  const pool = known.length ? known : loadable;
  const best = pool.find((f) => fitsIn(f.size)) ?? pool[0];
  return { ok: true, file: { path: best.path, size: best.size, quant: best.quant }, fits: fitsIn(best.size) };
}
