/**
 * Unit tests for platform-utils
 * Tests platform detection utilities
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import os from 'os';

// Mock os module
jest.mock('os', () => ({
  platform: jest.fn(),
  arch: jest.fn(),
}));

// Import after mocking
import {
  getPlatform,
  getArchitecture,
  getPlatformKey,
  isMac,
  isWindows,
  isLinux,
  isAppleSilicon,
} from '../../src/utils/platform-utils.js';

describe('platform-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getPlatform()', () => {
    it('should return darwin for macOS', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      expect(getPlatform()).toBe('darwin');
    });

    it('should return win32 for Windows', () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      expect(getPlatform()).toBe('win32');
    });

    it('should return linux for Linux', () => {
      (os.platform as jest.Mock).mockReturnValue('linux');
      expect(getPlatform()).toBe('linux');
    });
  });

  describe('getArchitecture()', () => {
    it('should return x64 for 64-bit Intel/AMD', () => {
      (os.arch as jest.Mock).mockReturnValue('x64');
      expect(getArchitecture()).toBe('x64');
    });

    it('should return arm64 for ARM 64-bit', () => {
      (os.arch as jest.Mock).mockReturnValue('arm64');
      expect(getArchitecture()).toBe('arm64');
    });

    it('should return ia32 for 32-bit Intel', () => {
      (os.arch as jest.Mock).mockReturnValue('ia32');
      expect(getArchitecture()).toBe('ia32');
    });
  });

  describe('getPlatformKey()', () => {
    it('should return darwin-arm64 for Apple Silicon', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      (os.arch as jest.Mock).mockReturnValue('arm64');
      expect(getPlatformKey()).toBe('darwin-arm64');
    });

    it('should return darwin-x64 for Intel Mac', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      (os.arch as jest.Mock).mockReturnValue('x64');
      expect(getPlatformKey()).toBe('darwin-x64');
    });

    it('should return win32-x64 for Windows 64-bit', () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      (os.arch as jest.Mock).mockReturnValue('x64');
      expect(getPlatformKey()).toBe('win32-x64');
    });

    it('should return linux-x64 for Linux 64-bit', () => {
      (os.platform as jest.Mock).mockReturnValue('linux');
      (os.arch as jest.Mock).mockReturnValue('x64');
      expect(getPlatformKey()).toBe('linux-x64');
    });
  });

  describe('isMac()', () => {
    it('should return true on macOS', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      expect(isMac()).toBe(true);
    });

    it('should return false on other platforms', () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      expect(isMac()).toBe(false);

      (os.platform as jest.Mock).mockReturnValue('linux');
      expect(isMac()).toBe(false);
    });
  });

  describe('isWindows()', () => {
    it('should return true on Windows', () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      expect(isWindows()).toBe(true);
    });

    it('should return false on other platforms', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      expect(isWindows()).toBe(false);

      (os.platform as jest.Mock).mockReturnValue('linux');
      expect(isWindows()).toBe(false);
    });
  });

  describe('isLinux()', () => {
    it('should return true on Linux', () => {
      (os.platform as jest.Mock).mockReturnValue('linux');
      expect(isLinux()).toBe(true);
    });

    it('should return false on other platforms', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      expect(isLinux()).toBe(false);

      (os.platform as jest.Mock).mockReturnValue('win32');
      expect(isLinux()).toBe(false);
    });
  });

  describe('isAppleSilicon()', () => {
    it('should return true for macOS ARM64', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      (os.arch as jest.Mock).mockReturnValue('arm64');
      expect(isAppleSilicon()).toBe(true);
    });

    it('should return false for Intel Mac', () => {
      (os.platform as jest.Mock).mockReturnValue('darwin');
      (os.arch as jest.Mock).mockReturnValue('x64');
      expect(isAppleSilicon()).toBe(false);
    });

    it('should return false for non-macOS platforms', () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      (os.arch as jest.Mock).mockReturnValue('arm64');
      expect(isAppleSilicon()).toBe(false);

      (os.platform as jest.Mock).mockReturnValue('linux');
      (os.arch as jest.Mock).mockReturnValue('arm64');
      expect(isAppleSilicon()).toBe(false);
    });
  });
});
