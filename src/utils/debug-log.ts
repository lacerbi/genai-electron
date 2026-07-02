/**
 * Internal debug logging, gated by the GENAI_ELECTRON_DEBUG environment variable.
 *
 * Verbose diagnostic traces (auto-configuration decisions, resource-orchestration
 * steps) are silent by default; set GENAI_ELECTRON_DEBUG=1 to enable them.
 * Actionable problems should use console.warn/console.error directly instead.
 *
 * @module utils/debug-log
 */

/**
 * Whether debug logging is enabled (GENAI_ELECTRON_DEBUG set to a truthy value)
 */
export function isDebugEnabled(): boolean {
  const value = process.env.GENAI_ELECTRON_DEBUG;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * Log a debug message when GENAI_ELECTRON_DEBUG is enabled
 *
 * @param args - Values to log (same signature as console.log)
 *
 * @example
 * ```typescript
 * debugLog('[LlamaServer] Final config:', JSON.stringify(config));
 * ```
 */
export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}
