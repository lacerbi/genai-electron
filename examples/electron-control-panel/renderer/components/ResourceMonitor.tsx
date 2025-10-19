import React from 'react';
import Card from './common/Card';
import StatusIndicator from './common/StatusIndicator';
import ProgressBar from './common/ProgressBar';
import ActionButton from './common/ActionButton';
import { useResourceMonitor } from './hooks/useResourceMonitor';
import './ResourceMonitor.css';

const ResourceMonitor: React.FC = () => {
  const { usage, savedState, wouldOffload, capabilities, error, events, clearEvents } =
    useResourceMonitor();

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  return (
    <div className="resource-monitor">
      <h2>Resource Monitor</h2>

      {/* Error Display */}
      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* System Memory Usage */}
      <Card title="System Memory Usage">
        {usage ? (
          <>
            <div className="memory-stats">
              <div className="stat-item">
                <label>Total:</label>
                <span>{formatBytes(usage.memory.total)}</span>
              </div>
              <div className="stat-item">
                <label>Used:</label>
                <span>{formatBytes(usage.memory.total - usage.memory.available)}</span>
              </div>
              <div className="stat-item">
                <label>Available:</label>
                <span>{formatBytes(usage.memory.available)}</span>
              </div>
            </div>
            <ProgressBar
              current={usage.memory.total - usage.memory.available}
              total={usage.memory.total}
              showPercentage={true}
            />
          </>
        ) : (
          <p className="info-message">Loading memory information...</p>
        )}
      </Card>

      {/* GPU Memory Usage (if GPU available) */}
      {capabilities?.gpu.available && capabilities.gpu.vram && (
        <Card title="GPU Memory (VRAM) Usage">
          <div className="gpu-info">
            <div className="gpu-header">
              <h3>{capabilities.gpu.name || 'GPU'}</h3>
              <span className="gpu-type">{capabilities.gpu.type}</span>
            </div>

            <div className="memory-stats">
              <div className="stat-item">
                <label>Total VRAM:</label>
                <span>{formatBytes(capabilities.gpu.vram)}</span>
              </div>
              {capabilities.gpu.vramAvailable !== undefined && (
                <>
                  <div className="stat-item">
                    <label>Used:</label>
                    <span>
                      {formatBytes(capabilities.gpu.vram - capabilities.gpu.vramAvailable)}
                    </span>
                  </div>
                  <div className="stat-item">
                    <label>Available:</label>
                    <span>{formatBytes(capabilities.gpu.vramAvailable)}</span>
                  </div>
                </>
              )}
            </div>

            {capabilities.gpu.vramAvailable !== undefined && (
              <ProgressBar
                current={capabilities.gpu.vram - capabilities.gpu.vramAvailable}
                total={capabilities.gpu.vram}
                showPercentage={true}
              />
            )}

            {capabilities.gpu.vramAvailable === undefined && (
              <p className="info-message">
                VRAM usage tracking not available for this GPU. Total VRAM:{' '}
                {formatBytes(capabilities.gpu.vram)}
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Server Status Grid */}
      <Card title="Server Status">
        {usage ? (
          <div className="server-status-grid">
            {/* LLM Server */}
            <div className="server-card">
              <h3>LLM Server</h3>
              <div className="server-details">
                <div className="detail-item">
                  <label>Status:</label>
                  <StatusIndicator
                    status={usage.llamaServer.status === 'running' ? 'running' : 'stopped'}
                    label={usage.llamaServer.status}
                  />
                </div>
                {usage.llamaServer.pid && (
                  <div className="detail-item">
                    <label>PID:</label>
                    <span>{usage.llamaServer.pid}</span>
                  </div>
                )}
                <div className="detail-item">
                  <label>Port:</label>
                  <span>{usage.llamaServer.port}</span>
                </div>
              </div>
            </div>

            {/* Diffusion Server */}
            <div className="server-card">
              <h3>Diffusion Server</h3>
              <div className="server-details">
                <div className="detail-item">
                  <label>Status:</label>
                  <StatusIndicator
                    status={usage.diffusionServer.status === 'running' ? 'running' : 'stopped'}
                    label={usage.diffusionServer.status}
                  />
                </div>
                {usage.diffusionServer.pid && (
                  <div className="detail-item">
                    <label>PID:</label>
                    <span>{usage.diffusionServer.pid}</span>
                  </div>
                )}
                <div className="detail-item">
                  <label>Port:</label>
                  <span>{usage.diffusionServer.port}</span>
                </div>
                {usage.diffusionServer.busy && (
                  <div className="detail-item">
                    <label>Status:</label>
                    <span className="busy-badge">⚙️ Busy</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="info-message">Loading server status...</p>
        )}
      </Card>

      {/* Resource Orchestration Status */}
      <Card title="Resource Orchestration">
        <div className="orchestration-status">
          <div className="status-item">
            <label>Offload Required:</label>
            {wouldOffload ? (
              <span className="warning-badge">⚠️ Yes - VRAM constrained</span>
            ) : (
              <span className="success-badge">✓ No - Sufficient VRAM</span>
            )}
          </div>

          {savedState && (
            <div className="saved-state-info">
              <h4>Saved LLM State</h4>
              <p>
                <strong>Model ID:</strong> {savedState.config.modelId}
              </p>
              <p>
                <strong>Was Running:</strong> {savedState.wasRunning ? 'Yes' : 'No'}
              </p>
              <p>
                <strong>Saved At:</strong> {new Date(savedState.savedAt).toLocaleString()}
              </p>
            </div>
          )}

          {!savedState && !wouldOffload && (
            <p className="info-message">
              No offload required. Both servers can run simultaneously with available VRAM.
            </p>
          )}

          {!savedState && wouldOffload && (
            <p className="warning-message">
              VRAM constrained. LLM server will be automatically offloaded when generating images.
            </p>
          )}
        </div>
      </Card>

      {/* Event Log */}
      <Card title="Event Log">
        <div className="event-log-header">
          <p className="event-count">Showing last {events.length} events</p>
          <ActionButton onClick={clearEvents} variant="secondary" disabled={events.length === 0}>
            Clear Events
          </ActionButton>
        </div>

        {events.length === 0 ? (
          <p className="info-message">
            No events yet. Events will appear when servers start or stop.
          </p>
        ) : (
          <div className="event-log">
            {events.map((event, index) => (
              <div key={index} className={`event-entry event-${event.type}`}>
                <span className="event-time">{event.time}</span>
                <span className="event-message">{event.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default ResourceMonitor;
