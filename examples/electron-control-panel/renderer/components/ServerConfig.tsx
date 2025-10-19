import React from 'react';
import './ServerConfig.css';

interface ModelInfo {
  id: string;
  name: string;
}

interface ServerConfigForm {
  modelId: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  parallelRequests: number;
  flashAttention: boolean;
}

interface ServerConfigProps {
  models: ModelInfo[];
  config: ServerConfigForm;
  onChange: (config: ServerConfigForm) => void;
  autoConfig: boolean;
  onAutoConfigChange: (auto: boolean) => void;
}

const ServerConfig: React.FC<ServerConfigProps> = ({
  models,
  config,
  onChange,
  autoConfig,
  onAutoConfigChange,
}) => {
  const handleChange = (field: keyof ServerConfigForm, value: string | number | boolean) => {
    onChange({ ...config, [field]: value });
  };

  return (
    <div className="server-config">
      {/* Model Selection */}
      <div className="config-group">
        <label htmlFor="modelId">Model</label>
        <select
          id="modelId"
          value={config.modelId}
          onChange={(e) => handleChange('modelId', e.target.value)}
        >
          <option value="">-- Select a model --</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </div>

      {/* Port */}
      <div className="config-group">
        <label htmlFor="port">Port</label>
        <input
          type="number"
          id="port"
          value={config.port}
          onChange={(e) => handleChange('port', parseInt(e.target.value, 10))}
          min={1024}
          max={65535}
        />
      </div>

      {/* Auto-configure Toggle */}
      <div className="config-group config-checkbox">
        <input
          type="checkbox"
          id="autoConfig"
          checked={autoConfig}
          onChange={(e) => onAutoConfigChange(e.target.checked)}
        />
        <label htmlFor="autoConfig">
          Auto-configure (recommended)
          <span className="config-hint">
            Automatically set optimal settings based on your system
          </span>
        </label>
      </div>

      {/* Manual Configuration Fields */}
      <div className={`manual-config ${autoConfig ? 'disabled' : ''}`}>
        <div className="config-group">
          <label htmlFor="contextSize">
            Context Size
            <span className="config-hint">Maximum number of tokens in context window</span>
          </label>
          <input
            type="number"
            id="contextSize"
            value={config.contextSize}
            onChange={(e) => handleChange('contextSize', parseInt(e.target.value, 10))}
            disabled={autoConfig}
            min={512}
            max={32768}
            step={512}
          />
        </div>

        <div className="config-group">
          <label htmlFor="gpuLayers">
            GPU Layers
            <span className="config-hint">
              Number of model layers to offload to GPU (0 = CPU only)
            </span>
          </label>
          <input
            type="number"
            id="gpuLayers"
            value={config.gpuLayers}
            onChange={(e) => handleChange('gpuLayers', parseInt(e.target.value, 10))}
            disabled={autoConfig}
            min={0}
            max={99}
          />
        </div>

        <div className="config-group">
          <label htmlFor="threads">
            Thread Count
            <span className="config-hint">Number of CPU threads to use</span>
          </label>
          <input
            type="number"
            id="threads"
            value={config.threads}
            onChange={(e) => handleChange('threads', parseInt(e.target.value, 10))}
            disabled={autoConfig}
            min={1}
            max={64}
          />
        </div>

        <div className="config-group">
          <label htmlFor="parallelRequests">
            Parallel Slots
            <span className="config-hint">Number of concurrent requests</span>
          </label>
          <input
            type="number"
            id="parallelRequests"
            value={config.parallelRequests}
            onChange={(e) => handleChange('parallelRequests', parseInt(e.target.value, 10))}
            disabled={autoConfig}
            min={1}
            max={16}
          />
        </div>

        <div className="config-group config-checkbox">
          <input
            type="checkbox"
            id="flashAttention"
            checked={config.flashAttention}
            onChange={(e) => handleChange('flashAttention', e.target.checked)}
            disabled={autoConfig}
          />
          <label htmlFor="flashAttention">
            Flash Attention
            <span className="config-hint">Enable flash attention for better performance</span>
          </label>
        </div>
      </div>
    </div>
  );
};

export default ServerConfig;
