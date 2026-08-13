/**
 * Archive extraction utilities (ZIP and tar.gz)
 * @module utils/archive-utils
 */

import * as tar from 'tar';
import path from 'path';
import { promises as fs } from 'fs';
import { Worker } from 'node:worker_threads';
import { fileExists } from './file-utils.js';
import { FileSystemError } from '../errors/index.js';
import {
  ADM_ZIP_WORKER_GLOBAL_KEY,
  ADM_ZIP_WORKER_PREAMBLE,
} from '../generated/adm-zip-worker-source.js';

/**
 * Entry- and byte-level progress reported while an archive is being extracted.
 *
 * ZIP extraction reports one update before extraction, throttled updates while
 * file payloads are written, and one update after every file. Byte progress
 * measures uncompressed payload bytes successfully written; adm-zip still
 * inflates each complete entry before writing it. The tar path currently does
 * not expose extraction progress.
 */
export interface ArchiveExtractionProgress {
  completedEntries: number;
  totalEntries: number;
  writtenBytes?: number;
  totalUncompressedBytes?: number;
  entry?: string;
}

export type ArchiveExtractionProgressCallback = (progress: ArchiveExtractionProgress) => void;

/** Called after ZIP writes finish while the extraction worker releases its resources. */
export type ArchiveExtractionSettlingCallback = () => void;

interface ZipWorkerData {
  archivePath: string;
  extractTo: string;
  admZipGlobalKey: string;
}

