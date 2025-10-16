import React from 'react';
import Card from './common/Card';
import Spinner from './common/Spinner';
import ModelList from './ModelList';
import ModelDownloadForm from './ModelDownloadForm';
import { useModels } from './hooks/useModels';
import './ModelManager.css';

const ModelManager: React.FC = () => {
  const {
    models,
    loading,
    downloading,
    downloadProgress,
    error,
    handleDownload,
    handleDelete,
    handleVerify,
  } = useModels();

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  // Calculate total disk usage
  const totalSize = models.reduce((sum, model) => sum + model.size, 0);

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
      <Card title="Installed Models (LLM)">
        {models.length === 0 ? (
          <div className="empty-state">
            <p>No models installed yet.</p>
            <p className="empty-state-hint">Download a model below to get started.</p>
          </div>
        ) : (
          <>
            <ModelList
              models={models}
              onDelete={handleDelete}
              onVerify={handleVerify}
            />
            <div className="disk-usage">
              <span className="disk-usage-label">Total disk usage:</span>
              <span className="disk-usage-value">{formatBytes(totalSize)}</span>
              <span className="disk-usage-count">({models.length} model{models.length !== 1 ? 's' : ''})</span>
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
        />
      </Card>
    </div>
  );
};

export default ModelManager;
