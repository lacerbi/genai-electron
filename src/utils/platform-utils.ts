/**
 * Platform detection utilities
 * @module utils/platform-utils
 */

import os from 'node:os';

/**
 * Platform key format: "platform-architecture" (e.g., "darwin-arm64")
 */
export type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64';

/**
 * Get the current platform
 *
 * @returns Platform string (darwin, win32, linux)
 *
 * @example
 * ```typescript
 * const platform = getPlatform();
 * // Returns: "darwin" on macOS, "win32" on Windows, "linux" on Linux
 * ```
 */
export function getPlatform(): NodeJS.Platform {
  return process.platform;
}

/**
 * Get the current architecture
 *
 * @returns Architecture string (x64, arm64, etc.)
 *
 * @example
 * ```typescript
 * const arch = getArchitecture();
 * // Returns: "arm64" on Apple Silicon, "x64" on Intel/AMD
 * ```
 */
export function getArchitecture(): string {
  return process.arch;
}

/**
 * Get the platform key for binary downloads
 * Combines platform and architecture into a single key
 *
 * @returns Platform key (e.g., "darwin-arm64")
 * @throws {Error} If platform/architecture combination is unsupported
 *
 * @example
 * ```typescript
 * const key = getPlatformKey();
 * // Returns: "darwin-arm64" on Apple Silicon Mac
 * ```
 */
export function getPlatformKey(): PlatformKey {
  const platform = getPlatform();
  const arch = getArchitecture();

  const platformKey = `${platform}-${arch}` as PlatformKey;

  // Validate supported platforms
  const supported: PlatformKey[] = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];

  if (!supported.includes(platformKey)) {
    throw new Error(
      `Unsupported platform: ${platformKey}. Supported platforms: ${supported.join(', ')}`
    );
  }

  return platformKey;
}

/**
 * Check if running on macOS
 *
 * @returns True if running on macOS
 *
 * @example
 * ```typescript
 * if (isMac()) {
 *   console.log('Running on macOS');
 * }
 * ```
 */
export function isMac(): boolean {
  return getPlatform() === 'darwin';
}

/**
 * Check if running on Windows
 *
 * @returns True if running on Windows
 *
 * @example
 * ```typescript
 * if (isWindows()) {
 *   console.log('Running on Windows');
 * }
 * ```
 */
export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

/**
 * Check if running on Linux
 *
 * @returns True if running on Linux
 *
 * @example
 * ```typescript
 * if (isLinux()) {
 *   console.log('Running on Linux');
 * }
 * ```
 */
export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

/**
 * Check if running on Apple Silicon
 *
 * @returns True if running on Apple Silicon (M1/M2/M3)
 *
 * @example
 * ```typescript
 * if (isAppleSilicon()) {
 *   console.log('Running on Apple Silicon with Metal support');
 * }
 * ```
 */
export function isAppleSilicon(): boolean {
  return isMac() && getArchitecture() === 'arm64';
}

/**
 * Get a human-readable platform description
 *
 * @returns Platform description string
 *
 * @example
 * ```typescript
 * const desc = getPlatformDescription();
 * // Returns: "macOS (Apple Silicon)" on M1 Mac
 * // Returns: "Windows (x64)" on Windows
 * ```
 */
export function getPlatformDescription(): string {
  const platform = getPlatform();
  const arch = getArchitecture();

  const platformNames: Record<NodeJS.Platform, string> = {
    darwin: 'macOS',
    win32: 'Windows',
    linux: 'Linux',
    // @ts-expect-error - Other platforms are rarely used
    freebsd: 'FreeBSD',
    // @ts-expect-error
    openbsd: 'OpenBSD',
    // @ts-expect-error
    sunos: 'SunOS',
    // @ts-expect-error
    aix: 'AIX',
  };

  const platformName = platformNames[platform] || platform;

  const archDescriptions: Record<string, string> = {
    arm64: isAppleSilicon() ? 'Apple Silicon' : 'ARM64',
    x64: 'x64',
    ia32: 'x86',
  };

  const archDesc = archDescriptions[arch] || arch;

  return `${platformName} (${archDesc})`;
}

/**
 * Get system information summary
 *
 * @returns Object with platform, architecture, and OS details
 *
 * @example
 * ```typescript
 * const info = getSystemInfo();
 * console.log(info);
 * // {
 * //   platform: "darwin",
 * //   architecture: "arm64",
 * //   platformKey: "darwin-arm64",
 * //   description: "macOS (Apple Silicon)",
 * //   osRelease: "23.1.0",
 * //   osType: "Darwin"
 * // }
 * ```
 */
export function getSystemInfo() {
  return {
    platform: getPlatform(),
    architecture: getArchitecture(),
    platformKey: getPlatformKey(),
    description: getPlatformDescription(),
    osRelease: os.release(),
    osType: os.type(),
  };
}
