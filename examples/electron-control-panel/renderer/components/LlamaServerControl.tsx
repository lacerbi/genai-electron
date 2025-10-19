import React, { useState, useEffect } from 'react';
import Card from './common/Card';
import StatusIndicator from './common/StatusIndicator';
import ActionButton from './common/ActionButton';
import LogViewer from './common/LogViewer';
import ServerConfig from './ServerConfig';
import TestChat from './TestChat';
import { useServerStatus } from './hooks/useServerStatus';
import { useServerLogs } from './hooks/useServerLogs';
import { useModels } from './hooks/useModels';
import './LlamaServerControl.css';

interface ServerConfigForm {
  modelId: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  parallelRequests: number;
  flashAttention: boolean;
}

const LlamaServerControl: React.FC = () => {
  const { status, isHealthy, error: serverError, start, stop, restart } = useServerStatus();
  const { logs, clearLogs } = useServerLogs();
  const { models } = useModels();

  const [autoConfig, setAutoConfig] = useState(true);
  const [config, setConfig] = useState<ServerConfigForm>({
    modelId: '',
    port: 8080,
    contextSize: 4096,
    gpuLayers: 0,
    threads: 4,
    parallelRequests: 4,
    flashAttention: false,
  });

  const [startLoading, setStartLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [restartLoading, setRestartLoading] = useState(false);

  // Set first model as default when models load
  useEffect(() => {
    if (models.length > 0 && !config.modelId) {
      setConfig((prev) => ({ ...prev, modelId: models[0].id }));
    }
  }, [models, config.modelId]);

  const handleStart = async () => {
    if (!config.modelId) {
      alert('Please select a model first');
      return;
    }

    setStartLoading(true);
    try {
      const startConfig = autoConfig ? { modelId: config.modelId, port: config.port } : config;

      await start(startConfig);
    } catch (err) {
      // Error is handled by useServerStatus
    } finally {
      setStartLoading(false);
    }
  };

  const handleStop = async () => {
    setStopLoading(true);
    try {
      await stop();
    } catch (err) {
      // Error is handled by useServerStatus
    } finally {
      setStopLoading(false);
    }
  };

  const handleRestart = async () => {
    setRestartLoading(true);
    try {
      await restart();
    } catch (err) {
      // Error is handled by useServerStatus
    } finally {
      setRestartLoading(false);
    }
  };

  const isRunning = status.status === 'running';

  return (
    <div className="llama-server-control">
      {/* Error Display */}
      {serverError && (
        <div className="error-banner">
          <strong>Error:</strong> {serverError}
        </div>
      )}

      {/* Server Status */}
      <Card title="Server Status">
        <div className="status-display">
          <StatusIndicator
            status={status.status === 'running' ? 'running' : 'stopped'}
            label={status.status.charAt(0).toUpperCase() + status.status.slice(1)}
          />

          {isRunning && (
            <div className="server-details">
              <div className="detail-row">
                <span className="detail-label">Model:</span>
                <span className="detail-value">{status.modelId}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Port:</span>
                <span className="detail-value">{status.port}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">PID:</span>
                <span className="detail-value">{status.pid}</span>
              </div>
              <div className="detail-row">
                <StatusIndicator
                  status={isHealthy ? 'healthy' : 'unhealthy'}
                  label={isHealthy ? 'Healthy' : 'Unhealthy'}
                />
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Configuration */}
      <Card title="Configuration">
        <ServerConfig
          models={models}
          config={config}
          onChange={setConfig}
          autoConfig={autoConfig}
          onAutoConfigChange={setAutoConfig}
        />

        <div className="server-actions">
          <ActionButton
            variant="primary"
            onClick={handleStart}
            disabled={isRunning}
            loading={startLoading}
          >
            Start Server
          </ActionButton>
          <ActionButton
            variant="danger"
            onClick={handleStop}
            disabled={!isRunning}
            loading={stopLoading}
          >
            Stop Server
          </ActionButton>
          <ActionButton
            variant="secondary"
            onClick={handleRestart}
            disabled={!isRunning}
            loading={restartLoading}
          >
            Restart
          </ActionButton>
        </div>
      </Card>

      {/* Test Chat */}
      <Card title="Test Chat">
        <p className="test-chat-description">
          Send a test message to verify the server is working correctly. This is a simple
          single-message test interface.
        </p>
        <TestChat serverRunning={isRunning} port={status.port} />
      </Card>

      {/* Server Logs */}
      <Card title="Server Logs">
        <LogViewer logs={logs} autoScroll={true} onClear={clearLogs} height="300px" />
      </Card>
    </div>
  );
};

export default LlamaServerControl;
