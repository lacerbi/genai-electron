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
    const { url, destination, onProgress, headers } = options;
    // Note: timeout handling deferred to Phase 3

    // Check if already downloading
    if (this.isDownloading) {
      throw new DownloadError('Download already in progress');
    }

    this.isDownloading = true;
    this.abortController = new AbortController();

    const partialPath = `${destination}.partial`;

    try {
      // Fetch the file
      const response = await fetch(url, {
        signal: this.abortController.signal,
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

      // Create a transform stream to track progress
      const trackingStream = new Readable({
        async read() {
          // This will be handled by the pipeline
        },
      });

      // Read from response body and track progress
      const reader = response.body.getReader();
      let lastProgressUpdate = Date.now();
      const progressInterval = 100; // Update progress every 100ms

      const readChunk = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          trackingStream.push(null); // End the stream
          return;
        }

        trackingStream.push(value);
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

        // Continue reading
        await readChunk();
      };

      // Start reading chunks
      const readPromise = readChunk();

      // Pipeline the streams
      await Promise.all([readPromise, pipeline(trackingStream, fileStream)]);

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
      if (error instanceof Error && error.name === 'AbortError') {
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
