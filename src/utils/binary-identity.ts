/** Read-only identity for an already provisioned server binary. */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { PATHS } from '../config/paths.js';
import type { LlamaCalibrationBinaryIdentity } from '../types/index.js';
import { calculateChecksum } from './file-utils.js';

/**
 * Fingerprint a provisioned binary using its current bytes and validation
 * cache. This helper never downloads, validates, or mutates the installation.
 */
export async function getInstalledBinaryIdentity(
  type: 'llama' | 'diffusion',
  binaryPath: string,
  pinnedVersion: string
): Promise<LlamaCalibrationBinaryIdentity> {
  const checksum = await calculateChecksum(binaryPath);
  let variant = 'unknown';
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(PATHS.binaries[type], '.validation.json'), 'utf8')
    ) as Record<string, unknown>;
    if (parsed.checksum === checksum && typeof parsed.variant === 'string') {
      variant = parsed.variant;
    }
  } catch {
    // A missing/legacy cache only lowers fingerprint confidence.
  }
  return { version: pinnedVersion, variant, checksum };
}
