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
      throw new DownloadError('Invalid GGUF file: missing metadata or tensor information', {
        url,
        result,
      });
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
    throw new DownloadError(`Failed to fetch GGUF metadata from URL: ${errorMessage}`, {
      url,
      originalError: error,
      suggestion:
        'Verify the URL points to a valid GGUF file and is accessible. Check network connectivity if the error persists.',
    });
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
      throw new DownloadError('Invalid GGUF file: missing metadata or tensor information', {
        filePath,
        result,
      });
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
    throw new DownloadError(`Failed to read GGUF metadata from local file: ${errorMessage}`, {
      filePath,
      originalError: error,
      suggestion:
        'Verify the file exists and is a valid GGUF format. The file may be corrupted if it was not fully downloaded.',
    });
  }
}

/**
 * Extract an architecture-specific field from GGUF metadata
 *
 * Dynamically constructs field path using the model's architecture prefix.
 * For example, if architecture is "gemma3" and fieldPath is "block_count",
 * it will look for "gemma3.block_count" in the metadata.
 *
 * @param metadata - Parsed GGUF metadata
 * @param fieldPath - Field path without architecture prefix (e.g., 'block_count', 'attention.head_count')
 * @returns Field value or undefined if not found
 *
 * @example
 * ```typescript
 * const parsed = await fetchGGUFMetadata(url);
 * const blockCount = getArchField(parsed.metadata, 'block_count'); // Works for llama, gemma3, qwen3, etc.
 * const headCount = getArchField(parsed.metadata, 'attention.head_count');
 * ```
 */
export function getArchField(metadata: Record<string, unknown>, fieldPath: string): unknown {
  const arch = metadata['general.architecture'];
  if (arch && typeof arch === 'string') {
    return metadata[`${arch}.${fieldPath}`];
  }
  return undefined;
}
