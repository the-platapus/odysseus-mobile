import { useState, useCallback, useRef } from 'react';
import { initLlama, LlamaContext, JinjaFormattedChatResult } from 'llama.rn';
import type { CompletionRequest, CompletionResponse } from '../mcp/agentLoop';
import { beginModelLoad, beginReply, endModelLoad, endReply, noteReplyToken } from '../diagnostics/loadDiagnostics';

// Raised from 2048 for agent mode: tool schemas, the agent prompt and tool results all share
// the window. KV cache memory grows with it (roughly +130 MB for a 1B model, more for larger).
const N_CTX = 4096;
/** Context settings every model loads with; also included in load failure reports. */
export const LOAD_SETTINGS = {
  n_ctx: N_CTX,
  n_gpu_layers: 99, // Force hardware acceleration
};
// No cap on reply or thinking length: a reply ends when the model finishes, at a stop string,
// or when the context window is full (context shift is off, so it can't run on forever).
// ■ stops it sooner.
const N_PREDICT = -1;

/**
 * How the loaded model can call tools:
 *  - 'native':  its chat template has tool support, llama.cpp parses the model's own format;
 *  - 'generic': it has a Jinja template without tools; llama.cpp falls back to a JSON format
 *               constrained by grammar (works, but small models do it less reliably);
 *  - 'none':    no usable chat template, so no agent mode.
 */
export type ToolSupport = 'native' | 'generic' | 'none';

const detectToolSupport = (ctx: LlamaContext): ToolSupport => {
  const jinja = ctx.model?.chatTemplates?.jinja;
  if (jinja?.toolUse || jinja?.defaultCaps?.tools) return 'native';
  return ctx.isJinjaSupported() ? 'generic' : 'none';
};

/**
 * A model can think when llama.cpp recognises a reasoning block in its chat template (Qwen3,
 * DeepSeek-R1, gpt-oss, Gemma 4, ...); the template then reports its thinking tags. Reading
 * the template beats Odysseus' model-name patterns, which a phone can't rely on for GGUF names.
 */
const detectThinkingSupport = async (ctx: LlamaContext): Promise<boolean> => {
  if (!ctx.isJinjaSupported()) return false;
  try {
    const formatted = (await ctx.getFormattedChat([{ role: 'user', content: 'Hi' }], null, {
      jinja: true,
      enable_thinking: true,
    })) as JinjaFormattedChatResult;
    return !!formatted.thinking_end_tag;
  } catch {
    return false;
  }
};

export type ChatOptions = {
  /** Let the model think before answering (only for models that support it). */
  thinking?: boolean;
  /** The persona's sampling temperature; llama.rn's default when unset. */
  temperature?: number;
};

