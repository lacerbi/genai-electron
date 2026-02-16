import React, { useState, useEffect } from 'react';
import Card from './common/Card';
import Spinner from './common/Spinner';
import ModelList from './ModelList';
import ModelDownloadForm from './ModelDownloadForm';
import { useModels } from './hooks/useModels';
import type { DownloadConfig } from '../types/api';
import type { DownloadProgress, ComponentProgress } from '../types/ui';
import './ModelManager.css';

const ModelManager: React.FC = () => {
  // Fetch both LLM and Diffusion models
  const llmHook = useModels('llm');
  const diffusionHook = useModels('diffusion');

  // Download state — centralized here (not in individual hooks) to avoid
  // the preload removeAllListeners collision when two hooks register for
  // the same IPC channels.
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [componentProgress, setComponentProgress] = useState<ComponentProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Single IPC listener registration for download progress events
  useEffect(() => {
    if (!window.api || !window.api.on) return;

    window.api.on('download:progress', (progress: DownloadProgress) => {
      setDownloadProgress(progress);
    });

    window.api.on('download:component-start', (data: ComponentProgress) => {
      setComponentProgress(data);
    });

    return () => {
      if (window.api && window.api.off) {
        window.api.off('download:progress');
        window.api.off('download:component-start');
      }
    };
  }, []);

  // Merge both model lists
  const allModels = [...llmHook.models, ...diffusionHook.models];
  const loading = llmHook.loading || diffusionHook.loading;
  const error = llmHook.error || diffusionHook.error || downloadError;

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  // Calculate total disk usage across both types
  const totalSize = allModels.reduce((sum, model) => sum + model.size, 0);

  // Unified download handler — manages state and dispatches to the right hook
  const handleDownload = async (config: DownloadConfig) => {
    setDownloading(true);
    setDownloadError(null);
    setDownloadProgress({
      downloaded: 0,
      total: 0,
      percentage: 0,
      modelName: config.name,
    });
    setComponentProgress(null);

    try {
      const hook = config.type === 'llm' ? llmHook : diffusionHook;
      await hook.handleDownload(config);
    } catch (err) {
      setDownloadError(`Download failed: ${(err as Error).message}`);
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
      setComponentProgress(null);
      // Refresh model lists after download completes or fails
      llmHook.refresh();
      diffusionHook.refresh();
    }
  };

  const handleDelete = async (modelId: string): Promise<boolean> => {
    // Try to delete from both hooks (one will succeed, one will fail silently)
    const llmResult = await llmHook.handleDelete(modelId);
    const diffusionResult = await diffusionHook.handleDelete(modelId);
    return llmResult || diffusionResult;
  };

  const handleVerify = async (modelId: string): Promise<boolean> => {
    // Try to verify from both hooks (one will succeed)
    const llmResult = await llmHook.handleVerify(modelId);
    const diffusionResult = await diffusionHook.handleVerify(modelId);
    return llmResult || diffusionResult;
  };

  if (loading) {
    return (
      <div className="model-manager-loading">
        <Spinner size="large" />
        <p>Loading models...</p>
      </div>
    );
  }

  return (
    <div className="model-manager">
      {/* Error Display */}
      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Installed Models */}
      <Card title="Installed Models">
        {allModels.length === 0 ? (
          <div className="empty-state">
            <p>No models installed yet.</p>
            <p className="empty-state-hint">Download a model below to get started.</p>
          </div>
        ) : (
          <>
            <ModelList models={allModels} onDelete={handleDelete} onVerify={handleVerify} />
            <div className="disk-usage">
              <span className="disk-usage-label">Total disk usage:</span>
              <span className="disk-usage-value">{formatBytes(totalSize)}</span>
              <span className="disk-usage-count">
                ({allModels.length} model{allModels.length !== 1 ? 's' : ''})
              </span>
            </div>
          </>
        )}
      </Card>

      {/* Download Model */}
      <Card title="Download Model">
        <ModelDownloadForm
          onDownload={handleDownload}
          downloading={downloading}
          progress={downloadProgress}
          componentProgress={componentProgress}
        />
      </Card>
    </div>
  );
};

export default ModelManager;
