/**
 * Custom error classes for genai-electron
 * @module errors
 */

import type { LlamaCalibrationResourceFailurePartialReport } from '../types/llm-calibration.js';

/**
 * Base error class for all genai-electron errors
 *
 * @example
 * ```typescript
 * throw new GenaiElectronError('Something went wrong', 'GENERIC_ERROR', { detail: 'info' });
 * ```
 */
export class GenaiElectronError extends Error {
  /** Error code for programmatic error handling */
  public readonly code: string;

  /** Additional error details */
  public readonly details?: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = 'GenaiElectronError';
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Stage at which a context-capacity contract failed.
 */
export type ContextConstraintStage = 'validation' | 'sizing' | 'runtime';

/**
 * Stable reason values for ContextConstraintError.details.reason.
 */
export type ContextConstraintReason =
  | 'invalid-minimum'
  | 'invalid-preferred'
  | 'invalid-maximum'
  | 'exact-range-conflict'
  | 'minimum-exceeds-preferred'
  | 'preferred-exceeds-maximum'
  | 'minimum-exceeds-maximum'
  | 'unsafe-total-capacity'
  | 'minimum-exceeds-native'
  | 'model-context-unknown'
  | 'fit-range-conflict'
  | 'precomputed-context-out-of-range'
  | 'runtime-capacity-unavailable'
  | 'runtime-slots-mismatch'
  | 'runtime-below-minimum'
  | 'runtime-above-maximum';

/**
 * Structured context-capacity error details for programmatic handling.
 */
export interface ContextConstraintDetails {
  reason: ContextConstraintReason;
  stage: ContextConstraintStage;
  contextSize?: number;
  minimumContextSize?: number;
  preferredContextSize?: number;
  maximumContextSize?: number;
  configuredContextSize?: number;
  effectiveContextSize?: number;
  nativeContextSize?: number;
  parallelRequests?: number;
  effectiveParallelRequests?: number;
  suggestion?: string;
  cause?: string;
}

/**
 * Thrown when a context-capacity contract is invalid or cannot be verified.
 */
export class ContextConstraintError extends GenaiElectronError {
  declare public readonly details: ContextConstraintDetails;

  constructor(message: string, details: ContextConstraintDetails) {
    super(`Context constraint error: ${message}`, 'CONTEXT_CONSTRAINT_ERROR', details);
    this.name = 'ContextConstraintError';
  }
}

/**
 * Thrown when a requested model is not found
 *
 * @example
 * ```typescript
 * throw new ModelNotFoundError('llama-2-7b');
 * // Error: Model not found: llama-2-7b
 * // Suggestion: Use modelManager.listModels() to see available models
 * ```
 */
export class ModelNotFoundError extends GenaiElectronError {
  constructor(modelId: string) {
    super(`Model not found: ${modelId}`, 'MODEL_NOT_FOUND', {
      modelId,
      suggestion: 'Use modelManager.listModels() to see available models',
    });
    this.name = 'ModelNotFoundError';
  }
}

/**
 * Thrown when model download fails
 *
 * @example
 * ```typescript
 * throw new DownloadError('Network timeout', { url: 'https://...', bytesDownloaded: 1024 });
 * ```
 */
export class DownloadError extends GenaiElectronError {
  constructor(message: string, details?: unknown) {
    super(`Download failed: ${message}`, 'DOWNLOAD_FAILED', details);
    this.name = 'DownloadError';
  }
}

/**
 * Structured details for resource-capacity failures.
 *
 * @example
 * ```typescript
 * throw new InsufficientResourcesError(
 *   'Not enough RAM to run this model',
 *   {
 *     required: '8GB',
 *     available: '4GB',
 *     suggestion: 'Try a smaller quantization like Q4_K_M or close other applications'
 *   }
 * );
 * ```
 */
export interface InsufficientResourcesDetails {
  required: string;
  available: string;
  suggestion?: string;
  minimumContextSize?: number;
  preferredContextSize?: number;
  maximumContextSize?: number;
  configuredContextSize?: number;
  maxFeasibleContextSize?: number;
  parallelRequests?: number;
}

/**
 * Thrown when system resources are insufficient to perform an operation.
 */
export class InsufficientResourcesError extends GenaiElectronError {
  declare public readonly details: InsufficientResourcesDetails;