export function useLlama() {
  const [isInitializing, setIsInitializing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolSupport, setToolSupport] = useState<ToolSupport>('none');
  const [supportsThinking, setSupportsThinking] = useState(false);
  // The model file in RAM right now, or null when none is loaded.
  const [loadedModelPath, setLoadedModelPath] = useState<string | null>(null);

  // Keep track of the active context
  const contextRef = useRef<LlamaContext | null>(null);
  // Its model file, for reports when the app closes mid-reply.
  const modelPathRef = useRef('');

  /**
   * Initializes the LLM with a local model file
   * @param modelPath The local filesystem path to the .gguf model
   * @returns null once loaded, or the error and llama.cpp's log if it failed
   */
  const loadModel = useCallback(async (modelPath: string): Promise<{ message: string; log: string[] } | null> => {
    try {
      setIsInitializing(true);
      setError(null);

      // Release any existing context before loading a new one
      if (contextRef.current) {
        await contextRef.current.release();
        contextRef.current = null;
        setLoadedModelPath(null);
        setToolSupport('none');
        setSupportsThinking(false);
      }

      // llama.cpp's log says why a load failed; the JS error only says that it did.
      await beginModelLoad(modelPath);
      let ctx: LlamaContext;
      try {
        ctx = await initLlama({ model: modelPath, ...LOAD_SETTINGS });
      } catch (err: any) {
        const log = await endModelLoad();
        const msg = err.message || 'Failed to load model';
        console.log(`App Alert: Failed to load model: ${msg}`);
        setError(msg);
        return { message: msg, log };
      }
      await endModelLoad();

      contextRef.current = ctx;
      modelPathRef.current = modelPath;
      setLoadedModelPath(modelPath);
      setToolSupport(detectToolSupport(ctx));
      setSupportsThinking(await detectThinkingSupport(ctx));
      return null;
    } catch (err: any) {
      const msg = err.message || 'Failed to load model';
      console.log(`App Alert: Failed to load model: ${msg}`);
      setError(msg);
      return { message: msg, log: [] };
    } finally {
      setIsInitializing(false);
    }
  }, []);

  /**
   * Generates a completion for the given prompt
   */
  const generate = useCallback(async (
    prompt: string,
    onToken?: (token: string) => void,
    { temperature }: Omit<ChatOptions, 'thinking'> = {}
  ) => {
    if (!contextRef.current) {
      setError('Model not loaded');
      return;
    }

    try {
      setIsGenerating(true);
      setError(null);
      // Saved while the reply runs, so the next launch can tell if the app was killed mid-reply.
      await beginReply(modelPathRef.current, { mode: 'plain', thinking: false, promptChars: prompt.length }).catch(() => {});

      const result = await contextRef.current.completion(
        {
          prompt,
          n_predict: N_PREDICT,
          ...(temperature !== undefined ? { temperature } : {}),
          stop: ['User:', '\n\n'], // Simple stop tokens
        },
        (tokenData) => {
          noteReplyToken();
          if (onToken) {
            onToken(tokenData.token);
          }
        }
      );

      return result.text;
    } catch (err: any) {
      const msg = err.message || 'Failed to generate response';
      console.log(`App Alert: Failed to generate response: ${msg}`);
      alert(`Failed to generate response: ${msg}`);
      setError(msg);
    } finally {
      await endReply().catch(() => {});
      setIsGenerating(false);
    }
  }, []);

  /**
   * One round through the model's own chat template (Jinja), optionally with tool schemas;
   * llama.cpp parses tool calls and thinking out of the output. Used by agent mode and by
   * chat with thinking on. Errors are thrown to the caller.
   */
  const chat = useCallback(async (
    { messages, tools, onContent, onReasoning }: CompletionRequest,
    { thinking = false, temperature }: ChatOptions = {}
  ): Promise<CompletionResponse> => {
    const ctx = contextRef.current;
    if (!ctx) throw new Error('Model not loaded');
    setIsGenerating(true);
    const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    await beginReply(modelPathRef.current, { mode: tools ? 'agent' : 'template', thinking, promptChars }).catch(() => {});
    try {
      const result = await ctx.completion(
        {
          messages,
          jinja: true,
          ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
          // The app's think switch (on by default). 'auto' keeps any reasoning out of `content`
          // either way.
          enable_thinking: thinking,
          reasoning_format: 'auto',
          n_predict: N_PREDICT,
          ...(temperature !== undefined ? { temperature } : {}),
        },
        // Both fields are the parsed text so far, with tool-call and thinking markup removed.
        (data) => {
          noteReplyToken();
          if (data.reasoning_content !== undefined) onReasoning?.(data.reasoning_content);
          if (data.content !== undefined) onContent(data.content);
        }
      );
      return {
        content: result.content ?? result.text ?? '',
        reasoning: result.reasoning_content ?? '',
        toolCalls: result.tool_calls ?? [],
        interrupted: result.interrupted,
      };
    } finally {
      await endReply().catch(() => {});
      setIsGenerating(false);
    }
  }, []);

  /** Stop the running completion, if any. */
  const stop = useCallback(async () => {
    await contextRef.current?.stopCompletion();
  }, []);

  /**
   * Always call this when unmounting to free up device RAM
   */
  const releaseModel = useCallback(async () => {
    if (contextRef.current) {
      await contextRef.current.release();
      contextRef.current = null;
    }
    // State, not just the ref, so whoever shows the model re-renders.
    setLoadedModelPath(null);
    setToolSupport('none');
    setSupportsThinking(false);
  }, []);

  return {
    // Set and cleared together with contextRef, but as state, so it's current while rendering.
    isReady: loadedModelPath !== null,
    loadedModelPath,
    isInitializing,
    isGenerating,
    error,
    toolSupport,
    supportsThinking,
    loadModel,
    generate,
    chat,
    stop,
    releaseModel
  };
}
