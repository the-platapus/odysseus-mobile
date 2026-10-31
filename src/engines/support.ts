// Which models the app can run, decided before a download (so a model that can't run isn't
// downloaded first) and used to explain a failed load. Each engine says why it can't run a
// model; a model is supported when any engine can run it. llama.rn (llama.cpp, GGUF files) is
// the only engine so far: a new one is another entry in ENGINES. No React Native imports, so it
// can be tested outside the app.

import { LLAMA_ARCHS } from './llamaArchs';

/** What's known about a model without loading it: from Hugging Face, or the file's own header. */
export type ModelFacts = {
  format: 'gguf';
  /** GGUF `general.architecture`, e.g. "qwen3". */
  architecture?: string | null;
  /** GGUF `general.type`: "model", or "mmproj" for a vision projector, "adapter" for a LoRA. */
  type?: string | null;
  /** GGUF `split.count`: how many files the model is split into. */
  splitCount?: number | null;
};

/** Why a model can't run: `reason` is a sentence for alerts, `label` a few words for a Cookbook card. */
export type Problem = { reason: string; label: string };

export type Engine = {
  name: string;
  formats: ModelFacts['format'][];
  /**
   * Architectures of files that ship next to models (vision projectors, draft models). Hugging
   * Face reports one file's architecture for a whole repo, and it can be one of these.
   */
  companionArchs: string[];
  /** Why this engine can't run the model, or null when it can, or when nothing says it can't. */
  problem(facts: ModelFacts): Problem | null;
};

// Architectures llama.cpp loads that aren't chat models.
const NOT_CHAT: (Problem & { archs: string[] })[] = [
  {
    label: 'embedding model',
    reason: "This is an embedding model: it turns text into vectors and can't chat.",
    archs: ['bert', 'modern-bert', 'nomic-bert', 'nomic-bert-moe', 'neo-bert', 'jina-bert-v2', 'jina-bert-v3', 'eurobert', 'gemma-embedding', 'llama-embed', 't5encoder'],
  },
  {
    label: 'text-to-speech model',
    reason: 'This is a text-to-speech model, not a chat model.',
    archs: ['wavtokenizer-dec', 'qwen3tts', 'pockettts', 'barbet'],
  },
  {
    label: 'draft model',
    reason: 'This is a draft model for speculative decoding, which only runs next to its main model. Download the main model instead.',
    archs: ['eagle3', 'dflash', 'gemma4-assistant'],
  },
  {
    label: 'diffusion model',
    reason: "This is a diffusion language model, which this app can't generate text with yet.",
    archs: ['dream', 'llada', 'llada-moe', 'rnd1'],
  },
];

const llamaArchs = new Set(LLAMA_ARCHS);

const llamaRn: Engine = {
  name: 'llama.rn',
  formats: ['gguf'],
  companionArchs: ['clip', 'eagle3', 'dflash', 'gemma4-assistant'],
  problem({ architecture: arch, type, splitCount }) {
    if (type === 'mmproj' || arch === 'clip') {
      return {
        label: 'vision projector, not a model',
        reason: 'This file is a vision projector (mmproj), not a model. Download the model file from the same repo instead.',
      };
    }
    if (type === 'adapter') {
      return { label: 'adapter, not a model', reason: 'This file is an adapter (LoRA) for another model, not a model on its own.' };
    }
    if (splitCount && splitCount > 1) {
      return {
        label: `split into ${splitCount} files`,
        reason: `This file is one part of a model split into ${splitCount} files, which the app can't load yet.`,
      };
    }
    if (!arch) return null;
    const notChat = NOT_CHAT.find((kind) => kind.archs.includes(arch));
    if (notChat) return { label: notChat.label, reason: notChat.reason };
    if (!llamaArchs.has(arch)) {
      return {
        label: `not supported yet (${arch})`,
        reason: `This model's architecture (${arch}) isn't supported by this app's llama.cpp version yet.`,
      };
    }
    return null;
  },
};

export const ENGINES: Engine[] = [llamaRn];

/** Null when some engine can run the model, otherwise why none can. */
export function whyUnsupported(facts: ModelFacts): Problem | null {
  const engines = ENGINES.filter((e) => e.formats.includes(facts.format));
  if (engines.length === 0) {
    return { label: `${facts.format} not supported`, reason: `No engine in this app runs ${facts.format} models yet.` };
  }
  let first: Problem | null = null;
  for (const engine of engines) {
    const problem = engine.problem(facts);
    if (!problem) return null;
    first ??= problem;
  }
  return first;
}

/**
 * The same for a whole Hugging Face repo, from the architecture Hugging Face reports for it.
 * That comes from one of its files, which may be a vision projector or draft model next to a
 * model that runs fine, so those architectures say nothing about the repo.
 */
export function whyRepoUnsupported(format: ModelFacts['format'], architecture: string | null): Problem | null {
  if (!architecture) return null;
  if (ENGINES.some((e) => e.formats.includes(format) && e.companionArchs.includes(architecture))) return null;
  return whyUnsupported({ format, architecture });
}