  constructor(message: string, details: InsufficientResourcesDetails) {
    super(message, 'INSUFFICIENT_RESOURCES', details);
    this.name = 'InsufficientResourcesError';
  }
}

/**
 * Thrown when a server operation fails
 *
 * @example
 * ```typescript
 * throw new ServerError('Failed to start server', { pid: 12345, exitCode: 1 });
 * ```
 */
export class ServerError extends GenaiElectronError {
  constructor(message: string, details?: unknown) {
    super(`Server error: ${message}`, 'SERVER_ERROR', details);
    this.name = 'ServerError';
  }
}

/**
 * Details codes for a calibration resource-stability rejection.
 *
 * - `CALIBRATION_RESOURCE_DRIFT` - the same trusted metric stayed outside its band in the
 *   confirmation snapshot, in either direction.
 * - `CALIBRATION_RESOURCE_STABILITY_UNVERIFIED` - a trusted suspicious boundary could not be
 *   resolved: its confirmation reading became untrusted, or a different metric became newly
 *   suspicious. It is never mislabelled confirmed drift.
 */
export type LlamaCalibrationResourceStabilityCode =
  | 'CALIBRATION_RESOURCE_DRIFT'
  | 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED';

/**
 * Fields guaranteed for BOTH variants.
 *
 * Any future field whose presence or shape differs between confirmed drift and
 * stability-unverified belongs on its `code` union arm, not here as an optional common field.
 */
export interface LlamaCalibrationResourceStabilityDetailsCommon {
  partialReport: LlamaCalibrationResourceFailurePartialReport;
  suggestion: string;
}

export type LlamaCalibrationResourceStabilityDetails =
  LlamaCalibrationResourceStabilityDetailsCommon &
    (
      | { code: 'CALIBRATION_RESOURCE_DRIFT' }
      | { code: 'CALIBRATION_RESOURCE_STABILITY_UNVERIFIED' }
    );

/**
 * Thrown when LLM runtime calibration observes that machine conditions either changed materially
 * or could not be verified stable around a launch boundary.
 *
 * Extends {@link ServerError} so existing `instanceof ServerError` handling keeps working, while
 * hosts get one `instanceof` branch followed by a typed `switch (error.details.code)`. Calibration
 * never restarts or re-anchors: the host should ask the user to close heavy work and recalibrate
 * from the beginning.
 *
 * @example
 * ```typescript
 * try {
 *   await llamaServer.calibrate(config);
 * } catch (error) {
 *   if (error instanceof LlamaCalibrationResourceStabilityError) {
 *     console.log(error.details.code, error.details.partialReport.resourceFailure.affectedMetrics);
 *   }
 * }
 * ```
 */
export class LlamaCalibrationResourceStabilityError extends ServerError {
  declare public readonly details: LlamaCalibrationResourceStabilityDetails;

  constructor(message: string, details: LlamaCalibrationResourceStabilityDetails) {
    super(message, details);
    this.name = 'LlamaCalibrationResourceStabilityError';
  }
}

/**
 * Thrown when a requested port is already in use
 *
 * @example
 * ```typescript
 * throw new PortInUseError(8080);
 * // Error: Port 8080 is already in use
 * // Suggestion: Choose a different port or stop the process using port 8080
 * ```
 */
export class PortInUseError extends GenaiElectronError {
  constructor(port: number) {
    super(`Port ${port} is already in use`, 'PORT_IN_USE', {
      port,
      suggestion: `Choose a different port or stop the process using port ${port}`,
    });
    this.name = 'PortInUseError';
  }
}

/**
 * Thrown when a file system operation fails
 *
 * @example
 * ```typescript
 * throw new FileSystemError('Failed to write file', { path: '/path/to/file', errno: -13 });
 * ```
 */
export class FileSystemError extends GenaiElectronError {
  constructor(message: string, details?: unknown) {
    super(`File system error: ${message}`, 'FILE_SYSTEM_ERROR', details);
    this.name = 'FileSystemError';
  }
}

/**
 * Thrown when checksum verification fails
 *
 * @example
 * ```typescript
 * throw new ChecksumError('SHA256 mismatch', { expected: 'abc123', actual: 'def456' });
 * ```
 */
export class ChecksumError extends GenaiElectronError {
  constructor(message: string, details: { expected: string; actual: string }) {
    super(`Checksum verification failed: ${message}`, 'CHECKSUM_ERROR', {
      ...details,
      suggestion: 'The downloaded file may be corrupted. Try downloading again.',
    });
    this.name = 'ChecksumError';
  }
}

/**
 * Thrown when a binary (llama-server, diffusion-cpp) is not found or invalid
 *
 * @example
 * ```typescript
 * throw new BinaryError('llama-server not found', { binaryPath: '/path/to/binary' });
 * ```
 */
export class BinaryError extends GenaiElectronError {
  constructor(message: string, details?: unknown) {
    super(`Binary error: ${message}`, 'BINARY_ERROR', details);
    this.name = 'BinaryError';
  }
}
