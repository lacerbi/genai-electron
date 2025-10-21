import React from 'react';
import ActionButton from './common/ActionButton';
import GGUFInfoModal from './GGUFInfoModal';
import type { ModelInfo } from '../types/api';
import './ModelList.css';

interface ModelListProps {
  models: ModelInfo[];
  onDelete: (modelId: string) => Promise<boolean>;
  onVerify: (modelId: string) => Promise<boolean>;
}

const ModelList: React.FC<ModelListProps> = ({ models, onDelete, onVerify }) => {
  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const [verifyingId, setVerifyingId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [selectedModel, setSelectedModel] = React.useState<ModelInfo | null>(null);
  const [isModalOpen, setIsModalOpen] = React.useState(false);

  const handleVerify = async (modelId: string) => {
    setVerifyingId(modelId);
    const isValid = await onVerify(modelId);
    setVerifyingId(null);
    if (isValid) {
      alert('Model verification successful!');
    }
  };

  const handleDelete = async (modelId: string) => {
    setDeletingId(modelId);
    await onDelete(modelId);
    setDeletingId(null);
  };

  const handleShowGGUFInfo = (model: ModelInfo) => {
    setSelectedModel(model);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedModel(null);
  };

  const handleRefreshMetadata = async (modelId: string): Promise<ModelInfo> => {
    const updatedModel = await window.api.models.updateMetadata(modelId);
    // Update the model in the list
    const modelIndex = models.findIndex((m) => m.id === modelId);
    if (modelIndex !== -1) {
      models[modelIndex] = updatedModel;
    }
    return updatedModel;
  };

  return (
    <div className="model-list">
      <table className="model-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
            <th>Downloaded</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id}>
              <td className="model-name">{model.name}</td>
              <td>
                <span className={`model-type-badge model-type-${model.type}`}>
                  {model.type === 'llm' ? 'LLM' : 'Diffusion'}
                </span>
              </td>
              <td>{formatBytes(model.size)}</td>
              <td className="model-date">{formatDate(model.downloadedAt)}</td>
              <td className="model-actions">
                <button
                  className="gguf-info-btn"
                  onClick={() => handleShowGGUFInfo(model)}
                  title="View GGUF Metadata"
                >
                  📊
                </button>
                <ActionButton
                  variant="secondary"
                  onClick={() => handleVerify(model.id)}
                  loading={verifyingId === model.id}
                >
                  Verify
                </ActionButton>
                <ActionButton
                  variant="danger"
                  onClick={() => handleDelete(model.id)}
                  loading={deletingId === model.id}
                >
                  Delete
                </ActionButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selectedModel && (
        <GGUFInfoModal
          model={selectedModel}
          isOpen={isModalOpen}
          onClose={handleCloseModal}
          onRefresh={handleRefreshMetadata}
        />
      )}
    </div>
  );
};

export default ModelList;
