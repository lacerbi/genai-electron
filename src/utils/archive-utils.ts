/**
 * Archive extraction utilities (ZIP and tar.gz)
 * @module utils/archive-utils
 */

import AdmZip from 'adm-zip';
import * as tar from 'tar';
import path from 'path';
import { promises as fs } from 'fs';
import { fileExists } from './file-utils.js';
import { FileSystemError } from '../errors/index.js';

/**
 * Detect archive format from file path
 *
 * @param filePath - Path to the archive file
 * @returns 'tar.gz' for .tar.gz/.tgz files, 'zip' otherwise
 */
function detectArchiveFormat(filePath: string): 'zip' | 'tar.gz' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return 'tar.gz';
  }
  return 'zip';
}

/**
 * Get the appropriate archive file extension for a URL
 *
 * @param url - Download URL to check
 * @returns '.tar.gz' for tar.gz/tgz URLs, '.zip' otherwise
 *
 * @example
 * ```typescript
 * getArchiveExtension('https://example.com/file.tar.gz'); // '.tar.gz'
 * getArchiveExtension('https://example.com/file.zip');    // '.zip'
 * ```
 */
export function getArchiveExtension(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return '.tar.gz';
  }
  return '.zip';
}

/**
 * Extract an archive and find a binary executable
 *
 * Searches for binary executables within the extracted archive.
 * Supports both ZIP and tar.gz formats, detecting format from the file extension.
 *
 * @param archivePath - Path to the archive file (.zip or .tar.gz)
 * @param extractTo - Directory to extract to (will be created if it doesn't exist)
 * @param binaryNames - List of binary names to search for (e.g., ['sd.exe', 'sd'] or ['llama-server.exe', 'llama-server'])
 * @returns Path to the extracted binary
 * @throws {FileSystemError} If extraction fails or binary not found
 *
 * @example
 * ```typescript
 * const binaryPath = await extractBinary(
 *   '/path/to/llama-server.tar.gz',
 *   '/path/to/temp/extract',
 *   ['llama-server.exe', 'llama-server']
 * );
 * ```
 */
export async function extractBinary(
  archivePath: string,
  extractTo: string,
  binaryNames: string[]
): Promise<string> {
  try {
    // Verify archive file exists
    if (!(await fileExists(archivePath))) {
      throw new FileSystemError(`Archive file not found: ${archivePath}`, {
        path: archivePath,
      });
    }

    // Create extraction directory
    await fs.mkdir(extractTo, { recursive: true });

    // Extract based on format
    const format = detectArchiveFormat(archivePath);
    if (format === 'tar.gz') {
      await tar.x({ file: archivePath, C: extractTo });
    } else {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(extractTo, true);
    }

    // Find binary in extracted files
    const binaryPath = await findBinaryInDirectory(extractTo, binaryNames);

    if (!binaryPath) {
      throw new FileSystemError(`Binary not found in extracted archive: ${archivePath}`, {
        path: archivePath,
        extractedTo: extractTo,
        expectedNames: binaryNames,
        suggestion: 'Archive may have unexpected structure or binary names may be incorrect',
      });
    }

    return binaryPath;
  } catch (error) {
    if (error instanceof FileSystemError) {
      throw error;
    }
    throw new FileSystemError(`Failed to extract archive: ${archivePath}`, {
      path: archivePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Extract all files from an archive without searching for a specific binary
 *
 * Used for extracting dependency archives (e.g., CUDA runtime DLLs)
 * where all files need to be extracted to a target directory.
 *
 * @param archivePath - Path to the archive file (.zip or .tar.gz)
 * @param extractTo - Directory to extract to (will be created if it doesn't exist)
 * @throws {FileSystemError} If extraction fails
 *
 * @example
 * ```typescript
 * await extractArchive('/path/to/cudart.zip', '/path/to/extract');
 * ```
 */
export async function extractArchive(archivePath: string, extractTo: string): Promise<void> {
  try {
    await fs.mkdir(extractTo, { recursive: true });

    const format = detectArchiveFormat(archivePath);
    if (format === 'tar.gz') {
      await tar.x({ file: archivePath, C: extractTo });
    } else {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(extractTo, true);
    }
  } catch (error) {
    if (error instanceof FileSystemError) {
      throw error;
    }
    throw new FileSystemError(`Failed to extract archive: ${archivePath}`, {
      path: archivePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Recursively find a binary file in a directory
 *
 * @param dir - Directory to search
 * @param binaryNames - List of binary names to look for (in priority order)
 * @returns Path to the binary, or undefined if not found
 * @private
 */
async function findBinaryInDirectory(
  dir: string,
  binaryNames: string[]
): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    // First, check current directory for binaries
    for (const name of binaryNames) {
      const found = entries.find(
        (entry) => entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()
      );
      if (found) {
        return path.join(dir, found.name);
      }
    }

    // If not found, recursively search subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(dir, entry.name);
        const found = await findBinaryInDirectory(subPath, binaryNames);
        if (found) {
          return found;
        }
      }
    }

    return undefined;
  } catch {
    // If we can't read the directory, just return undefined
    return undefined;
  }
}

/**
 * Clean up extraction directory
 *
 * @param extractDir - Directory to remove
 * @throws {FileSystemError} If cleanup fails
 *
 * @example
 * ```typescript
 * await cleanupExtraction('/path/to/temp/extract');
 * ```
 */
export async function cleanupExtraction(extractDir: string): Promise<void> {
  try {
    await fs.rm(extractDir, { recursive: true, force: true });
  } catch (error) {
    throw new FileSystemError(`Failed to cleanup extraction directory: ${extractDir}`, {
      path: extractDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
