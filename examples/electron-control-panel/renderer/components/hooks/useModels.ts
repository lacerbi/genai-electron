import { useState, useEffect, useCallback } from 'react';

interface ModelInfo {
  id: string;
  name: string;
  type: 'llm' | 'diffusion';
  size: number;
  downloadedAt: string;
  source?: {
    type: string;
    repo?: string;
    file?: string;
    url?: string;
  };
}

interface DownloadConfig {
  source: 'url' | 'huggingface';
  url?: string;
  repo?: string;
  file?: string;
  name: string;
  type: 'llm' | 'diffusion';
  checksum?: string;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  modelName: string;
}

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    try {
      const data = await window.api.models.list('llm');
      setModels(data as ModelInfo[]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch models on mount
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Listen to download progress events
  useEffect(() => {
    // Safety check: ensure window.api exists
    if (!window.api || !window.api.on) {
      console.error('window.api not available');
      return;
    }

    window.api.on('download:progress', (progress: DownloadProgress) => {
      setDownloadProgress(progress);
    });

    window.api.on('download:complete', () => {
      setDownloading(false);
      setDownloadProgress(null);
      fetchModels(); // Refresh model list
    });

    window.api.on('download:error', (errorData: { message: string; modelName: string }) => {
      setDownloading(false);
      setDownloadProgress(null);
      setError(`Download failed for ${errorData.modelName}: ${errorData.message}`);
    });

    return () => {
      if (window.api && window.api.off) {
        window.api.off('download:progress');
        window.api.off('download:complete');
        window.api.off('download:error');
      }
    };
  }, [fetchModels]);

  const handleDownload = async (config: DownloadConfig) => {
    setDownloading(true);
    setError(null);
    setDownloadProgress({
      downloaded: 0,
      total: 0,
      percentage: 0,
      modelName: config.name,
    });

    try {
      await window.api.models.download(config);
    } catch (err) {
      setDownloading(false);
      setDownloadProgress(null);
      setError((err as Error).message);
    }
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
    downloading,
    downloadProgress,
    error,
    handleDownload,
    handleDelete,
    handleVerify,
    refresh: fetchModels,
  };
}
