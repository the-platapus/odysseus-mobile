// LMArena (https://arena.ai) text leaderboard scores for the Cookbook's "arena" filter. They come
// from the open dataset LMArena publishes on Hugging Face (CC BY 4.0), since arena.ai itself only
// answers browsers. No React Native imports, so it can be tested outside the app.
//
// The leaderboard ranks models, not files, and mostly big ones. A repo only gets a score when it
// clearly is a ranked model: the official release, or a straight quantization of it under the
// same name. Fine-tunes, merges and "uncensored" re-releases differ from the model that was
// ranked, so they get none.

export type ArenaScore = { name: string; rating: number; rank: number };
export type ArenaBoard = { publishedOn: string; scores: Record<string, ArenaScore> };

type ArenaRow = {
  model_name: string;
  license: string;
  rating: number;
  rank: number;
  category: string;
  leaderboard_publish_date: string;
};

const PAGE = 100;
const PAGES_AT_ONCE = 5;
export const arenaRowsUrl = (offset: number) =>
  `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=text&split=latest&offset=${offset}&length=${PAGE}`;

// Publishers whose own releases the leaderboard ranks. A repo from anyone else only counts as a
// quantization of one of theirs; a publisher missing here only means its models get no score.
const OFFICIAL_ORGS = new Set([
  '01-ai', 'ai21labs', 'allenai', 'arcee-ai', 'baidu', 'coherelabs', 'cohereforai', 'deepseek-ai',
  'facebook', 'google', 'huggingfacetb', 'ibm-granite', 'inclusionai', 'internlm', 'liquidai',
  'meituan-longcat', 'meta-llama', 'microsoft', 'minimaxai', 'mistralai', 'moonshotai', 'nexusflow',
  'nousresearch', 'nvidia', 'openai', 'openbmb', 'primeintellect', 'qwen', 'snowflake', 'stepfun-ai',
  'tencent', 'thudm', 'tiiuae', 'upstage', 'xiaomimimo', 'zai-org',
]);

const orgOf = (repo: string) => repo.split('/')[0].toLowerCase();

/** "bartowski/Nanbeige_Nanbeige4.3-33B-GGUF" -> "Nanbeige4.3-33B": the model's own name. */
function modelName(repo: string, baseOrg?: string): string {
  let name = repo.split('/').pop() ?? repo;
  name = name.replace(/([-_](i1|imat|imatrix))?[-_.]gguf$/i, '');
  // Some quantizers put the original publisher in front: "Org_Model".
  if (baseOrg && name.toLowerCase().startsWith(`${baseOrg.toLowerCase()}_`)) name = name.slice(baseOrg.length + 1);
  return name;
}

/** Letters, digits and dots only: "Gemma 3 4B IT" and "gemma-3-4b-it" both give "gemma34bit". */
export const arenaKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9.]+/g, '');

/**
 * The official repo this one is, when it is one: itself, or the model it quantizes under the
 * same name. Null for fine-tunes, merges, adapters and repos that only borrow a model's name.
 */
export function officialRepoOf(repo: string, tags: string[] = []): string | null {
  // "base_model:quantized:google/gemma-3-4b-it"; the other relations are finetune, merge, adapter.
  const lineage = tags.map((t) => t.split(':')).filter((p) => p[0] === 'base_model' && p.length === 3);
  const bases = [...new Set(lineage.filter(([, relation]) => relation === 'quantized').map(([, , base]) => base))];
  // A publisher's own release, even one built on another model (NVIDIA's Llama Nemotron).
  if (OFFICIAL_ORGS.has(orgOf(repo)) && !bases.length) return repo;
  if (lineage.some(([, relation]) => relation !== 'quantized')) return null;
  if (bases.length !== 1 || !OFFICIAL_ORGS.has(orgOf(bases[0]))) return null;
  // Tags are written by whoever uploads, and fine-tunes are often tagged as quantizations of
  // their base model ("Gemma-4-31B-Humanlike-Chat"), so the name has to match as well.
  const base = bases[0];
  return arenaKey(modelName(repo, orgOf(base))) === arenaKey(modelName(base)) ? base : null;
}

/** The score of the model an official repo holds, if the leaderboard ranks it. */
export function arenaScoreOf(officialRepo: string | null | undefined, board: ArenaBoard | null): ArenaScore | null {
  if (!officialRepo || !board) return null;
  const name = modelName(officialRepo);
  // The leaderboard sometimes leaves "Instruct" off ("Granite 4.2 3B").
  return board.scores[arenaKey(name)] ?? board.scores[arenaKey(name.replace(/[-_ ](instruct|it|chat)$/i, ''))] ?? null;
}

/**
 * Index the overall ranking's open-weight models by name. Names with a qualifier in brackets
 * ("Qwen3-30B-A3B-Instruct (2507)", "Llama 3.1 405B Instruct (BF16)") are also indexed with it
 * folded in and, when no other model shares the result, without it.
 */
export function buildArenaBoard(rows: ArenaRow[]): ArenaBoard {
  const open = rows.filter((r) => r.category === 'overall' && r.license !== 'Proprietary');
  const scores: Record<string, ArenaScore> = {};
  for (const r of open) scores[arenaKey(r.model_name)] ??= { name: r.model_name, rating: r.rating, rank: r.rank };
  const withoutBrackets = new Map<string, ArenaRow[]>();
  for (const r of open) {
    const key = arenaKey(r.model_name.replace(/\([^)]*\)/g, ''));
    withoutBrackets.set(key, [...(withoutBrackets.get(key) ?? []), r]);
  }
  for (const [key, matches] of withoutBrackets) {
    if (matches.length === 1 && !scores[key]) scores[key] = { name: matches[0].model_name, rating: matches[0].rating, rank: matches[0].rank };
  }
  return { publishedOn: rows[0]?.leaderboard_publish_date ?? '', scores };
}

/** The overall ranking comes first in the dataset (about 420 rows), then each category's own. */
export async function fetchArenaBoard(): Promise<ArenaBoard> {
  const rows: ArenaRow[] = [];
  for (let offset = 0; offset < 50 * PAGE; offset += PAGES_AT_ONCE * PAGE) {
    const pages = await Promise.all(
      Array.from({ length: PAGES_AT_ONCE }, async (_, i) => {
        const response = await fetch(arenaRowsUrl(offset + i * PAGE));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { rows: { row: ArenaRow }[] };
      })
    );
    const page = pages.flatMap((p) => p.rows.map((r) => r.row));
    rows.push(...page.filter((r) => r.category === 'overall'));
    if (page.length < PAGES_AT_ONCE * PAGE || page.some((r) => r.category !== 'overall')) break;
  }
  if (!rows.length) throw new Error('The leaderboard had no scores.');
  return buildArenaBoard(rows);
}
