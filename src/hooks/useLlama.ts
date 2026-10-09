import { useState, useCallback, useRef } from 'react';
import { initLlama, LlamaContext } from 'llama.rn';

export function useLlama() {
  const [isInitializing, setIsInitializing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
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
      }

      const ctx = await initLlama({
        model: modelPath,
        n_ctx: 2048, // Standard context size for mobile
        n_gpu_layers: 99, // Force hardware acceleration
      });
      
      contextRef.current = ctx;
    } catch (err: any) {
      setError(err.message || 'Failed to load model');
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
      setError(err.message || 'Failed to generate response');
    } finally {
      setIsGenerating(false);
    }
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
    loadModel,
    generate,
    releaseModel
  };
}
