/**
 * Checksum utilities for file verification
 * @module download/checksum
 */

import { calculateChecksum as calculateFileChecksum } from '../utils/file-utils.js';

/**
 * Calculate SHA256 checksum of a file
 * Re-exports the utility function for convenience
 *
 * @param filePath - Absolute path to file
 * @returns SHA256 checksum as hex string
 *
 * @example
 * ```typescript
 * const checksum = await calculateSHA256('/path/to/model.gguf');
 * console.log(`SHA256: ${checksum}`);
 * ```
 */
export async function calculateSHA256(filePath: string): Promise<string> {
  return calculateFileChecksum(filePath);
}

/**
 * Verify file checksum against expected value
 *
 * @param filePath - Absolute path to file
 * @param expectedChecksum - Expected SHA256 checksum (with or without 'sha256:' prefix)
 * @returns True if checksums match
 *
 * @example
 * ```typescript
 * const valid = await verifyChecksum('/path/to/model.gguf', 'sha256:abc123...');
 * if (valid) {
 *   console.log('Checksum verified');
 * }
 * ```
 */
export async function verifyChecksum(
  filePath: string,
  expectedChecksum: string
): Promise<boolean> {
  const actualChecksum = await calculateSHA256(filePath);
  const expected = expectedChecksum.replace(/^sha256:/, ''); // Remove prefix if present

  return actualChecksum === expected;
}

/**
 * Format checksum with 'sha256:' prefix
 *
 * @param checksum - Raw SHA256 checksum hex string
 * @returns Formatted checksum with prefix
 *
 * @example
 * ```typescript
 * const formatted = formatChecksum('abc123def456');
 * console.log(formatted); // 'sha256:abc123def456'
 * ```
 */
export function formatChecksum(checksum: string): string {
  if (checksum.startsWith('sha256:')) {
    return checksum;
  }
  return `sha256:${checksum}`;
}
