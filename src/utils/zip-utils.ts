/**
 * ZIP file extraction utilities
 * @module utils/zip-utils
 */

import AdmZip from 'adm-zip';
import path from 'path';
import { promises as fs } from 'fs';
import { fileExists } from './file-utils.js';
import { FileSystemError } from '../errors/index.js';

/**
 * Extract a ZIP archive and find the llama-server binary
 *
 * @param zipPath - Path to the ZIP file
 * @param extractTo - Directory to extract to (will be created if it doesn't exist)
 * @returns Path to the extracted llama-server binary
 * @throws {FileSystemError} If extraction fails or binary not found
 *
 * @example
 * ```typescript
 * const binaryPath = await extractLlamaServerBinary(
 *   '/path/to/llama-b6783-bin-win-cuda-x64.zip',
 *   '/path/to/temp/extract'
 * );
 * console.log('Binary extracted to:', binaryPath);
 * ```
 */
export async function extractLlamaServerBinary(
  zipPath: string,
  extractTo: string
): Promise<string> {
  try {
    // Verify ZIP file exists
    if (!(await fileExists(zipPath))) {
      throw new FileSystemError(`ZIP file not found: ${zipPath}`, {
        path: zipPath,
      });
    }

    // Create extraction directory
    await fs.mkdir(extractTo, { recursive: true });

    // Extract ZIP
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractTo, true);

    // Find llama-server binary in extracted files
    // Binary names: llama-server (Unix) or llama-server.exe (Windows)
    const binaryNames = ['llama-server.exe', 'llama-server', 'llama-cli.exe', 'llama-cli'];
    const binaryPath = await findBinaryInDirectory(extractTo, binaryNames);

    if (!binaryPath) {
      throw new FileSystemError(
        `llama-server binary not found in extracted ZIP: ${zipPath}`,
        {
          path: zipPath,
          extractedTo: extractTo,
          suggestion: 'ZIP archive may have unexpected structure',
        }
      );
    }

    return binaryPath;
  } catch (error) {
    if (error instanceof FileSystemError) {
      throw error;
    }
    throw new FileSystemError(`Failed to extract ZIP: ${zipPath}`, {
      path: zipPath,
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
  } catch (error) {
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
