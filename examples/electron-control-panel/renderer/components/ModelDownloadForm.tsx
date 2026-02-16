import React, { useState } from 'react';
import ActionButton from './common/ActionButton';
import ProgressBar from './common/ProgressBar';
import type { DownloadConfig, DiffusionComponentRole } from '../types/api';
import type { DownloadProgress, ComponentProgress } from '../types/ui';
import { MODEL_PRESETS } from '../data/model-presets';
import type { ModelPreset } from '../data/model-presets';
import './ModelDownloadForm.css';

interface ModelDownloadFormProps {
  onDownload: (config: DownloadConfig) => Promise<void>;
  downloading: boolean;
  progress: DownloadProgress | null;
  componentProgress?: ComponentProgress | null;
}

const ModelDownloadForm: React.FC<ModelDownloadFormProps> = ({
  onDownload,
  downloading,
  progress,
  componentProgress,
}) => {
  // Download mode: preset or custom
  const [downloadMode, setDownloadMode] = useState<'preset' | 'custom'>('preset');

  // Preset mode state
  const [selectedPresetId, setSelectedPresetId] = useState<string>(MODEL_PRESETS[0]?.id ?? '');
  const [variantSelections, setVariantSelections] = useState<Record<string, number>>({});

  // Custom mode state
  const [source, setSource] = useState<'url' | 'huggingface'>('huggingface');
  const [modelType, setModelType] = useState<'llm' | 'diffusion'>('llm');
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState('');
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [checksum, setChecksum] = useState('');

  const selectedPreset: ModelPreset | undefined = MODEL_PRESETS.find(
    (p) => p.id === selectedPresetId
  );

  const getVariantIndex = (key: string): number => variantSelections[key] ?? 0;

  const setVariantIndex = (key: string, index: number) => {
    setVariantSelections((prev) => ({ ...prev, [key]: index }));
  };

  const getEstimatedTotalGB = (): number => {
    if (!selectedPreset) return 0;
    const primaryVariant = selectedPreset.primary.variants[getVariantIndex('primary')];
    let total = primaryVariant?.sizeGB ?? 0;
    for (const comp of selectedPreset.components) {
      if (comp.variants) {
        const variant = comp.variants[getVariantIndex(comp.role)];
        total += variant?.sizeGB ?? 0;
      } else if (comp.fixedSizeGB) {
        total += comp.fixedSizeGB;
      }
    }
    return total;
  };

  const handlePresetDownload = async () => {
    if (!selectedPreset) return;

    const primaryVariant = selectedPreset.primary.variants[getVariantIndex('primary')];
    if (!primaryVariant) return;

    const config: DownloadConfig = {
      source: selectedPreset.primary.source,
      repo: selectedPreset.primary.repo,
      file: primaryVariant.file,
      url: primaryVariant.url,
      name: selectedPreset.name,
      type: selectedPreset.type,
    };

    // Build components array for multi-component presets
    if (selectedPreset.components.length > 0) {
      config.components = selectedPreset.components.map((comp) => {
        if (comp.variants) {
          const variant = comp.variants[getVariantIndex(comp.role)];
          return {
            role: comp.role as DiffusionComponentRole,
            source: comp.source,
            repo: comp.repo,
            file: variant?.file,
          };
        }
        return {
          role: comp.role as DiffusionComponentRole,
          source: comp.source,
          url: comp.fixedUrl,
        };
      });
    }

    await onDownload(config);
  };

  const handleCustomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const config: DownloadConfig = {
      source,
      name,
      type: modelType,
      checksum: checksum || undefined,
    };

    if (source === 'url') {
      config.url = url;
    } else {
      config.repo = repo;
      config.file = file;
    }

    await onDownload(config);

    // Reset form
    if (!downloading) {
      setUrl('');
      setRepo('');
      setFile('');
      setName('');
      setChecksum('');
    }
  };

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  return (
    <div className="download-form">
      {/* Mode Toggle */}
      <div className="download-mode-toggle">
        <button
          type="button"
          className={`mode-btn ${downloadMode === 'preset' ? 'active' : ''}`}
          onClick={() => setDownloadMode('preset')}
          disabled={downloading}
        >
          Preset
        </button>
        <button
          type="button"
          className={`mode-btn ${downloadMode === 'custom' ? 'active' : ''}`}
          onClick={() => setDownloadMode('custom')}
          disabled={downloading}
        >
          Custom
        </button>
      </div>

      {/* Preset Mode */}
      {downloadMode === 'preset' && (
        <div className="preset-form">
          {/* Model Selector */}
          <div className="form-group">
            <label htmlFor="preset-model">Model</label>
            <select
              id="preset-model"
              value={selectedPresetId}
              onChange={(e) => {
                setSelectedPresetId(e.target.value);
                setVariantSelections({});
              }}
              disabled={downloading}
            >
              {MODEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            {selectedPreset && <p className="preset-description">{selectedPreset.description}</p>}
          </div>

          {/* Primary Model Variant */}
          {selectedPreset && (
            <div className="form-group">
              <label htmlFor="preset-primary">Diffusion Model</label>
              <select
                id="preset-primary"
                value={getVariantIndex('primary')}
                onChange={(e) => setVariantIndex('primary', Number(e.target.value))}
                disabled={downloading}
              >
                {selectedPreset.primary.variants.map((v, i) => (
                  <option key={i} value={i}>
                    {v.file ? `${v.file} — ${v.label}` : v.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Component Variants */}
          {selectedPreset?.components.map((comp) => (
            <div className="form-group" key={comp.role}>
              <label htmlFor={`preset-${comp.role}`}>{comp.label}</label>
              {comp.variants ? (
                <select
                  id={`preset-${comp.role}`}
                  value={getVariantIndex(comp.role)}
                  onChange={(e) => setVariantIndex(comp.role, Number(e.target.value))}
                  disabled={downloading}
                >
                  {comp.variants.map((v, i) => (
                    <option key={i} value={i}>
                      {v.file ? `${v.file} — ${v.label}` : v.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="fixed-component">
                  {comp.fixedFile || comp.fixedUrl?.split('/').pop() || 'Fixed'} (
                  {comp.fixedSizeGB?.toFixed(2)} GB)
                </div>
              )}
            </div>
          ))}

          {/* Estimated Total */}
          {selectedPreset && (
            <div className="estimated-total">
              Estimated total: ~{getEstimatedTotalGB().toFixed(1)} GB
            </div>
          )}

          {/* Progress */}
          {downloading && progress && (
            <div className="download-progress">
              <p className="download-status">Downloading {progress.modelName}...</p>
              {componentProgress && componentProgress.total > 1 && (
                <p className="component-status">
                  Component {componentProgress.index}/{componentProgress.total}:{' '}
                  {componentProgress.filename}
                </p>
              )}
              <ProgressBar
                current={progress.downloaded}
                total={progress.total}
                showPercentage={true}
              />
              <p className="download-details">
                {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
              </p>
            </div>
          )}

          {/* Download Button */}
          <div className="form-actions">
            <ActionButton
              variant="primary"
              onClick={handlePresetDownload}
              loading={downloading}
              disabled={downloading || !selectedPreset}
            >
              {downloading ? 'Downloading...' : `Download ${selectedPreset?.name || 'Model'}`}
            </ActionButton>
          </div>
        </div>
      )}

      {/* Custom Mode */}
      {downloadMode === 'custom' && (
        <form className="custom-form" onSubmit={(e) => e.preventDefault()}>
          {/* Source Selection */}
          <div className="form-group">
            <label htmlFor="source">Source</label>
            <select
              id="source"
              value={source}
              onChange={(e) => setSource(e.target.value as 'url' | 'huggingface')}
              disabled={downloading}
            >
              <option value="huggingface">HuggingFace</option>
              <option value="url">Direct URL</option>
            </select>
          </div>

          {/* Model Type Selection */}
          <div className="form-group">
            <label htmlFor="modelType">Model Type</label>
            <select
              id="modelType"
              value={modelType}
              onChange={(e) => setModelType(e.target.value as 'llm' | 'diffusion')}
              disabled={downloading}
            >
              <option value="llm">LLM (Text Generation)</option>
              <option value="diffusion">Diffusion (Image Generation)</option>
            </select>
          </div>

          {/* URL Source Fields */}
          {source === 'url' && (
            <div className="form-group">
              <label htmlFor="url">Model URL</label>
              <input
                type="url"
                id="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/model.gguf"
                required
                disabled={downloading}
              />
            </div>
          )}

          {/* HuggingFace Source Fields */}
          {source === 'huggingface' && (
            <>
              <div className="form-group">
                <label htmlFor="repo">Repository</label>
                <input
                  type="text"
                  id="repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="TheBloke/Llama-2-7B-GGUF"
                  required
                  disabled={downloading}
                />
              </div>
              <div className="form-group">
                <label htmlFor="file">File Name</label>
                <input
                  type="text"
                  id="file"
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                  placeholder="llama-2-7b.Q4_K_M.gguf"
                  required
                  disabled={downloading}
                />
              </div>
            </>
          )}

          {/* Common Fields */}
          <div className="form-group">
            <label htmlFor="name">Display Name</label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Llama 2 7B"
              required
              disabled={downloading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="checksum">
              Checksum <span className="optional">(optional)</span>
            </label>
            <input
              type="text"
              id="checksum"
              value={checksum}
              onChange={(e) => setChecksum(e.target.value)}
              placeholder="sha256:abc123..."
              disabled={downloading}
            />
          </div>

          {/* Progress */}
          {downloading && progress && (
            <div className="download-progress">
              <p className="download-status">Downloading {progress.modelName}...</p>
              <ProgressBar
                current={progress.downloaded}
                total={progress.total}
                showPercentage={true}
              />
              <p className="download-details">
                {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
              </p>
            </div>
          )}

          {/* Submit Button */}
          <div className="form-actions">
            <ActionButton variant="primary" onClick={handleCustomSubmit} loading={downloading}>
              {downloading ? 'Downloading...' : 'Download Model'}
            </ActionButton>
          </div>
        </form>
      )}
    </div>
  );
};

export default ModelDownloadForm;
