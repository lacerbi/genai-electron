/**
 * Unit tests for platform-utils
 * Tests platform detection utilities
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Store original process values
const originalPlatform = process.platform;
const originalArch = process.arch;

// Import platform-utils
const { getPlatform, getArchitecture, getPlatformKey, isMac, isWindows, isLinux, isAppleSilicon } =
  await import('../../src/utils/platform-utils.js');

describe('platform-utils', () => {
  // Helper to mock process.platform
  function mockProcessPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  // Helper to mock process.arch
  function mockProcessArch(arch: string) {
    Object.defineProperty(process, 'arch', {
      value: arch,
      configurable: true,
    });
  }

  afterEach(() => {
    // Restore original values
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch,
      configurable: true,
    });
  });

  describe('getPlatform()', () => {
    it('should return darwin for macOS', () => {
      mockProcessPlatform('darwin');
      expect(getPlatform()).toBe('darwin');
    });

    it('should return win32 for Windows', () => {
      mockProcessPlatform('win32');
      expect(getPlatform()).toBe('win32');
    });

    it('should return linux for Linux', () => {
      mockProcessPlatform('linux');
      expect(getPlatform()).toBe('linux');
    });
  });

  describe('getArchitecture()', () => {
    it('should return x64 for 64-bit Intel/AMD', () => {
      mockProcessArch('x64');
      expect(getArchitecture()).toBe('x64');
    });

    it('should return arm64 for ARM 64-bit', () => {
      mockProcessArch('arm64');
      expect(getArchitecture()).toBe('arm64');
    });

    it('should return ia32 for 32-bit Intel', () => {
      mockProcessArch('ia32');
      expect(getArchitecture()).toBe('ia32');
    });
  });

  describe('getPlatformKey()', () => {
    it('should return darwin-arm64 for Apple Silicon', () => {
      mockProcessPlatform('darwin');
      mockProcessArch('arm64');
      expect(getPlatformKey()).toBe('darwin-arm64');
    });

    it('should return darwin-x64 for Intel Mac', () => {
      mockProcessPlatform('darwin');
      mockProcessArch('x64');
      expect(getPlatformKey()).toBe('darwin-x64');
    });

    it('should return win32-x64 for Windows 64-bit', () => {
      mockProcessPlatform('win32');
      mockProcessArch('x64');
      expect(getPlatformKey()).toBe('win32-x64');
    });

    it('should return linux-x64 for Linux 64-bit', () => {
      mockProcessPlatform('linux');
      mockProcessArch('x64');
      expect(getPlatformKey()).toBe('linux-x64');
    });
  });

  describe('isMac()', () => {
    it('should return true on macOS', () => {
      mockProcessPlatform('darwin');
      expect(isMac()).toBe(true);
    });

    it('should return false on other platforms', () => {
      mockProcessPlatform('win32');
      expect(isMac()).toBe(false);

      mockProcessPlatform('linux');
      expect(isMac()).toBe(false);
    });
  });

  describe('isWindows()', () => {
    it('should return true on Windows', () => {
      mockProcessPlatform('win32');
      expect(isWindows()).toBe(true);
    });

    it('should return false on other platforms', () => {
      mockProcessPlatform('darwin');
      expect(isWindows()).toBe(false);

      mockProcessPlatform('linux');
      expect(isWindows()).toBe(false);
    });
  });

  describe('isLinux()', () => {
    it('should return true on Linux', () => {
      mockProcessPlatform('linux');
      expect(isLinux()).toBe(true);
    });

    it('should return false on other platforms', () => {
      mockProcessPlatform('darwin');
      expect(isLinux()).toBe(false);

      mockProcessPlatform('win32');
      expect(isLinux()).toBe(false);
    });
  });

  describe('isAppleSilicon()', () => {
    it('should return true for macOS ARM64', () => {
      mockProcessPlatform('darwin');
      mockProcessArch('arm64');
      expect(isAppleSilicon()).toBe(true);
    });

    it('should return false for Intel Mac', () => {
      mockProcessPlatform('darwin');
      mockProcessArch('x64');
      expect(isAppleSilicon()).toBe(false);
    });

    it('should return false for non-macOS platforms', () => {
      mockProcessPlatform('win32');
      mockProcessArch('arm64');
      expect(isAppleSilicon()).toBe(false);

      mockProcessPlatform('linux');
      mockProcessArch('arm64');
      expect(isAppleSilicon()).toBe(false);
    });
  });
});
