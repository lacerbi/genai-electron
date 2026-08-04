/**
 * File downloader with progress tracking
 * @module download/Downloader
 */

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { DownloadProgressCallback } from '../types/index.js';
import { DownloadError } from '../errors/index.js';
import { moveFile, deleteFile, fileExists } from '../utils/file-utils.js';

/**
 * Download configuration
 */
export interface DownloadOptions {
  /** Download URL */
  url: string;

  /** Destination file path */
  destination: string;

  /** Progress callback */
  onProgress?: DownloadProgressCallback;

  /** Download timeout in milliseconds */
  timeout?: number;

  /** Custom headers */
  headers?: Record<string, string>;

  /** Optional caller cancellation, combined with {@link cancel}. */
  signal?: AbortSignal;
}

/**
 * File downloader with streaming and progress tracking
 *
 * @example
 * ```typescript
 * const downloader = new Downloader();
 * await downloader.download({
 *   url: 'https://example.com/model.gguf',
 *   destination: '/path/to/model.gguf',
 *   onProgress: (downloaded, total) => {
 *     console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
 *   }
 * });
 * ```
 */
export class Downloader {
  private abortController: AbortController | null = null;
  private isDownloading = false;

  /**
   * Download a file with progress tracking
   *
   * @param options - Download options
   * @throws {DownloadError} If download fails
   *
   * @example
   * ```typescript
   * await downloader.download({
   *   url: 'https://example.com/file.bin',
   *   destination: '/path/to/file.bin',
   *   onProgress: (downloaded, total) => console.log(`${downloaded}/${total}`)
   * });
   * ```
   */
  public async download(options: DownloadOptions): Promise<void> {
    const { url, destination, onProgress, headers, signal } = options;
    // Note: timeout handling deferred to Phase 3

    // Check if already downloading
    if (this.isDownloading) {
      throw new DownloadError('Download already in progress');
    }

    this.isDownloading = true;
    this.abortController = new AbortController();
    const downloadSignal = signal
      ? AbortSignal.any([signal, this.abortController.signal])
      : this.abortController.signal;

    const partialPath = `${destination}.partial`;

    try {
      // Fetch the file
      const response = await fetch(url, {
        signal: downloadSignal,
        headers: headers || {},
      });

      if (!response.ok) {
        throw new DownloadError(`HTTP error: ${response.status} ${response.statusText}`, {
          status: response.status,
          url,
        });
      }

      if (!response.body) {
        throw new DownloadError('Response body is null', { url });
      }

      const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
      let downloadedSize = 0;

      // Create write stream for partial file
      const fileStream = createWriteStream(partialPath);

      const reader = response.body.getReader();
      let lastProgressUpdate = Date.now();
      const progressInterval = 100; // Update progress every 100ms
      const cancelReader = (): void => {
        void reader.cancel?.(downloadSignal.reason).catch(() => void 0);
      };
      downloadSignal.addEventListener('abort', cancelReader, { once: true });

      const source = Readable.from(
        (async function* () {
          while (true) {
            downloadSignal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) return;

            downloadedSize += value.length;

            // Call progress callback (wrap in try-catch to handle callback errors gracefully)
            const now = Date.now();
            if (onProgress && now - lastProgressUpdate >= progressInterval) {
              try {
                onProgress(downloadedSize, totalSize);
              } catch {
                // Ignore callback errors - don't let badly behaved callbacks crash the download
              }
              lastProgressUpdate = now;
            }

            yield value;
          }
        })()
      );

      try {
        // The pipeline owns both Node streams. Cancellation also cancels the web reader above, and
        // this await does not release the partial path until every stream has settled.
        await pipeline(source, fileStream, { signal: downloadSignal });
      } finally {
        downloadSignal.removeEventListener('abort', cancelReader);
        await reader.cancel?.().catch(() => void 0);
        reader.releaseLock?.();
      }

      // Final progress callback
      if (onProgress && totalSize > 0) {
        try {
          onProgress(totalSize, totalSize);
        } catch {
          // Ignore callback errors
        }
      }

      // Move partial file to final destination
      await moveFile(partialPath, destination);
    } catch (error) {
      // Clean up partial file on error
      const partialExists = await fileExists(partialPath);
      if (partialExists) {
        try {
          await deleteFile(partialPath);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Check if download was cancelled
      if (downloadSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new DownloadError('Download cancelled', { url });
      }

      // Re-throw as DownloadError
      if (error instanceof DownloadError) {
        throw error;
      }

      throw new DownloadError('Download failed', { url, error });
    } finally {
      this.isDownloading = false;
      this.abortController = null;
    }
  }

  /**
   * Cancel ongoing download
   *
   * @example
   * ```typescript
   * downloader.cancel();
   * ```
   */
  public cancel(): void {
    if (this.abortController && this.isDownloading) {
      this.abortController.abort();
    }
  }

  /**
   * Check if a download is currently in progress
   *
   * @returns True if downloading
   */
  public get downloading(): boolean {
    return this.isDownloading;
  }
}
