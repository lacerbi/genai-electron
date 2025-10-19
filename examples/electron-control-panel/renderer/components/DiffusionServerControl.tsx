import React, { useState, useEffect } from 'react';
import Card from './common/Card';
import StatusIndicator from './common/StatusIndicator';
import ActionButton from './common/ActionButton';
import Spinner from './common/Spinner';
import { useDiffusionServer } from './hooks/useDiffusionServer';
import { useModels } from './hooks/useModels';
import type { ImageGenerationResult, ImageSampler } from '../types/api';
import './DiffusionServerControl.css';

const DiffusionServerControl: React.FC = () => {
  const { serverInfo, isHealthy, error: serverError, start, stop } = useDiffusionServer();
  const { models, loading: modelsLoading } = useModels('diffusion');

  const [selectedModel, setSelectedModel] = useState('');
  const [startLoading, setStartLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);

  // Image generation state
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(20);
  const [cfgScale, setCfgScale] = useState(7.5);
  const [sampler, setSampler] = useState<ImageSampler>('euler_a');
  const [generating, setGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<ImageGenerationResult | null>(null);
  const [generateError, setGenerateError] = useState<string>('');

  // Set first model as default when models load
  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);

  const handleStart = async () => {
    if (!selectedModel) {
      alert('Please select a diffusion model first');
      return;
    }

    setStartLoading(true);
    try {
      await start({
        modelId: selectedModel,
        port: 8081,
      });
    } finally {
      setStartLoading(false);
    }
  };

  const handleStop = async () => {
    setStopLoading(true);
    try {
      await stop();
    } finally {
      setStopLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setGenerateError('Please enter a prompt');
      return;
    }

    setGenerating(true);
    setGenerateError('');
    setGeneratedImage(null);

    try {
      const result = await window.api.diffusion.generateImage(
        {
          prompt,
          negativePrompt: negativePrompt || undefined,
          width,
          height,
          steps,
          cfgScale,
          sampler,
        },
        serverInfo.port
      );
      setGeneratedImage(result);
    } catch (err) {
      setGenerateError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const isRunning = serverInfo.status === 'running';
  const isBusy = serverInfo.busy || generating;

  return (
    <div className="diffusion-server-control">
      <h2>Diffusion Server Control</h2>

      {/* Error Display */}
      {serverError && (
        <div className="error-banner">
          <strong>Error:</strong> {serverError}
        </div>
      )}

      {/* Server Status */}
      <Card title="Server Status">
        <div className="status-grid">
          <div className="status-item">
            <label>Status:</label>
            <StatusIndicator
              status={serverInfo.status === 'running' ? 'running' : 'stopped'}
              label={serverInfo.status}
            />
          </div>
          <div className="status-item">
            <label>Health:</label>
            <StatusIndicator status={isHealthy ? 'running' : 'stopped'} label={serverInfo.health} />
          </div>
          {serverInfo.pid && (
            <div className="status-item">
              <label>PID:</label>
              <span>{serverInfo.pid}</span>
            </div>
          )}
          <div className="status-item">
            <label>Port:</label>
            <span>{serverInfo.port}</span>
          </div>
          {serverInfo.modelId && (
            <div className="status-item">
              <label>Model:</label>
              <span>{serverInfo.modelId}</span>
            </div>
          )}
          {isBusy && (
            <div className="status-item">
              <label>Status:</label>
              <span className="busy-indicator">⚙️ Generating...</span>
            </div>
          )}
        </div>
      </Card>

      {/* Server Configuration */}
      <Card title="Server Configuration">
        <div className="form-group">
          <label htmlFor="diffusion-model">Diffusion Model:</label>
          {modelsLoading ? (
            <p className="info-message">Loading models...</p>
          ) : models.length === 0 ? (
            <p className="warning-message">
              No diffusion models found. Download a diffusion model in the Models tab first.
            </p>
          ) : (
            <select
              id="diffusion-model"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isRunning || startLoading}
              className="model-select"
            >
              <option value="">Select a model...</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({(model.size / 1024 / 1024 / 1024).toFixed(2)} GB)
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="server-actions">
          {!isRunning ? (
            <ActionButton
              onClick={handleStart}
              disabled={startLoading || !selectedModel || models.length === 0}
              variant="primary"
            >
              {startLoading ? (
                <>
                  <Spinner size="small" />
                  Starting...
                </>
              ) : (
                'Start Server'
              )}
            </ActionButton>
          ) : (
            <ActionButton onClick={handleStop} disabled={stopLoading || isBusy} variant="danger">
              {stopLoading ? (
                <>
                  <Spinner size="small" />
                  Stopping...
                </>
              ) : (
                'Stop Server'
              )}
            </ActionButton>
          )}
        </div>

        {isBusy && (
          <p className="info-message">
            Server is busy generating an image. Please wait until generation completes before
            stopping.
          </p>
        )}
      </Card>

      {/* Image Generation Form */}
      {isRunning && (
        <Card title="Generate Image">
          {generateError && (
            <div className="error-banner">
              <strong>Error:</strong> {generateError}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="prompt">Prompt:</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A serene mountain landscape at sunset, 4k, detailed"
              rows={3}
              disabled={generating}
              className="prompt-textarea"
            />
          </div>

          <div className="form-group">
            <label htmlFor="negative-prompt">Negative Prompt (optional):</label>
            <textarea
              id="negative-prompt"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="blurry, low quality, distorted"
              rows={2}
              disabled={generating}
              className="prompt-textarea"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="width">Width:</label>
              <input
                id="width"
                type="number"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                min={256}
                max={2048}
                step={64}
                disabled={generating}
              />
            </div>

            <div className="form-group">
              <label htmlFor="height">Height:</label>
              <input
                id="height"
                type="number"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                min={256}
                max={2048}
                step={64}
                disabled={generating}
              />
            </div>

            <div className="form-group">
              <label htmlFor="steps">Steps:</label>
              <input
                id="steps"
                type="number"
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                min={1}
                max={150}
                disabled={generating}
              />
            </div>

            <div className="form-group">
              <label htmlFor="cfg-scale">CFG Scale:</label>
              <input
                id="cfg-scale"
                type="number"
                value={cfgScale}
                onChange={(e) => setCfgScale(Number(e.target.value))}
                min={1}
                max={20}
                step={0.5}
                disabled={generating}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="sampler">Sampler:</label>
            <select
              id="sampler"
              value={sampler}
              onChange={(e) => setSampler(e.target.value as ImageSampler)}
              disabled={generating}
              className="model-select"
            >
              <option value="euler_a">Euler A</option>
              <option value="euler">Euler</option>
              <option value="heun">Heun</option>
              <option value="dpm2">DPM2</option>
              <option value="dpm++2s_a">DPM++ 2S A</option>
              <option value="dpm++2m">DPM++ 2M</option>
              <option value="dpm++2mv2">DPM++ 2Mv2</option>
              <option value="lcm">LCM</option>
            </select>
          </div>

          <div className="server-actions">
            <ActionButton
              onClick={handleGenerate}
              disabled={generating || !prompt.trim()}
              variant="primary"
            >
              {generating ? (
                <>
                  <Spinner size="small" />
                  Generating...
                </>
              ) : (
                'Generate Image'
              )}
            </ActionButton>
          </div>
        </Card>
      )}

      {/* Generated Image Display */}
      {generatedImage && (
        <Card title="Generated Image">
          <div className="generated-image-container">
            <img src={generatedImage.imageDataUrl} alt="Generated" className="generated-image" />
            <div className="image-metadata">
              <p>
                <strong>Dimensions:</strong> {generatedImage.width}x{generatedImage.height}
              </p>
              <p>
                <strong>Time Taken:</strong> {(generatedImage.timeTaken / 1000).toFixed(2)}s
              </p>
              <p>
                <strong>Seed:</strong> {generatedImage.seed}
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default DiffusionServerControl;
