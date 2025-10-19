/**
 * File system utility functions
 * @module utils/file-utils
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, stat, unlink, rename, constants, cp } from 'node:fs/promises';
import { FileSystemError } from '../errors/index.js';

/**
 * Ensure a directory exists, creating it if necessary
 *
 * @param dirPath - Absolute path to directory
 * @throws {FileSystemError} If directory creation fails
 *
 * @example
 * ```typescript
 * await ensureDirectory('/path/to/dir');
 * console.log('Directory ready');
 * ```
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    throw new FileSystemError(`Failed to create directory: ${dirPath}`, {
      path: dirPath,
      error,
    });
  }
}

/**
 * Check if a file exists
 *
 * @param filePath - Absolute path to file
 * @returns True if file exists, false otherwise
 *
 * @example
 * ```typescript
 * const exists = await fileExists('/path/to/file.txt');
 * if (exists) {
 *   console.log('File exists');
 * }
 * ```
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size in bytes
 *
 * @param filePath - Absolute path to file
 * @returns File size in bytes
 * @throws {FileSystemError} If file doesn't exist or stat fails
 *
 * @example
 * ```typescript
 * const size = await getFileSize('/path/to/model.gguf');
 * console.log(`File size: ${size} bytes`);
 * ```
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch (error) {
    throw new FileSystemError(`Failed to get file size: ${filePath}`, {
      path: filePath,
      error,
    });
  }
}

/**
 * Delete a file
 *
 * @param filePath - Absolute path to file
 * @throws {FileSystemError} If deletion fails
 *
 * @example
 * ```typescript
 * await deleteFile('/path/to/file.txt');
 * console.log('File deleted');
 * ```
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    throw new FileSystemError(`Failed to delete file: ${filePath}`, {
      path: filePath,
      error,
    });
  }
}

/**
 * Move a file atomically
 *
 * @param fromPath - Source file path
 * @param toPath - Destination file path
 * @throws {FileSystemError} If move fails
 *
 * @example
 * ```typescript
 * await moveFile('/path/to/source.txt', '/path/to/dest.txt');
 * console.log('File moved');
 * ```
 */
export async function moveFile(fromPath: string, toPath: string): Promise<void> {
  try {
    await rename(fromPath, toPath);
  } catch (error) {
    throw new FileSystemError(`Failed to move file from ${fromPath} to ${toPath}`, {
      fromPath,
      toPath,
      error,
    });
  }
}

/**
 * Copy all contents of a directory to another directory
 *
 * Recursively copies all files and subdirectories from source to destination.
 * Creates the destination directory if it doesn't exist.
 *
 * @param fromDir - Source directory path
 * @param toDir - Destination directory path
 * @throws {FileSystemError} If copy fails
 *
 * @example
 * ```typescript
 * await copyDirectory('/path/to/source', '/path/to/dest');
 * console.log('Directory copied');
 * ```
 */
export async function copyDirectory(fromDir: string, toDir: string): Promise<void> {
  try {
    // Ensure destination directory exists
    await ensureDirectory(toDir);

    // Copy all contents recursively
    await cp(fromDir, toDir, { recursive: true });
  } catch (error) {
    throw new FileSystemError(`Failed to copy directory from ${fromDir} to ${toDir}`, {
      fromPath: fromDir,
      toPath: toDir,
      error,
    });
  }
}

/**
 * Calculate SHA256 checksum of a file
 *
 * @param filePath - Absolute path to file
 * @returns SHA256 checksum as hex string
 * @throws {FileSystemError} If checksum calculation fails
 *
 * @example
 * ```typescript
 * const checksum = await calculateChecksum('/path/to/model.gguf');
 * console.log(`SHA256: ${checksum}`);
 * ```
 */
export async function calculateChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (error) => {
      reject(
        new FileSystemError(`Failed to calculate checksum: ${filePath}`, {
          path: filePath,
          error,
        })
      );
    });
  });
}

/**
 * Format bytes as human-readable string
 *
 * @param bytes - Number of bytes
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string (e.g., "1.5 GB")
 *
 * @example
 * ```typescript
 * const size = formatBytes(1536000000);
 * console.log(size); // "1.54 GB"
 * ```
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Check if a path is absolute
 *
 * @param filePath - Path to check
 * @returns True if path is absolute
 *
 * @example
 * ```typescript
 * const isAbs = isAbsolutePath('/usr/local/bin');
 * console.log(isAbs); // true
 * ```
 */
export function isAbsolutePath(filePath: string): boolean {
  // Unix-style absolute path
  if (filePath.startsWith('/')) return true;

  // Windows-style absolute path (e.g., C:\, D:\)
  if (/^[A-Za-z]:[/\\]/.test(filePath)) return true;

  return false;
}

/**
 * Sanitize filename by removing invalid characters
 *
 * @param filename - Filename to sanitize
 * @returns Sanitized filename
 *
 * @example
 * ```typescript
 * const safe = sanitizeFilename('My Model: v1.0 (Q4)');
 * console.log(safe); // "My Model v1.0 Q4"
 * ```
 */
export function sanitizeFilename(filename: string): string {
  // Remove invalid characters for all platforms
  return (
    filename
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Invalid Windows chars (includes control chars)
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
  );
}
