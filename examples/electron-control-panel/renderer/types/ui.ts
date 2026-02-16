// UI-specific types

export type TabName = 'system' | 'models' | 'server' | 'diffusion' | 'resources';

export interface LlamaServerConfigForm {
  modelId: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  parallelRequests: number;
  flashAttention: boolean;
}

export interface DownloadFormData {
  source: 'url' | 'huggingface';
  url?: string;
  repo?: string;
  file?: string;
  name: string;
  checksum?: string;
}

export interface ComponentProgress {
  role: string;
  filename: string;
  index: number;
  total: number;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  modelName: string;
  component?: ComponentProgress;
}

// Phase 2: Image generation form data
export interface ImageFormData {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  seed: number;
  sampler: string;
}

// Phase 2: Resource monitoring events
export interface ResourceEvent {
  time: string;
  message: string;
  type: 'info' | 'warning' | 'error';
}
