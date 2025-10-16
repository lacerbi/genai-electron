import React from 'react';
import Card from './common/Card';
import StatusIndicator from './common/StatusIndicator';
import ProgressBar from './common/ProgressBar';
import ActionButton from './common/ActionButton';
import Spinner from './common/Spinner';
import { useSystemInfo } from './hooks/useSystemInfo';
import './SystemInfo.css';

const SystemInfo: React.FC = () => {
  const { capabilities, loading, error, refresh } = useSystemInfo();

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  if (loading) {
    return (
      <div className="system-info-loading">
        <Spinner size="large" />
        <p>Detecting system capabilities...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Card title="System Info">
        <div className="error-message">
          <p>Failed to detect system capabilities:</p>
          <code>{error}</code>
          <ActionButton variant="primary" onClick={refresh}>
            Retry
          </ActionButton>
        </div>
      </Card>
    );
  }

  if (!capabilities) {
    return (
      <Card title="System Info">
        <p>No system information available.</p>
      </Card>
    );
  }

  return (
    <div className="system-info">
      {/* Hardware Capabilities */}
      <Card title="System Capabilities">
        <div className="capabilities-grid">
          {/* CPU Info */}
          <div className="capability-item">
            <StatusIndicator status="healthy" label="CPU" />
            <div className="capability-details">
              <p>
                <strong>{capabilities.cpu.cores} cores</strong> ({capabilities.cpu.arch})
              </p>
              <p className="capability-subtitle">{capabilities.cpu.model}</p>
            </div>
          </div>

          {/* RAM Info */}
          <div className="capability-item">
            <StatusIndicator status="healthy" label="RAM" />
            <div className="capability-details">
              <p>
                <strong>Total:</strong> {formatBytes(capabilities.memory.total)}
              </p>
              <ProgressBar
                current={capabilities.memory.total - capabilities.memory.available}
                total={capabilities.memory.total}
                label={`Available: ${formatBytes(capabilities.memory.available)}`}
                showPercentage={false}
              />
            </div>
          </div>

          {/* GPU Info */}
          <div className="capability-item">
            <StatusIndicator
              status={capabilities.gpu.available ? 'healthy' : 'stopped'}
              label="GPU"
            />
            <div className="capability-details">
              {capabilities.gpu.available ? (
                <>
                  <p>
                    <strong>{capabilities.gpu.type?.toUpperCase()}</strong>
                  </p>
                  <p className="capability-subtitle">{capabilities.gpu.name}</p>
                  {capabilities.gpu.vram && (
                    <ProgressBar
                      current={
                        capabilities.gpu.vram - (capabilities.gpu.vramAvailable || 0)
                      }
                      total={capabilities.gpu.vram}
                      label={`VRAM: ${formatBytes(capabilities.gpu.vramAvailable || 0)} available`}
                      showPercentage={false}
                    />
                  )}
                </>
              ) : (
                <p className="capability-subtitle">No GPU detected</p>
              )}
            </div>
          </div>
        </div>

        <div className="refresh-button">
          <ActionButton variant="secondary" onClick={refresh}>
            Refresh
          </ActionButton>
        </div>
      </Card>

      {/* Recommendations */}
      <Card title="Recommendations">
        <div className="recommendations">
          <div className="recommendation-item">
            <h4>Maximum Model Size</h4>
            <p className="recommendation-value">
              {capabilities.recommendations.maxModelSize}
            </p>
            <p className="recommendation-description">
              Based on available system memory
            </p>
          </div>

          <div className="recommendation-item">
            <h4>Optimal GPU Layers</h4>
            <p className="recommendation-value">
              {capabilities.gpu.available
                ? `${capabilities.recommendations.maxGpuLayers} layers`
                : 'N/A (CPU-only)'}
            </p>
            <p className="recommendation-description">
              {capabilities.gpu.available
                ? 'Maximum layers that can be offloaded to GPU'
                : 'No GPU acceleration available'}
            </p>
          </div>

          <div className="recommendation-item recommendation-models">
            <h4>Suggested Models</h4>
            <ul className="model-suggestions">
              {capabilities.recommendations.recommendedModels?.map((model, index) => (
                <li key={index} className="model-suggestion">
                  <span className={model.supported ? 'model-supported' : 'model-marginal'}>
                    {model.supported ? '✓' : '⚠'}
                  </span>
                  <span className="model-name">
                    {model.name} ({model.size})
                  </span>
                  <span className="model-status">
                    {model.supported ? 'Supported' : 'Marginal'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default SystemInfo;
