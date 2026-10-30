import { useState, useCallback, useRef } from 'react';
import { initLlama, LlamaContext } from 'llama.rn';
import type { CompletionRequest, CompletionResponse } from '../mcp/agentLoop';

// Raised from 2048 for agent mode: tool schemas, the agent prompt and tool results all share
// the window. KV cache memory grows with it (roughly +130 MB for a 1B model, more for larger).
const N_CTX = 4096;
const AGENT_N_PREDICT = 1024;

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

export function useLlama() {
  const [isInitializing, setIsInitializing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolSupport, setToolSupport] = useState<ToolSupport>('none');

  // Keep track of the active context
  const contextRef = useRef<LlamaContext | null>(null);

  /**
   * Initializes the LLM with a local model file
   * @param modelPath The local filesystem path to the .gguf model
   */
  const loadModel = useCallback(async (modelPath: string) => {
    try {
      setIsInitializing(true);
      setError(null);

      // Release any existing context before loading a new one
      if (contextRef.current) {
        await contextRef.current.release();
        contextRef.current = null;
        setToolSupport('none');
      }

      const ctx = await initLlama({
        model: modelPath,
        n_ctx: N_CTX,
        n_gpu_layers: 99, // Force hardware acceleration
      });

      contextRef.current = ctx;
      setToolSupport(detectToolSupport(ctx));
    } catch (err: any) {
      const msg = err.message || 'Failed to load model';
      console.log(`App Alert: Failed to load model: ${msg}`);
      alert(`Failed to load model: ${msg}`);
      setError(msg);
    } finally {
      setIsInitializing(false);
    }
  }, []);

  /**
   * Generates a completion for the given prompt
   */
  const generate = useCallback(async (
    prompt: string,
    onToken?: (token: string) => void
  ) => {
    if (!contextRef.current) {
      setError('Model not loaded');
      return;
    }

    try {
      setIsGenerating(true);
      setError(null);

      const result = await contextRef.current.completion(
        {
          prompt,
          n_predict: 256, // Cap the response length to save battery/RAM
          stop: ['User:', '\n\n'], // Simple stop tokens
        },
        (tokenData) => {
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
      setIsGenerating(false);
    }
  }, []);

  /**
   * One agent round: the conversation goes through the model's own chat template (Jinja) with
   * the tool schemas, and llama.cpp parses any tool calls out of the output. Matches the
   * agent loop's CompleteFn. Errors are thrown to the caller.
   */
  const chat = useCallback(async ({ messages, tools, onContent }: CompletionRequest): Promise<CompletionResponse> => {
    const ctx = contextRef.current;
    if (!ctx) throw new Error('Model not loaded');
    setIsGenerating(true);
    try {
      const result = await ctx.completion(
        {
          messages,
          jinja: true,
          ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
          // Thinking models (Qwen3, ...) would spend most of a phone's token budget reasoning
          // before the first tool call; 'auto' still keeps any reasoning out of `content`.
          enable_thinking: false,
          reasoning_format: 'auto',
          n_predict: AGENT_N_PREDICT,
        },
        // `content` is the parsed reply so far, with tool-call markup already removed.
        (data) => {
          if (data.content !== undefined) onContent(data.content);
        }
      );
      return {
        content: result.content ?? result.text ?? '',
        toolCalls: result.tool_calls ?? [],
        interrupted: result.interrupted,
      };
    } finally {
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
  }, []);

  return {
    isReady: !!contextRef.current,
    isInitializing,
    isGenerating,
    error,
    toolSupport,
    loadModel,
    generate,
    chat,
    stop,
    releaseModel
  };
}
