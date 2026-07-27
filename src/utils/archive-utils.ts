/**
 * Archive extraction utilities (ZIP and tar.gz)
 * @module utils/archive-utils
 */

import * as tar from 'tar';
import path from 'path';
import { promises as fs } from 'fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { fileExists } from './file-utils.js';
import { FileSystemError } from '../errors/index.js';

/**
 * Entry-level progress reported while an archive is being extracted.
 *
 * ZIP extraction reports one update before extraction and after every file.
 * The tar path currently does not expose entry progress.
 */
export interface ArchiveExtractionProgress {
  completedEntries: number;
  totalEntries: number;
  entry?: string;
}

export type ArchiveExtractionProgressCallback = (progress: ArchiveExtractionProgress) => void;

interface ZipWorkerData {
  archivePath: string;
  extractTo: string;
  admZipModuleUrl: string;
}

type ZipWorkerMessage =
  | {
      type: 'progress';
      completedEntries: number;
      totalEntries: number;
      entry?: string;
    }
  | { type: 'done'; files: string[] }
  | { type: 'error'; message: string; stack?: string };

/**
 * Self-contained worker entry point.
 *
 * The function is serialized with toString() and executed by Worker({ eval:
 * true }). Keeping the worker inline avoids a second runtime asset whose
 * compiled path would diverge between ts-jest source execution and the
 * published dist/ package.
 */
async function zipExtractionWorkerMain(): Promise<void> {
  const { parentPort, workerData } = await import('node:worker_threads');
  const workerPath = await import('node:path');
  const data = workerData as ZipWorkerData;

  if (!parentPort) {
    throw new Error('ZIP extraction worker has no parent port');
  }

  try {
    interface ZipEntry {
      isDirectory: boolean;
      entryName: string;
    }
    type AdmZipConstructor = new (archivePath: string) => {
      getEntries(): ZipEntry[];
      extractEntryTo(
        entry: ZipEntry,
        targetPath: string,
        maintainEntryPath: boolean,
        overwrite: boolean
      ): boolean;
    };

    const admZipModule = (await import(data.admZipModuleUrl)) as {
      default: AdmZipConstructor;
    };
    const zip = new admZipModule.default(data.archivePath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const files: string[] = [];

    parentPort.postMessage({
      type: 'progress',
      completedEntries: 0,
      totalEntries: entries.length,
    } satisfies ZipWorkerMessage);

    for (const [index, entry] of entries.entries()) {
      zip.extractEntryTo(entry, data.extractTo, true, true);

      // Mirror adm-zip's canonicalization: normalize as an absolute POSIX
      // path, then remove the synthetic root. This removes '..' traversal
      // while preserving the archive-relative nested path.
      const canonicalEntry = workerPath.posix
        .normalize(`/${entry.entryName.replaceAll('\\', '/')}`)
        .replace(/^\/+/, '');
      files.push(canonicalEntry);

      parentPort.postMessage({
        type: 'progress',
        completedEntries: index + 1,
        totalEntries: entries.length,
        entry: canonicalEntry,
      } satisfies ZipWorkerMessage);
    }

    parentPort.postMessage({ type: 'done', files } satisfies ZipWorkerMessage);
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    } satisfies ZipWorkerMessage);
  } finally {
    parentPort.close();
  }
}

const ZIP_WORKER_SOURCE = `(${zipExtractionWorkerMain.toString()})()`;
const admZipModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve('adm-zip')).toString();

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
 * @param onProgress - Optional ZIP file-entry progress callback
 * @param onFilesExtracted - Optional callback receiving normalized archive-relative file paths
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
  binaryNames: string[],
  onProgress?: ArchiveExtractionProgressCallback,
  onFilesExtracted?: (files: readonly string[]) => void
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
    let extractedFiles: string[];
    if (format === 'tar.gz') {
      extractedFiles = [];
      await tar.x({
        file: archivePath,
        C: extractTo,
        onReadEntry: (entry) => {
          if (
            entry.type === 'File' ||
            entry.type === 'OldFile' ||
            entry.type === 'ContiguousFile'
          ) {
            extractedFiles.push(
              path.posix.normalize(`/${entry.path.replaceAll('\\', '/')}`).replace(/^\/+/, '')
            );
          }
        },
      });
    } else {
      extractedFiles = await extractZipInWorker(archivePath, extractTo, onProgress);
    }
    onFilesExtracted?.(extractedFiles);

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
 * @param onProgress - Optional ZIP file-entry progress callback
 * @returns Normalized archive-relative paths of extracted files
 * @throws {FileSystemError} If extraction fails
 *
 * @example
 * ```typescript
 * await extractArchive('/path/to/cudart.zip', '/path/to/extract');
 * ```
 */
export async function extractArchive(
  archivePath: string,
  extractTo: string,
  onProgress?: ArchiveExtractionProgressCallback
): Promise<string[]> {
  try {
    await fs.mkdir(extractTo, { recursive: true });

    const format = detectArchiveFormat(archivePath);
    if (format === 'tar.gz') {
      const files: string[] = [];
      await tar.x({
        file: archivePath,
        C: extractTo,
        onReadEntry: (entry) => {
          if (
            entry.type === 'File' ||
            entry.type === 'OldFile' ||
            entry.type === 'ContiguousFile'
          ) {
            files.push(
              path.posix.normalize(`/${entry.path.replaceAll('\\', '/')}`).replace(/^\/+/, '')
            );
          }
        },
      });
      return files;
    } else {
      return await extractZipInWorker(archivePath, extractTo, onProgress);
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
 * Extract a ZIP archive entirely in a worker thread.
 *
 * The promise settles only after the worker exits, preventing worker handles
 * from leaking past callers/tests.
 */
async function extractZipInWorker(
  archivePath: string,
  extractTo: string,
  onProgress?: ArchiveExtractionProgressCallback
): Promise<string[]> {
  await fs.mkdir(extractTo, { recursive: true });

  return await new Promise<string[]>((resolve, reject) => {
    const worker = new Worker(ZIP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        archivePath,
        extractTo,
        admZipModuleUrl,
      } satisfies ZipWorkerData,
    });

    let files: string[] | undefined;
    let workerFailure: Error | undefined;

    worker.on('message', (message: ZipWorkerMessage) => {
      if (message.type === 'progress') {
        try {
          onProgress?.({
            completedEntries: message.completedEntries,
            totalEntries: message.totalEntries,
            entry: message.entry,
          });
        } catch {
          // Consumer callbacks must never abort extraction.
        }
      } else if (message.type === 'done') {
        files = message.files;
      } else {
        workerFailure = new Error(message.message);
        workerFailure.stack = message.stack;
      }
    });

    worker.once('error', (error) => {
      workerFailure = error;
    });

    worker.once('exit', (code) => {
      if (workerFailure) {
        reject(workerFailure);
      } else if (code !== 0) {
        reject(new Error(`ZIP extraction worker exited with code ${code}`));
      } else if (!files) {
        reject(new Error('ZIP extraction worker exited without a result'));
      } else {
        resolve(files);
      }
    });
  });
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
