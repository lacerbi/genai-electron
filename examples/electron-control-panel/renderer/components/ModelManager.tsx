import React from 'react';
import Card from './common/Card';
import Spinner from './common/Spinner';
import ModelList from './ModelList';
import ModelDownloadForm from './ModelDownloadForm';
import { useModels } from './hooks/useModels';
import type { DownloadConfig } from '../types/api';
import './ModelManager.css';

const ModelManager: React.FC = () => {
  // Fetch both LLM and Diffusion models
  const llmHook = useModels('llm');
  const diffusionHook = useModels('diffusion');

  // Merge both model lists
  const allModels = [...llmHook.models, ...diffusionHook.models];
  const loading = llmHook.loading || diffusionHook.loading;
  const downloading = llmHook.downloading || diffusionHook.downloading;
  const downloadProgress = llmHook.downloadProgress || diffusionHook.downloadProgress;
  const componentProgress = llmHook.componentProgress || diffusionHook.componentProgress;
  const error = llmHook.error || diffusionHook.error;

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  // Calculate total disk usage across both types
  const totalSize = allModels.reduce((sum, model) => sum + model.size, 0);

  // Unified handlers that work for both types
  const handleDownload = async (config: DownloadConfig) => {
    if (config.type === 'llm') {
      await llmHook.handleDownload(config);
    } else {
      await diffusionHook.handleDownload(config);
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
