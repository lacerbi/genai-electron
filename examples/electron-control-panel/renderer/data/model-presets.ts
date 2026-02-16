import type { DiffusionComponentRole } from '../types/api';

export interface PresetVariant {
  label: string; // "Q8_0 (~4.3 GB)"
  file?: string; // HuggingFace filename
  url?: string; // Direct URL (for url source)
  sizeGB: number; // Approximate size for display
}

export interface PresetComponent {
  role: DiffusionComponentRole;
  label: string; // "Text Encoder (Qwen3-4B base)"
  source: 'huggingface' | 'url';
  repo?: string;
  variants?: PresetVariant[]; // If multiple quant options
  fixedFile?: string; // If no variants (e.g., VAE)
  fixedUrl?: string; // Direct URL for fixed component
  fixedSizeGB?: number;
}

export interface PresetRecommendedSettings {
  steps: number;
  cfgScale: number;
  sampler: string;
  width?: number;
  height?: number;
}

export interface ModelPreset {
  id: string;
  name: string;
  description: string;
  type: 'llm' | 'diffusion';
  primary: {
    source: 'huggingface' | 'url';
    repo?: string;
    variants: PresetVariant[];
  };
  components: PresetComponent[];
  recommendedSettings?: PresetRecommendedSettings;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'flux-2-klein',
    name: 'Flux 2 Klein',
    description: 'Fast Flux 2 image generation with Qwen3-4B text encoder. 3 components.',
    type: 'diffusion',
    primary: {
      source: 'huggingface',
      repo: 'leejet/FLUX.2-klein-4B-GGUF',
      variants: [
        { label: 'Q8_0 (~4.3 GB)', file: 'flux-2-klein-4b-Q8_0.gguf', sizeGB: 4.3 },
        { label: 'Q4_0 (~2.5 GB)', file: 'flux-2-klein-4b-Q4_0.gguf', sizeGB: 2.5 },
      ],
    },
    components: [
      {
        role: 'llm',
        label: 'Text Encoder (Qwen3-4B base)',
        source: 'huggingface',
        repo: 'unsloth/Qwen3-4B-GGUF',
        variants: [
          { label: 'Q4_0 (~2.5 GB)', file: 'Qwen3-4B-Q4_0.gguf', sizeGB: 2.5 },
          { label: 'Q8_0 (~4.3 GB)', file: 'Qwen3-4B-Q8_0.gguf', sizeGB: 4.3 },
        ],
      },
      {
        role: 'vae',
        label: 'VAE (Flux 2, 32ch)',
        source: 'url',
        fixedUrl:
          'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
        fixedSizeGB: 0.34,
      },
    ],
    recommendedSettings: {
      steps: 4,
      cfgScale: 1,
      sampler: 'euler',
      width: 768,
      height: 768,
    },
  },
  {
    id: 'sdxl-lightning-4-step',
    name: 'SDXL Lightning (4-step)',
    description: 'Fast SDXL image generation in 4 steps. Single file, no extra components.',
    type: 'diffusion',
    primary: {
      source: 'huggingface',
      repo: 'mzwing/SDXL-Lightning-GGUF',
      variants: [
        { label: 'Q4_1 (~2.8 GB)', file: 'sdxl_lightning_4step.q4_1.gguf', sizeGB: 2.8 },
        { label: 'Q5_1 (~3.2 GB)', file: 'sdxl_lightning_4step.q5_1.gguf', sizeGB: 3.2 },
      ],
    },
    components: [], // Monolithic single-file model
    recommendedSettings: {
      steps: 4,
      cfgScale: 1,
      sampler: 'euler',
      width: 1024,
      height: 1024,
    },
  },
];
