/**
 * GGUF parser utility for extracting model metadata
 *
 * Uses @huggingface/gguf to parse GGUF files and extract metadata
 * including layer counts, context length, architecture info, and more.
 *
 * @module utils/gguf-parser
 */

import { gguf } from '@huggingface/gguf';
import type { GGUFParseOutput } from '@huggingface/gguf';
import { DownloadError } from '../errors/index.js';

/**
 * Parsed GGUF metadata and tensor information
 */
export interface ParsedGGUFData {
  /** Complete metadata from GGUF file */
  metadata: Record<string, unknown>;
  /** Tensor information */
  tensorInfos: GGUFParseOutput['tensorInfos'];
}

/**
 * Fetch GGUF metadata from a remote URL
 *
 * Parses the GGUF file header remotely without downloading the entire file.
 * This is efficient for large models (GBs) as it only reads the metadata section.
 *
 * @param url - Remote URL to GGUF file (HuggingFace or direct URL)
 * @returns Parsed GGUF metadata and tensor information
 * @throws {DownloadError} If fetch fails or file is not a valid GGUF
 *
 * @example
 * ```typescript
 * const metadata = await fetchGGUFMetadata(
 *   'https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf'
 * );
 * console.log('Layer count:', metadata.metadata['llama.block_count']);
 * console.log('Context length:', metadata.metadata['llama.context_length']);
 * ```
 */
export async function fetchGGUFMetadata(url: string): Promise<ParsedGGUFData> {
  try {
    // Parse GGUF file from URL (only reads header, not entire file)
    const result = await gguf(url);

    // Validate we got valid data
    if (!result.metadata || !result.tensorInfos) {
      throw new DownloadError(
        'Invalid GGUF file: missing metadata or tensor information',
        { url, result }
      );
    }

    return {
      metadata: result.metadata as Record<string, unknown>,
      tensorInfos: result.tensorInfos,
    };
  } catch (error) {
    // Enhance error message
    if (error instanceof DownloadError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new DownloadError(
      `Failed to fetch GGUF metadata from URL: ${errorMessage}`,
      {
        url,
        originalError: error,
        suggestion:
          'Verify the URL points to a valid GGUF file and is accessible. Check network connectivity if the error persists.',
      }
    );
  }
}

/**
 * Fetch GGUF metadata from a local file
 *
 * Parses a GGUF file from the local filesystem.
 * Useful for updating metadata of already-downloaded models.
 *
 * @param filePath - Absolute path to local GGUF file
 * @returns Parsed GGUF metadata and tensor information
 * @throws {DownloadError} If file read fails or file is not a valid GGUF
 *
 * @example
 * ```typescript
 * const metadata = await fetchLocalGGUFMetadata('/path/to/model.gguf');
 * console.log('Architecture:', metadata.metadata['general.architecture']);
 * ```
 */
export async function fetchLocalGGUFMetadata(filePath: string): Promise<ParsedGGUFData> {
  try {
    // Parse GGUF file from local path
    const result = await gguf(filePath, {
      allowLocalFile: true, // Required for local files
    });

    // Validate we got valid data
    if (!result.metadata || !result.tensorInfos) {
      throw new DownloadError(
        'Invalid GGUF file: missing metadata or tensor information',
        { filePath, result }
      );
    }

    return {
      metadata: result.metadata as Record<string, unknown>,
      tensorInfos: result.tensorInfos,
    };
  } catch (error) {
    // Enhance error message
    if (error instanceof DownloadError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new DownloadError(
      `Failed to read GGUF metadata from local file: ${errorMessage}`,
      {
        filePath,
        originalError: error,
        suggestion:
          'Verify the file exists and is a valid GGUF format. The file may be corrupted if it was not fully downloaded.',
      }
    );
  }
}

/**
 * Extract layer count from GGUF metadata
 *
 * Supports multiple architectures (llama, mamba, etc.)
 *
 * @param metadata - Parsed GGUF metadata
 * @returns Layer count or undefined if not found
 *
 * @example
 * ```typescript
 * const parsed = await fetchGGUFMetadata(url);
 * const layers = extractLayerCount(parsed.metadata);
 * console.log('Model has', layers, 'layers');
 * ```
 */
export function extractLayerCount(metadata: Record<string, unknown>): number | undefined {
  // Try different architecture-specific keys
  const architecture = metadata['general.architecture'];

  if (architecture === 'llama') {
    return metadata['llama.block_count'] as number | undefined;
  } else if (architecture === 'mamba') {
    return metadata['mamba.block_count'] as number | undefined;
  } else if (architecture === 'gpt2') {
    return metadata['gpt2.block_count'] as number | undefined;
  }

  // Try generic block_count key
  const blockCount = metadata['block_count'];
  if (typeof blockCount === 'number') {
    return blockCount;
  }

  return undefined;
}

/**
 * Extract context length from GGUF metadata
 *
 * Supports multiple architectures (llama, mamba, gpt2, etc.)
 *
 * @param metadata - Parsed GGUF metadata
 * @returns Context length or undefined if not found
 *
 * @example
 * ```typescript
 * const parsed = await fetchGGUFMetadata(url);
 * const contextLen = extractContextLength(parsed.metadata);
 * console.log('Context window:', contextLen);
 * ```
 */
export function extractContextLength(metadata: Record<string, unknown>): number | undefined {
  // Try different architecture-specific keys
  const architecture = metadata['general.architecture'];

  if (architecture === 'llama') {
    return metadata['llama.context_length'] as number | undefined;
  } else if (architecture === 'mamba') {
    return metadata['mamba.context_length'] as number | undefined;
  } else if (architecture === 'gpt2') {
    return metadata['gpt2.context_length'] as number | undefined;
  }

  // Try generic context_length key
  const contextLength = metadata['context_length'];
  if (typeof contextLength === 'number') {
    return contextLength;
  }

  return undefined;
}

/**
 * Extract attention head count from GGUF metadata
 *
 * Supports multiple architectures
 *
 * @param metadata - Parsed GGUF metadata
 * @returns Attention head count or undefined if not found
 */
export function extractAttentionHeadCount(metadata: Record<string, unknown>): number | undefined {
  const architecture = metadata['general.architecture'];

  if (architecture === 'llama') {
    return metadata['llama.attention.head_count'] as number | undefined;
  } else if (architecture === 'gpt2') {
    return metadata['gpt2.attention.head_count'] as number | undefined;
  }

  return undefined;
}

/**
 * Extract embedding length from GGUF metadata
 *
 * Useful for calculating model size and resource requirements
 *
 * @param metadata - Parsed GGUF metadata
 * @returns Embedding length or undefined if not found
 */
export function extractEmbeddingLength(metadata: Record<string, unknown>): number | undefined {
  const architecture = metadata['general.architecture'];

  if (architecture === 'llama') {
    return metadata['llama.embedding_length'] as number | undefined;
  } else if (architecture === 'gpt2') {
    return metadata['gpt2.embedding_length'] as number | undefined;
  }

  return undefined;
}
