import React, { useState } from 'react';
import ActionButton from './common/ActionButton';
import ProgressBar from './common/ProgressBar';
import './ModelDownloadForm.css';

interface DownloadConfig {
  source: 'url' | 'huggingface';
  url?: string;
  repo?: string;
  file?: string;
  name: string;
  type: 'llm' | 'diffusion';
  checksum?: string;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  modelName: string;
}

interface ModelDownloadFormProps {
  onDownload: (config: DownloadConfig) => Promise<void>;
  downloading: boolean;
  progress: DownloadProgress | null;
}

const ModelDownloadForm: React.FC<ModelDownloadFormProps> = ({
  onDownload,
  downloading,
  progress,
}) => {
  const [source, setSource] = useState<'url' | 'huggingface'>('huggingface');
  const [modelType, setModelType] = useState<'llm' | 'diffusion'>('llm');
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState('');
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [checksum, setChecksum] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
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
    <form className="download-form" onSubmit={handleSubmit}>
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
          <ProgressBar current={progress.downloaded} total={progress.total} showPercentage={true} />
          <p className="download-details">
            {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
          </p>
        </div>
      )}

      {/* Submit Button */}
      <div className="form-actions">
        <ActionButton variant="primary" onClick={handleSubmit} loading={downloading}>
          {downloading ? 'Downloading...' : 'Download Model'}
        </ActionButton>
      </div>
    </form>
  );
};

export default ModelDownloadForm;
