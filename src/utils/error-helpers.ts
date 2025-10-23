/**
 * Error handling and formatting utilities
 * @module utils/error-helpers
 */

import {
  GenaiElectronError,
  ModelNotFoundError,
  DownloadError,
  InsufficientResourcesError,
  ServerError,
  PortInUseError,
  FileSystemError,
  ChecksumError,
  BinaryError,
} from '../errors/index.js';

/**
 * UI-friendly error format
 *
 * Structured error information suitable for displaying to end users.
 */
export interface UIErrorFormat {
  /** Error code for programmatic handling */
  code: string;

  /** Short, human-readable error title */
  title: string;

  /** Detailed error message explaining what went wrong */
  message: string;

  /** Optional suggested remediation steps */
  remediation?: string;
}

/**
 * Format an error for display in UI
 *
 * Converts library error classes into a consistent, user-friendly format with
 * clear titles, messages, and actionable remediation steps.
 *
 * This eliminates the need for brittle substring matching on error messages
 * and provides a consistent error experience across applications.
 *
 * @param error - Error to format (any type)
 * @returns Formatted error with code, title, message, and optional remediation
 *
 * @example
 * ```typescript
 * import { formatErrorForUI } from 'genai-electron';
 *
 * try {
 *   await llamaServer.start(config);
 * } catch (error) {
 *   const formatted = formatErrorForUI(error);
 *   console.error(`${formatted.title}: ${formatted.message}`);
 *   if (formatted.remediation) {
 *     console.log('Suggestion:', formatted.remediation);
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // In IPC handler
 * ipcMain.handle('server:start', async (_event, config) => {
 *   try {
 *     await llamaServer.start(config);
 *   } catch (error) {
 *     const formatted = formatErrorForUI(error);
 *     throw new Error(`${formatted.title}: ${formatted.message}`);
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Handling specific error codes
 * try {
 *   await modelManager.downloadModel(config);
 * } catch (error) {
 *   const formatted = formatErrorForUI(error);
 *
 *   switch (formatted.code) {
 *     case 'INSUFFICIENT_RESOURCES':
 *       // Show disk space warning
 *       break;
 *     case 'DOWNLOAD_FAILED':
 *       // Retry download
 *       break;
 *     default:
 *       // Generic error handling
 *       break;
 *   }
 * }
 * ```
 */
export function formatErrorForUI(error: unknown): UIErrorFormat {
  // Handle ModelNotFoundError
  if (error instanceof ModelNotFoundError) {
    return {
      code: error.code,
      title: 'Model Not Found',
      message: error.message,
      remediation:
        (error.details as { suggestion?: string })?.suggestion ||
        'Check that the model ID is correct and the model has been downloaded.',
    };
  }

  // Handle DownloadError
  if (error instanceof DownloadError) {
    return {
      code: error.code,
      title: 'Download Failed',
      message: error.message,
      remediation:
        'Check your internet connection and try again. If the problem persists, verify the download URL is correct.',
    };
  }

  // Handle InsufficientResourcesError
  if (error instanceof InsufficientResourcesError) {
    const details = error.details as {
      required?: string;
      available?: string;
      suggestion?: string;
    };
    return {
      code: error.code,
      title: 'Not Enough Resources',
      message: error.message,
      remediation:
        details?.suggestion ||
        'Try closing other applications to free up resources, or use a smaller model.',
    };
  }

  // Handle PortInUseError
  if (error instanceof PortInUseError) {
    return {
      code: error.code,
      title: 'Port Already In Use',
      message: error.message,
      remediation:
        (error.details as { suggestion?: string })?.suggestion ||
        'Choose a different port or stop the application using this port.',
    };
  }

  // Handle ServerError
  if (error instanceof ServerError) {
    return {
      code: error.code,
      title: 'Server Error',
      message: error.message,
      remediation:
        'Check the server logs for more details. The server may need to be restarted.',
    };
  }

  // Handle FileSystemError
  if (error instanceof FileSystemError) {
    return {
      code: error.code,
      title: 'File System Error',
      message: error.message,
      remediation:
        'Check that you have sufficient permissions and disk space, then try again.',
    };
  }

  // Handle ChecksumError
  if (error instanceof ChecksumError) {
    return {
      code: error.code,
      title: 'Checksum Verification Failed',
      message: error.message,
      remediation:
        (error.details as { suggestion?: string })?.suggestion ||
        'The downloaded file may be corrupted. Try downloading again.',
    };
  }

  // Handle BinaryError
  if (error instanceof BinaryError) {
    return {
      code: error.code,
      title: 'Binary Error',
      message: error.message,
      remediation:
        'The binary may be missing or corrupted. Try restarting the application to trigger a fresh download.',
    };
  }

  // Handle generic GenaiElectronError
  if (error instanceof GenaiElectronError) {
    return {
      code: error.code,
      title: 'Operation Failed',
      message: error.message,
      remediation: (error.details as { suggestion?: string })?.suggestion,
    };
  }

  // Handle standard Error objects
  if (error instanceof Error) {
    return {
      code: 'UNKNOWN_ERROR',
      title: 'Unknown Error',
      message: error.message || 'An unexpected error occurred.',
      remediation: 'Please try again. If the problem persists, check the logs for more details.',
    };
  }

  // Handle unknown error types (null, undefined, etc.)
  const errorString = error != null ? String(error) : '';
  return {
    code: 'UNKNOWN_ERROR',
    title: 'Unknown Error',
    message: errorString || 'An unexpected error occurred.',
    remediation: 'Please try again. If the problem persists, check the logs for more details.',
  };
}
