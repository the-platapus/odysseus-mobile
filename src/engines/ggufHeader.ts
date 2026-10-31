// Reads the metadata at the start of a GGUF file, so a model can be checked before it's
// downloaded: the first 64 KB of the file on Hugging Face say which architecture it is and
// whether it's a model at all. No React Native imports, so it can be tested outside the app.

import type { ModelFacts } from './support';

export type GgufMetadata = Record<string, string | number | boolean>;

/**
 * How much of a remote file to read. Converters write general.architecture and general.type
 * first, within the first few hundred bytes; the tokenizer's vocabulary (megabytes) comes after
 * the model's own settings.
 */
export const HEADER_BYTES = 64 * 1024;

// GGUF value types: sizes of the fixed-size ones, and the two that aren't.
const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;

/**
 * The single-value metadata (numbers, strings, booleans) in `bytes`, the start of a GGUF file.
 * Arrays, mostly the tokenizer's, are skipped. Reading stops where the bytes end, so part of a
 * header gives the keys that fit in it. Null when it isn't a GGUF file.
 */
export function parseGgufMetadata(bytes: Uint8Array): GgufMetadata | null {
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'GGUF') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 64-bit counts are read as two halves, which is exact far beyond any real size.
  const u64 = (at: number) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
  const decoder = new TextDecoder();
  const meta: GgufMetadata = {};
  // Version 1 used 32-bit counts; nothing current writes it.
  if (view.getUint32(4, true) < 2) return null;
  const count = u64(16);
  let at = 24;
  const fits = (n: number) => at + n <= bytes.length;
  const readString = () => {
    if (!fits(8)) return null;
    const length = u64(at);
    if (!fits(8 + length)) return null;
    const text = decoder.decode(bytes.subarray(at + 8, at + 8 + length));
    at += 8 + length;
    return text;
  };
  const scalar = (type: number): number | boolean => {
    switch (type) {
      case 0: return view.getUint8(at);
      case 1: return view.getInt8(at);
      case 2: return view.getUint16(at, true);
      case 3: return view.getInt16(at, true);
      case 4: return view.getUint32(at, true);
      case 5: return view.getInt32(at, true);
      case 6: return view.getFloat32(at, true);
      case 7: return view.getUint8(at) !== 0;
      case 10: return u64(at);
      case 11: return view.getUint32(at, true) + view.getInt32(at + 4, true) * 2 ** 32;
      default: return view.getFloat64(at, true);
    }
  };

  for (let i = 0; i < count; i++) {
    const key = readString();
    if (key === null || !fits(4)) break;
    const type = view.getUint32(at, true);
    at += 4;
    if (type === STRING) {
      const value = readString();
      if (value === null) break;
      meta[key] = value;
    } else if (type === ARRAY) {
      if (!fits(12)) break;
      const itemType = view.getUint32(at, true);
      const items = u64(at + 4);
      at += 12;
      if (itemType === STRING) {
        for (let j = 0; j < items && fits(8); j++) at += 8 + u64(at);
      } else if (SIZES[itemType]) {
        at += items * SIZES[itemType];
      } else {
        break; // arrays of arrays: no way to tell where the next key starts
      }
      if (at > bytes.length) break;
    } else if (SIZES[type]) {
      if (!fits(SIZES[type])) break;
      meta[key] = scalar(type);
      at += SIZES[type];
    } else {
      break; // a type this reader doesn't know: same problem
    }
  }
  return meta;
}

/** The facts the engines judge a model by, from its GGUF metadata. */
export function ggufFacts(meta: Record<string, unknown> | null): ModelFacts {
  const text = (key: string) => (typeof meta?.[key] === 'string' ? (meta[key] as string) : null);
  return {
    format: 'gguf',
    architecture: text('general.architecture'),
    type: text('general.type'),
    splitCount: Number(meta?.['split.count'] ?? 0) || null,
  };
}

/** The part of fetch this needs: a request whose body can be read as a stream. */
export type StreamingFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{
  ok: boolean;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}>;

/**
 * The metadata at the start of a remote GGUF file, without downloading the rest. It asks for
 * the first HEADER_BYTES only, and reads the response as a stream that it stops after that
 * many bytes, so a server that ignores the request for part of the file can't send all of it.
 * Null when the file can't be read in time or isn't GGUF.
 */
export async function fetchGgufMetadata(url: string, fetchStream: StreamingFetch, timeoutMs = 15000): Promise<GgufMetadata | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchStream(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` }, signal: controller.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const bytes = new Uint8Array(HEADER_BYTES);
    let length = 0;
    while (length < HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, HEADER_BYTES - length);
      bytes.set(value.subarray(0, take), length);
      length += take;
    }
    reader.cancel().catch(() => {});
    return parseGgufMetadata(bytes.subarray(0, length));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
