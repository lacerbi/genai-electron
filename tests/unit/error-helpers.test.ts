/**
 * Tests for error-helpers utility
 */

import { describe, it, expect } from '@jest/globals';
import { formatErrorForUI } from '../../src/utils/error-helpers.js';
import type { UIErrorFormat } from '../../src/utils/error-helpers.js';
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
} from '../../src/errors/index.js';

describe('error-helpers', () => {
  describe('formatErrorForUI', () => {
    it('should format ModelNotFoundError correctly', () => {
      const error = new ModelNotFoundError('llama-2-7b');
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('MODEL_NOT_FOUND');
      expect(formatted.title).toBe('Model Not Found');
      expect(formatted.message).toContain('llama-2-7b');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('listModels');
    });

    it('should format DownloadError correctly', () => {
      const error = new DownloadError('Network timeout', { url: 'https://example.com/model.gguf' });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('DOWNLOAD_FAILED');
      expect(formatted.title).toBe('Download Failed');
      expect(formatted.message).toContain('Network timeout');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('internet connection');
    });

    it('should format InsufficientResourcesError correctly', () => {
      const error = new InsufficientResourcesError('Not enough RAM', {
        required: '8GB',
        available: '4GB',
        suggestion: 'Try a smaller model',
      });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('INSUFFICIENT_RESOURCES');
      expect(formatted.title).toBe('Not Enough Resources');
      expect(formatted.message).toContain('Not enough RAM');
      expect(formatted.remediation).toBe('Try a smaller model');
    });

    it('should format InsufficientResourcesError with default remediation', () => {
      const error = new InsufficientResourcesError('Not enough RAM', {
        required: '8GB',
        available: '4GB',
      });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('INSUFFICIENT_RESOURCES');
      expect(formatted.title).toBe('Not Enough Resources');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('closing other applications');
    });

    it('should format PortInUseError correctly', () => {
      const error = new PortInUseError(8080);
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('PORT_IN_USE');
      expect(formatted.title).toBe('Port Already In Use');
      expect(formatted.message).toContain('8080');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('8080');
    });

    it('should format ServerError correctly', () => {
      const error = new ServerError('Failed to start server', { exitCode: 1 });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('SERVER_ERROR');
      expect(formatted.title).toBe('Server Error');
      expect(formatted.message).toContain('Failed to start server');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('logs');
    });

    it('should format FileSystemError correctly', () => {
      const error = new FileSystemError('Permission denied', { path: '/foo/bar', errno: -13 });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('FILE_SYSTEM_ERROR');
      expect(formatted.title).toBe('File System Error');
      expect(formatted.message).toContain('Permission denied');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('permissions');
    });

    it('should format ChecksumError correctly', () => {
      const error = new ChecksumError('SHA256 mismatch', {
        expected: 'abc123',
        actual: 'def456',
      });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('CHECKSUM_ERROR');
      expect(formatted.title).toBe('Checksum Verification Failed');
      expect(formatted.message).toContain('SHA256 mismatch');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('corrupted');
    });

    it('should format BinaryError correctly', () => {
      const error = new BinaryError('llama-server not found', { binaryPath: '/path/to/binary' });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('BINARY_ERROR');
      expect(formatted.title).toBe('Binary Error');
      expect(formatted.message).toContain('llama-server not found');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('binary');
    });

    it('should format generic GenaiElectronError correctly', () => {
      const error = new GenaiElectronError('Something went wrong', 'CUSTOM_ERROR', {
        suggestion: 'Try restarting',
      });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('CUSTOM_ERROR');
      expect(formatted.title).toBe('Operation Failed');
      expect(formatted.message).toBe('Something went wrong');
      expect(formatted.remediation).toBe('Try restarting');
    });

    it('should format generic GenaiElectronError without suggestion', () => {
      const error = new GenaiElectronError('Something went wrong', 'CUSTOM_ERROR');
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('CUSTOM_ERROR');
      expect(formatted.title).toBe('Operation Failed');
      expect(formatted.message).toBe('Something went wrong');
      expect(formatted.remediation).toBeUndefined();
    });

    it('should format standard Error correctly', () => {
      const error = new Error('Standard error message');
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('Standard error message');
      expect(formatted.remediation).toBeDefined();
      expect(formatted.remediation).toContain('try again');
    });

    it('should format standard Error without message correctly', () => {
      const error = new Error();
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('An unexpected error occurred.');
      expect(formatted.remediation).toBeDefined();
    });

    it('should format string error correctly', () => {
      const formatted = formatErrorForUI('Something went wrong');

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('Something went wrong');
      expect(formatted.remediation).toBeDefined();
    });

    it('should format null error correctly', () => {
      const formatted = formatErrorForUI(null);

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('An unexpected error occurred.');
      expect(formatted.remediation).toBeDefined();
    });

    it('should format undefined error correctly', () => {
      const formatted = formatErrorForUI(undefined);

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('An unexpected error occurred.');
      expect(formatted.remediation).toBeDefined();
    });

    it('should format number error correctly', () => {
      const formatted = formatErrorForUI(42);

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('42');
      expect(formatted.remediation).toBeDefined();
    });

    it('should format object error correctly', () => {
      const formatted = formatErrorForUI({ some: 'object' });

      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.title).toBe('Unknown Error');
      expect(formatted.message).toBe('[object Object]');
      expect(formatted.remediation).toBeDefined();
    });

    it('should return UIErrorFormat with all required fields', () => {
      const error = new ModelNotFoundError('test-model');
      const formatted = formatErrorForUI(error);

      // Type check - should have all UIErrorFormat fields
      expect(formatted).toHaveProperty('code');
      expect(formatted).toHaveProperty('title');
      expect(formatted).toHaveProperty('message');
      expect(formatted).toHaveProperty('remediation');

      // Check types
      expect(typeof formatted.code).toBe('string');
      expect(typeof formatted.title).toBe('string');
      expect(typeof formatted.message).toBe('string');
      if (formatted.remediation !== undefined) {
        expect(typeof formatted.remediation).toBe('string');
      }
    });

    it('should preserve error codes from library errors', () => {
      const errors = [
        new ModelNotFoundError('test'),
        new DownloadError('test'),
        new InsufficientResourcesError('test', {
          required: '8GB',
          available: '4GB',
        }),
        new ServerError('test'),
        new PortInUseError(8080),
        new FileSystemError('test'),
        new ChecksumError('test', { expected: 'abc', actual: 'def' }),
        new BinaryError('test'),
      ];

      const expectedCodes = [
        'MODEL_NOT_FOUND',
        'DOWNLOAD_FAILED',
        'INSUFFICIENT_RESOURCES',
        'SERVER_ERROR',
        'PORT_IN_USE',
        'FILE_SYSTEM_ERROR',
        'CHECKSUM_ERROR',
        'BINARY_ERROR',
      ];

      errors.forEach((error, index) => {
        const formatted = formatErrorForUI(error);
        expect(formatted.code).toBe(expectedCodes[index]);
      });
    });

    it('should provide helpful remediation for all error types', () => {
      const errors = [
        new ModelNotFoundError('test'),
        new DownloadError('test'),
        new InsufficientResourcesError('test', {
          required: '8GB',
          available: '4GB',
        }),
        new ServerError('test'),
        new PortInUseError(8080),
        new FileSystemError('test'),
        new ChecksumError('test', { expected: 'abc', actual: 'def' }),
        new BinaryError('test'),
        new Error('test'),
      ];

      errors.forEach((error) => {
        const formatted = formatErrorForUI(error);
        expect(formatted.remediation).toBeDefined();
        expect(formatted.remediation).not.toBe('');
        expect((formatted.remediation as string).length).toBeGreaterThan(10);
      });
    });

    it('should handle error with custom details field structure', () => {
      const error = new GenaiElectronError('Test error', 'TEST_CODE', {
        customField: 'custom value',
        suggestion: 'Custom suggestion',
      });
      const formatted = formatErrorForUI(error);

      expect(formatted.code).toBe('TEST_CODE');
      expect(formatted.remediation).toBe('Custom suggestion');
    });
  });
});
