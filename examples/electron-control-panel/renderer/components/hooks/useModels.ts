import { useState, useEffect, useCallback } from 'react';
import type { ModelInfo, DownloadConfig } from '../../types/api';

/**
 * Hook for model listing and operations (download invoke, delete, verify).
 *
 * Download progress IPC listeners are NOT registered here — they live in
 * ModelManager.tsx as a single registration to avoid the preload
 * removeAllListeners collision when two useModels hooks (llm + diffusion)
 * both try to register for the same IPC channels.
 */
export function useModels(type: 'llm' | 'diffusion' = 'llm') {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    if (!window.api || !window.api.models) {
      console.error('window.api not available');
      setError('Models API not available');
      setLoading(false);
      return;
    }

    try {
      const data = await window.api.models.list(type);
      setModels(data as ModelInfo[]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [type]);

  // Fetch models on mount
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleDownload = async (config: DownloadConfig) => {
    await window.api.models.download(config);
  };

  const handleDelete = async (modelId: string): Promise<boolean> => {
    const confirmed = confirm(`Are you sure you want to delete this model? This cannot be undone.`);
    if (!confirmed) return false;

    try {
      await window.api.models.delete(modelId);
      await fetchModels();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const handleVerify = async (modelId: string): Promise<boolean> => {
    try {
      const isValid = await window.api.models.verify(modelId);
      if (!isValid) {
        setError(`Model ${modelId} failed verification`);
      }
      return isValid;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  return {
    models,
    loading,
    error,
    handleDownload,
    handleDelete,
    handleVerify,
    refresh: fetchModels,
  };
}