type ZipWorkerMessage =
  | {
      type: 'progress';
      completedEntries: number;
      totalEntries: number;
      writtenBytes?: number;
      totalUncompressedBytes?: number;
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
  const workerFs = await import('node:fs');
  const workerPath = await import('node:path');
  const data = workerData as ZipWorkerData;

  if (!parentPort) {
    throw new Error('ZIP extraction worker has no parent port');
  }

  try {
    interface ZipEntry {
      isDirectory: boolean;
      entryName: string;
      header: {
        size: number;
      };
    }
    type AdmZipConstructor = new (
      archivePath: string,
      options?: { fs?: unknown }
    ) => {
      getEntries(): ZipEntry[];
      extractEntryTo(
        entry: ZipEntry,
        targetPath: string,
        maintainEntryPath: boolean,
        overwrite: boolean
      ): boolean;
    };

    const workerGlobal = globalThis as unknown as Record<string, unknown>;
    const admZipCandidate = workerGlobal[data.admZipGlobalKey];
    Reflect.deleteProperty(workerGlobal, data.admZipGlobalKey);
    if (typeof admZipCandidate !== 'function') {
      throw new Error('Embedded ZIP constructor is unavailable');
    }
    const AdmZip = admZipCandidate as AdmZipConstructor;
    const WRITE_PROGRESS_CHUNK_BYTES = 4 * 1024 * 1024;
    const UNKNOWN_TOTAL_PROGRESS_INTERVAL_MS = 100;
    let completedEntries = 0;
    let totalEntries = 0;
    let writtenBytes = 0;
    let totalUncompressedBytes: number | undefined;
    let activeEntry: string | undefined;
    let lastReportedBytePercent: number | undefined;
    let lastReportedWrittenBytes = 0;
    let lastReportedAt = 0;

    const postProgress = (force = false): void => {
      const bytePercent =
        totalUncompressedBytes !== undefined && totalUncompressedBytes > 0
          ? Math.min(100, Math.floor((writtenBytes / totalUncompressedBytes) * 100))
          : undefined;
      const now = Date.now();
      const firstUnknownTotalWrite =
        bytePercent === undefined && writtenBytes > 0 && lastReportedWrittenBytes === 0;
      const unknownTotalIntervalElapsed =
        bytePercent === undefined && now - lastReportedAt >= UNKNOWN_TOTAL_PROGRESS_INTERVAL_MS;

      if (
        !force &&
        bytePercent === lastReportedBytePercent &&
        !firstUnknownTotalWrite &&
        !unknownTotalIntervalElapsed
      ) {
        return;
      }

      parentPort.postMessage({
        type: 'progress',
        completedEntries,
        totalEntries,
        writtenBytes,
        totalUncompressedBytes,
        entry: activeEntry,
      } satisfies ZipWorkerMessage);
      lastReportedBytePercent = bytePercent;
      lastReportedWrittenBytes = writtenBytes;
      lastReportedAt = now;
    };

    const progressFs = new Proxy(workerFs, {
      get(target, property, receiver) {
        if (property !== 'writeSync') {
          return Reflect.get(target, property, receiver);
        }

        return (
          fd: number,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ): number => {
          let completedWriteBytes = 0;
          while (completedWriteBytes < length) {
            const chunkLength = Math.min(WRITE_PROGRESS_CHUNK_BYTES, length - completedWriteBytes);
            const chunkPosition = position === null ? null : position + completedWriteBytes;
            const bytesWritten = workerFs.writeSync(
              fd,
              buffer,
              offset + completedWriteBytes,
              chunkLength,
              chunkPosition
            );
            if (bytesWritten <= 0) {
              throw new Error('ZIP extraction write made no progress');
            }
            completedWriteBytes += bytesWritten;
            writtenBytes += bytesWritten;
            postProgress();
          }
          return completedWriteBytes;
        };
      },
    });

    const zip = new AdmZip(data.archivePath, { fs: progressFs });
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const files: string[] = [];
    totalEntries = entries.length;

    let expectedBytes = 0;
    for (const entry of entries) {
      const entrySize = entry.header.size;
      if (
        !Number.isSafeInteger(entrySize) ||
        entrySize < 0 ||
        !Number.isSafeInteger(expectedBytes + entrySize)
      ) {
        expectedBytes = -1;
        break;
      }
      expectedBytes += entrySize;
    }
    if (expectedBytes >= 0) {
      totalUncompressedBytes = expectedBytes;
    }

    postProgress(true);

    for (const [index, entry] of entries.entries()) {
      // Mirror adm-zip's canonicalization: normalize as an absolute POSIX
      // path, then remove the synthetic root. This removes '..' traversal
      // while preserving the archive-relative nested path.
      const canonicalEntry = workerPath.posix
        .normalize(`/${entry.entryName.replaceAll('\\', '/')}`)
        .replace(/^\/+/, '');
      activeEntry = canonicalEntry;
      zip.extractEntryTo(entry, data.extractTo, true, true);
      files.push(canonicalEntry);
      completedEntries = index + 1;
      postProgress(true);
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

const ZIP_WORKER_SOURCE = `${ADM_ZIP_WORKER_PREAMBLE}\n(${zipExtractionWorkerMain.toString()})()`;

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
 * @param onProgress - Optional ZIP write-byte and file-entry progress callback
 * @param onFilesExtracted - Optional callback receiving normalized archive-relative file paths
 * @param onSettling - Optional callback when ZIP writes finish and worker cleanup begins
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
  onFilesExtracted?: (files: readonly string[]) => void,
  onSettling?: ArchiveExtractionSettlingCallback
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
      extractedFiles = await extractZipInWorker(archivePath, extractTo, onProgress, onSettling);
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
 * @param onProgress - Optional ZIP write-byte and file-entry progress callback
 * @param onSettling - Optional callback when ZIP writes finish and worker cleanup begins
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
  onProgress?: ArchiveExtractionProgressCallback,
  onSettling?: ArchiveExtractionSettlingCallback
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
      return await extractZipInWorker(archivePath, extractTo, onProgress, onSettling);
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
  onProgress?: ArchiveExtractionProgressCallback,
  onSettling?: ArchiveExtractionSettlingCallback
): Promise<string[]> {
  await fs.mkdir(extractTo, { recursive: true });

  return await new Promise<string[]>((resolve, reject) => {
    const worker = new Worker(ZIP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        archivePath,
        extractTo,
        admZipGlobalKey: ADM_ZIP_WORKER_GLOBAL_KEY,
      } satisfies ZipWorkerData,
    });

    let files: string[] | undefined;
    let workerFailure: Error | undefined;
    let successfulTerminationRequested = false;

    worker.on('message', (message: ZipWorkerMessage) => {
      if (message.type === 'progress') {
        try {
          onProgress?.({
            completedEntries: message.completedEntries,
            totalEntries: message.totalEntries,
            writtenBytes: message.writtenBytes,
            totalUncompressedBytes: message.totalUncompressedBytes,
            entry: message.entry,
          });
        } catch {
          // Consumer callbacks must never abort extraction.
        }
      } else if (message.type === 'done') {
        files = message.files;
        successfulTerminationRequested = true;
        try {
          onSettling?.();
        } catch {
          // Consumer callbacks must never abort extraction.
        }
        // All extraction and synchronous file writes have completed before the
        // worker sends this result. Request termination now instead of waiting
        // for a large V8 isolate to tear itself down naturally, but continue to
        // settle only from `exit` so no worker handle escapes the API call.
        void worker.terminate().catch(() => {
          // The exit event remains authoritative. If termination loses a race
          // with natural shutdown, a clean exit can still return the result.
        });
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
      } else if (code !== 0 && !(successfulTerminationRequested && code === 1)) {
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
