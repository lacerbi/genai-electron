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
 * Extract a ZIP archive and find a binary executable
 *
 * Searches for binary executables within the extracted ZIP archive.
 * Supports both llama-server and diffusion (sd) binaries with unpredictable
 * directory structures in GitHub releases.
 *
 * @param zipPath - Path to the ZIP file
 * @param extractTo - Directory to extract to (will be created if it doesn't exist)
 * @param binaryNames - List of binary names to search for (e.g., ['sd.exe', 'sd'] or ['llama-server.exe', 'llama-server'])
 * @returns Path to the extracted binary
 * @throws {FileSystemError} If extraction fails or binary not found
 *
 * @example
 * ```typescript
 * // Extract diffusion binary
 * const binaryPath = await extractBinary(
 *   '/path/to/sd-cuda.zip',
 *   '/path/to/temp/extract',
 *   ['sd.exe', 'sd']
 * );
 * console.log('Binary extracted to:', binaryPath);
 * ```
 */
export async function extractBinary(
  zipPath: string,
  extractTo: string,
  binaryNames: string[]
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

    // Find binary in extracted files
    // Searches recursively through all subdirectories
    const binaryPath = await findBinaryInDirectory(extractTo, binaryNames);

    if (!binaryPath) {
      throw new FileSystemError(`Binary not found in extracted ZIP: ${zipPath}`, {
        path: zipPath,
        extractedTo: extractTo,
        expectedNames: binaryNames,
        suggestion: 'ZIP archive may have unexpected structure or binary names may be incorrect',
      });
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
