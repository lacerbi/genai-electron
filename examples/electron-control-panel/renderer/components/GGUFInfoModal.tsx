import React, { useState, useEffect } from 'react';
import type { ModelInfo, GGUFMetadata } from '../types/api';
import './GGUFInfoModal.css';

interface GGUFInfoModalProps {
  model: ModelInfo;
  isOpen: boolean;
  onClose: () => void;
  onRefresh: (modelId: string) => Promise<ModelInfo>;
}

/**
 * Recursively truncate large arrays and long strings for display performance
 *
 * @param value - The value to potentially truncate
 * @param maxArrayItems - Maximum number of array items to show (default: 20)
 * @param maxStringLength - Maximum string length to show (default: 500)
 * @returns Truncated copy of the value with indicators for removed content
 */
function truncateLargeValues(
  value: unknown,
  maxArrayItems = 20,
  maxStringLength = 500
): unknown {
  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length > maxArrayItems) {
      const truncated = value.slice(0, maxArrayItems);
      const remaining = value.length - maxArrayItems;
      return [...truncated, `... (${remaining.toLocaleString()} more items)`];
    }
    // Recursively process array items
    return value.map((item) => truncateLargeValues(item, maxArrayItems, maxStringLength));
  }

  // Handle objects
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = truncateLargeValues(val, maxArrayItems, maxStringLength);
    }
    return result;
  }

  // Handle strings
  if (typeof value === 'string' && value.length > maxStringLength) {
    const remaining = value.length - maxStringLength;
    return value.substring(0, maxStringLength) + `... (${remaining.toLocaleString()} more chars)`;
  }

  // Return primitives as-is (numbers, booleans, null, undefined)
  return value;
}

