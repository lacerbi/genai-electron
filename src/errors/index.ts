/**
 * Custom error classes for genai-electron
 * @module errors
 */

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
    super(
      `Model not found: ${modelId}`,
      'MODEL_NOT_FOUND',
      {
        modelId,
        suggestion: 'Use modelManager.listModels() to see available models',
      }
    );
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
    super(
      `Download failed: ${message}`,
      'DOWNLOAD_FAILED',
      details
    );
    this.name = 'DownloadError';
  }
}

/**
 * Thrown when system resources are insufficient to perform an operation
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
export class InsufficientResourcesError extends GenaiElectronError {
  constructor(
    message: string,
    details: {
      required: string;
      available: string;
      suggestion?: string;
    }
  ) {
    super(
      message,
      'INSUFFICIENT_RESOURCES',
      details
    );
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
    super(
      `Server error: ${message}`,
      'SERVER_ERROR',
      details
    );
    this.name = 'ServerError';
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
    super(
      `Port ${port} is already in use`,
      'PORT_IN_USE',
      {
        port,
        suggestion: `Choose a different port or stop the process using port ${port}`,
      }
    );
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
    super(
      `File system error: ${message}`,
      'FILE_SYSTEM_ERROR',
      details
    );
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
    super(
      `Checksum verification failed: ${message}`,
      'CHECKSUM_ERROR',
      {
        ...details,
        suggestion: 'The downloaded file may be corrupted. Try downloading again.',
      }
    );
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
    super(
      `Binary error: ${message}`,
      'BINARY_ERROR',
      details
    );
    this.name = 'BinaryError';
  }
}
