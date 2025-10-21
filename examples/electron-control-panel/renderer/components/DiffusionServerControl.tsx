import React, { useState, useEffect } from 'react';
import Card from './common/Card';
import StatusIndicator from './common/StatusIndicator';
import ActionButton from './common/ActionButton';
import Spinner from './common/Spinner';
import { useDiffusionServer } from './hooks/useDiffusionServer';
import { useModels } from './hooks/useModels';
import type {
  ImageGenerationResult,
  ImageGenerationProgress,
  ImageSampler,
  BinaryLogEvent,
} from '../types/api';
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

  // Preset selectors
  const [dimensionPreset, setDimensionPreset] = useState('512×512');
  const [stepsPreset, setStepsPreset] = useState('20');
  const [cfgPreset, setCfgPreset] = useState('7.5');
  const [seedPreset, setSeedPreset] = useState('Random (-1)');

  // Actual values (set by presets or custom input)
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(20);
  const [cfgScale, setCfgScale] = useState(7.5);
  const [seed, setSeed] = useState(-1);

  const [sampler, setSampler] = useState<ImageSampler>('euler_a');
  const [generating, setGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<ImageGenerationResult | null>(null);
  const [generateError, setGenerateError] = useState<string>('');

  // Binary setup logs (during server startup)
  const [binaryLogs, setBinaryLogs] = useState<Array<BinaryLogEvent & { timestamp: Date }>>([]);

  // Image generation progress
  const [generationProgress, setGenerationProgress] =
    useState<ImageGenerationProgress | null>(null);

  // Set first model as default when models load
  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);

  // Listen for binary-log events
  useEffect(() => {
    const handleBinaryLog = (data: BinaryLogEvent) => {
      setBinaryLogs((prev) => [...prev, { ...data, timestamp: new Date() }]);
    };

    window.api.on('diffusion:binary-log', handleBinaryLog);

    return () => {
      window.api.off('diffusion:binary-log');
    };
  }, []);

  // Listen for image generation progress events
  useEffect(() => {
    const handleProgress = (data: ImageGenerationProgress) => {
      setGenerationProgress(data);
    };

    window.api.on('diffusion:progress', handleProgress);

    return () => {
      window.api.off('diffusion:progress');
    };
  }, []);

  // Clear binary logs when server reaches running state
  useEffect(() => {
    if (serverInfo.status === 'running') {
      setBinaryLogs([]);
    }
  }, [serverInfo.status]);

  // Preset change handlers
  const handleDimensionPresetChange = (value: string) => {
    setDimensionPreset(value);
    if (value !== 'Custom') {
      // Parse dimension preset (e.g., "512×512" or "512×768")
      const [w, h] = value.split('×').map(Number);
      setWidth(w);
      setHeight(h);
    }
  };

  const handleStepsPresetChange = (value: string) => {
    setStepsPreset(value);
    if (value !== 'Custom') {
      setSteps(Number(value));
    }
  };

  const handleCfgPresetChange = (value: string) => {
    setCfgPreset(value);
    if (value !== 'Custom') {
      setCfgScale(Number(value));
    }
  };

  const handleSeedPresetChange = (value: string) => {
    setSeedPreset(value);
    if (value === 'Random (-1)') {
      setSeed(-1);
    } else if (value === 'Fixed: 42') {
      setSeed(42);
    } else if (value === 'Fixed: 123456') {
      setSeed(123456);
    } else if (value === 'Fixed: 999999') {
      setSeed(999999);
    }
    // If 'Custom', don't change the seed value
  };

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
    setGenerationProgress(null); // Reset progress

    try {
      const result = await window.api.diffusion.generateImage({
        prompt,
        negativePrompt: negativePrompt || undefined,
        width,
        height,
        steps,
        cfgScale,
        seed,
        sampler,
      });
      setGeneratedImage(result);
    } catch (err) {
      setGenerateError((err as Error).message);
    } finally {
      setGenerating(false);
      setGenerationProgress(null); // Clear progress when done
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

      {/* Binary Setup Status (shown during startup) */}
      {binaryLogs.length > 0 && (
        <Card title="Binary Setup Status">
          <div className="binary-logs">
            {binaryLogs.map((log, idx) => (
              <div key={idx} className={`binary-log-entry binary-log-${log.level}`}>
                <span className="binary-log-level">[{log.level.toUpperCase()}]</span>
                <span className="binary-log-message">{log.message}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

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

          {/* Dimensions Preset */}
          <div className="form-group">
            <label htmlFor="dimension-preset">Image Size:</label>
            <select
              id="dimension-preset"
              value={dimensionPreset}
              onChange={(e) => handleDimensionPresetChange(e.target.value)}
              disabled={generating}
              className="model-select"
            >
              <option value="512×512">512×512 (SD 1.5 native, fast)</option>
              <option value="768×768">768×768 (SD 1.5 upscaled)</option>
              <option value="1024×1024">1024×1024 (SDXL native)</option>
              <option value="512×768">512×768 (Portrait)</option>
              <option value="768×512">768×512 (Landscape)</option>
              <option value="1536×1024">1536×1024 (SDXL Landscape)</option>
              <option value="1024×1536">1024×1536 (SDXL Portrait)</option>
              <option value="Custom">Custom (enter dimensions)</option>
            </select>
          </div>

          {dimensionPreset === 'Custom' && (
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
            </div>
          )}

          <div className="form-row">
            {/* Steps Preset */}
            <div className="form-group">
              <label htmlFor="steps-preset">Steps:</label>
              <select
                id="steps-preset"
                value={stepsPreset}
                onChange={(e) => handleStepsPresetChange(e.target.value)}
                disabled={generating}
                className="model-select"
              >
                <option value="1">1 (LCM ultra-fast)</option>
                <option value="2">2 (Turbo 2-step)</option>
                <option value="4">4 (Turbo 4-step)</option>
                <option value="8">8 (Lightning)</option>
                <option value="20">20 (Standard quality)</option>
                <option value="30">30 (High quality)</option>
                <option value="Custom">Custom</option>
              </select>
              {stepsPreset === 'Custom' && (
                <input
                  type="number"
                  value={steps}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  min={1}
                  max={150}
                  disabled={generating}
                  className="custom-input"
                />
              )}
            </div>

            {/* CFG Scale Preset */}
            <div className="form-group">
              <label htmlFor="cfg-preset">CFG Scale:</label>
              <select
                id="cfg-preset"
                value={cfgPreset}
                onChange={(e) => handleCfgPresetChange(e.target.value)}
                disabled={generating}
                className="model-select"
              >
                <option value="1.0">1.0 (Turbo/LCM minimal)</option>
                <option value="2.0">2.0 (Turbo guidance)</option>
                <option value="7.5">7.5 (Standard balanced)</option>
                <option value="10.0">10.0 (Strong adherence)</option>
                <option value="15.0">15.0 (Very strong)</option>
                <option value="Custom">Custom</option>
              </select>
              {cfgPreset === 'Custom' && (
                <input
                  type="number"
                  value={cfgScale}
                  onChange={(e) => setCfgScale(Number(e.target.value))}
                  min={1}
                  max={20}
                  step={0.5}
                  disabled={generating}
                  className="custom-input"
                />
              )}
            </div>
          </div>

          {/* Seed Preset */}
          <div className="form-group">
            <label htmlFor="seed-preset">Seed:</label>
            <select
              id="seed-preset"
              value={seedPreset}
              onChange={(e) => handleSeedPresetChange(e.target.value)}
              disabled={generating}
              className="model-select"
            >
              <option value="Random (-1)">Random (-1)</option>
              <option value="Fixed: 42">Fixed: 42</option>
              <option value="Fixed: 123456">Fixed: 123456</option>
              <option value="Fixed: 999999">Fixed: 999999</option>
              <option value="Custom">Custom</option>
            </select>
            {seedPreset === 'Custom' && (
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
                min={-1}
                max={2147483647}
                disabled={generating}
                className="custom-input"
              />
            )}
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
                  {generationProgress
                    ? `Generating... Step ${generationProgress.currentStep}/${generationProgress.totalSteps} (${Math.round((generationProgress.currentStep / generationProgress.totalSteps) * 100)}%)`
                    : 'Generating...'}
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