const GGUFInfoModal: React.FC<GGUFInfoModalProps> = ({ model, isOpen, onClose, onRefresh }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<GGUFMetadata | undefined>(model.ggufMetadata);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [copyRawSuccess, setCopyRawSuccess] = useState(false);

  // Auto-fetch metadata if missing when modal opens
  useEffect(() => {
    if (isOpen && !metadata) {
      fetchMetadata();
    }
  }, [isOpen]);

  // Update metadata when model prop changes
  useEffect(() => {
    setMetadata(model.ggufMetadata);
  }, [model.ggufMetadata]);

  const fetchMetadata = async () => {
    setLoading(true);
    setError(null);
    try {
      const updatedModel = await onRefresh(model.id);
      setMetadata(updatedModel.ggufMetadata);
      if (!updatedModel.ggufMetadata) {
        setError('Failed to extract GGUF metadata from model file');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metadata');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyToClipboard = () => {
    if (!metadata) return;

    const jsonString = JSON.stringify(metadata, null, 2);
    navigator.clipboard.writeText(jsonString).then(
      () => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      },
      () => {
        setError('Failed to copy to clipboard');
      }
    );
  };

  const handleCopyRawJson = () => {
    if (!metadata?.raw) return;

    const jsonString = JSON.stringify(metadata.raw, null, 2);
    navigator.clipboard.writeText(jsonString).then(
      () => {
        setCopyRawSuccess(true);
        setTimeout(() => setCopyRawSuccess(false), 2000);
      },
      () => {
        setError('Failed to copy raw JSON to clipboard');
      }
    );
  };

  const formatValue = (value: unknown): string => {
    if (value === undefined || value === null) return 'N/A';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return value.toLocaleString();
    return String(value);
  };

  if (!isOpen) return null;

  return (
    <div className="gguf-modal-overlay" onClick={onClose}>
      <div className="gguf-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="gguf-modal-header">
          <h2>GGUF Model Information</h2>
          <button className="gguf-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="gguf-modal-content">
          <div className="gguf-model-name">
            <strong>Model:</strong> {model.name}
          </div>

          {loading && (
            <div className="gguf-loading">
              <div className="gguf-spinner" />
              <p>Loading GGUF metadata...</p>
            </div>
          )}

          {error && !loading && (
            <div className="gguf-error">
              <p>⚠️ {error}</p>
              <button className="gguf-retry-btn" onClick={fetchMetadata}>
                Retry
              </button>
            </div>
          )}

          {!loading && !error && metadata && (
            <>
              {/* Essential Fields Section */}
              <div className="gguf-section">
                <h3>Essential Information</h3>
                <div className="gguf-fields">
                  <div className="gguf-field">
                    <label>Architecture:</label>
                    <span>{formatValue(metadata.architecture)}</span>
                  </div>
                  <div className="gguf-field">
                    <label>Layer Count:</label>
                    <span>{formatValue(metadata.block_count)}</span>
                  </div>
                  <div className="gguf-field">
                    <label>Context Length:</label>
                    <span>{formatValue(metadata.context_length)}</span>
                  </div>
                  <div className="gguf-field">
                    <label>File Type:</label>
                    <span>{formatValue(metadata.file_type)}</span>
                  </div>
                </div>
              </div>

              {/* Advanced Section (Collapsible) */}
              <div className="gguf-section">
                <button
                  className="gguf-toggle-advanced"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  {showAdvanced ? '▼' : '▶'} Advanced Information
                </button>

                {showAdvanced && (
                  <div className="gguf-fields gguf-advanced">
                    <div className="gguf-field">
                      <label>General Name:</label>
                      <span>{formatValue(metadata.general_name)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Version:</label>
                      <span>{formatValue(metadata.version)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Tensor Count:</label>
                      <span>{formatValue(metadata.tensor_count)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>KV Count:</label>
                      <span>{formatValue(metadata.kv_count)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Attention Head Count:</label>
                      <span>{formatValue(metadata.attention_head_count)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Embedding Length:</label>
                      <span>{formatValue(metadata.embedding_length)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Feed Forward Length:</label>
                      <span>{formatValue(metadata.feed_forward_length)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Vocab Size:</label>
                      <span>{formatValue(metadata.vocab_size)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>RoPE Dimension Count:</label>
                      <span>{formatValue(metadata.rope_dimension_count)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>RoPE Freq Base:</label>
                      <span>{formatValue(metadata.rope_freq_base)}</span>
                    </div>
                    <div className="gguf-field">
                      <label>Attention RMS Epsilon:</label>
                      <span>{formatValue(metadata.attention_layer_norm_rms_epsilon)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Raw JSON Section (Collapsible) */}
              <div className="gguf-section">
                <button
                  className="gguf-toggle-advanced"
                  onClick={() => setShowRawJson(!showRawJson)}
                >
                  {showRawJson ? '▼' : '▶'} Raw JSON
                </button>

                {showRawJson && (
                  <div className="gguf-raw-json">
                    {metadata.raw ? (
                      <>
                        <pre className="gguf-json-display">
                          <code>{JSON.stringify(truncateLargeValues(metadata.raw), null, 2)}</code>
                        </pre>
                        <button
                          className="gguf-copy-raw-btn"
                          onClick={handleCopyRawJson}
                        >
                          {copyRawSuccess ? '✓ Copied!' : '📋 Copy Raw JSON (Full)'}
                        </button>
                      </>
                    ) : (
                      <p className="gguf-no-raw">No raw metadata available</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {!loading && !error && !metadata && (
            <div className="gguf-no-metadata">
              <p>No GGUF metadata available for this model.</p>
              <p>This model may have been downloaded before GGUF metadata integration.</p>
              <button className="gguf-fetch-btn" onClick={fetchMetadata}>
                Fetch Metadata Now
              </button>
            </div>
          )}
        </div>

        <div className="gguf-modal-actions">
          <button
            className="gguf-action-btn gguf-refresh-btn"
            onClick={fetchMetadata}
            disabled={loading}
          >
            🔄 Refresh Metadata
          </button>
          <button
            className="gguf-action-btn gguf-copy-btn"
            onClick={handleCopyToClipboard}
            disabled={!metadata || loading}
          >
            {copySuccess ? '✓ Copied!' : '📋 Copy to Clipboard'}
          </button>
          <button className="gguf-action-btn gguf-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default GGUFInfoModal;
