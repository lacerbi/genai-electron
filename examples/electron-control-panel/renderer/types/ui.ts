// UI-specific types

export type TabName = 'system' | 'models' | 'server';

export interface ServerConfigForm {
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

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  modelName: string;
}
