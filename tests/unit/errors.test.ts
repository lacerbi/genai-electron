/**
 * Unit tests for error classes
 * Tests custom error types
 */

import { describe, it, expect } from '@jest/globals';
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

describe('Error Classes', () => {
  describe('GenaiElectronError', () => {
    it('should create error with message and code', () => {
      const error = new GenaiElectronError('Test error', 'TEST_ERROR');

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_ERROR');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(GenaiElectronError);
    });

    it('should include details', () => {
      const details = { foo: 'bar' };
      const error = new GenaiElectronError('Test error', 'TEST_ERROR', details);

      expect(error.details).toEqual(details);
    });

    it('should have proper stack trace', () => {
      const error = new GenaiElectronError('Test error', 'TEST_ERROR');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('GenaiElectronError');
    });
  });

  describe('ModelNotFoundError', () => {
    it('should create error with model ID', () => {
      const error = new ModelNotFoundError('test-model');

      expect(error.message).toContain('test-model');
      expect(error.code).toBe('MODEL_NOT_FOUND');
      expect(error).toBeInstanceOf(GenaiElectronError);
    });
  });

  describe('DownloadError', () => {
    it('should create error with message', () => {
      const error = new DownloadError('Download failed');

      expect(error.message).toContain('Download failed');
      expect(error.code).toBe('DOWNLOAD_FAILED');
      expect(error).toBeInstanceOf(GenaiElectronError);
    });

    it('should include details', () => {
      const details = { url: 'https://example.com', statusCode: 404 };
      const error = new DownloadError('Download failed', details);

      expect(error.details).toEqual(details);
    });
  });

  describe('InsufficientResourcesError', () => {
    it('should create error with resource info', () => {
      const error = new InsufficientResourcesError('Not enough RAM', {
        required: '8GB',
        available: '4GB',
        suggestion: 'Close some applications',
      });

      expect(error.message).toContain('Not enough RAM');
      expect(error.code).toBe('INSUFFICIENT_RESOURCES');
      expect(error.details).toEqual({
        required: '8GB',
        available: '4GB',
        suggestion: 'Close some applications',
      });
    });
  });

  describe('ServerError', () => {
    it('should create error with message', () => {
      const error = new ServerError('Server failed to start');

      expect(error.message).toContain('Server failed to start');
      expect(error.code).toBe('SERVER_ERROR');
      expect(error).toBeInstanceOf(GenaiElectronError);
    });
  });

  describe('PortInUseError', () => {
    it('should create error with port number', () => {
      const error = new PortInUseError(8080);

      expect(error.message).toContain('8080');
      expect(error.code).toBe('PORT_IN_USE');
      expect(error.details).toHaveProperty('port', 8080);
      expect(error.details).toHaveProperty('suggestion');
    });
  });

  describe('FileSystemError', () => {
    it('should create error with message and details', () => {
      const error = new FileSystemError('Failed to write file', {
        path: '/test/path',
        operation: 'write',
      });

      expect(error.message).toContain('Failed to write file');
      expect(error.code).toBe('FILE_SYSTEM_ERROR');
      expect(error.details).toHaveProperty('path', '/test/path');
      expect(error.details).toHaveProperty('operation', 'write');
    });
  });

  describe('ChecksumError', () => {
    it('should create error with expected and actual checksums', () => {
      const error = new ChecksumError('SHA256 mismatch', {
        expected: 'sha256:abc123',
        actual: 'sha256:def456',
      });

      expect(error.message).toContain('SHA256 mismatch');
      expect(error.code).toBe('CHECKSUM_ERROR');
      expect(error.details).toHaveProperty('expected', 'sha256:abc123');
      expect(error.details).toHaveProperty('actual', 'sha256:def456');
      expect(error.details).toHaveProperty('suggestion');
    });
  });

  describe('BinaryError', () => {
    it('should create error with message', () => {
      const error = new BinaryError('Binary not found');

      expect(error.message).toContain('Binary not found');
      expect(error.code).toBe('BINARY_ERROR');
      expect(error).toBeInstanceOf(GenaiElectronError);
    });
  });

  describe('Error inheritance', () => {
    it('should maintain instanceof chain', () => {
      const modelError = new ModelNotFoundError('test');
      const downloadError = new DownloadError('test');
      const resourceError = new InsufficientResourcesError('test', {
        required: '8GB',
        available: '4GB',
      });

      expect(modelError).toBeInstanceOf(GenaiElectronError);
      expect(modelError).toBeInstanceOf(Error);

      expect(downloadError).toBeInstanceOf(GenaiElectronError);
      expect(downloadError).toBeInstanceOf(Error);

      expect(resourceError).toBeInstanceOf(GenaiElectronError);
      expect(resourceError).toBeInstanceOf(Error);
    });

    it('should be catchable as GenaiElectronError', () => {
      try {
        throw new ModelNotFoundError('test');
      } catch (error) {
        expect(error).toBeInstanceOf(GenaiElectronError);
        expect((error as GenaiElectronError).code).toBe('MODEL_NOT_FOUND');
      }
    });
  });
});
