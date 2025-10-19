/**
 * llama.cpp Log Parser
 *
 * Parses llama.cpp server logs to determine actual log levels.
 * llama.cpp logs everything to stderr with [ERROR] markers, but most
 * are not actual errors. This module intelligently categorizes log lines.
 *
 * @module process/llama-log-parser
 */

import type { LogLevel } from './log-manager.js';

/**
 * Parse llama.cpp log line and determine actual log level
 *
 * llama.cpp logs everything to stderr with [ERROR] markers, but most
 * are not actual errors. This function interprets the content to assign
 * appropriate log levels.
 *
 * @param line - Raw log line from llama-server stderr
 * @returns Appropriate log level based on content
 *
 * @example
 * ```typescript
 * // HTTP 200 request
 * parseLlamaCppLogLevel('srv log_server_r: request: GET /health 127.0.0.1 200')
 * // Returns: 'info'
 *
 * // Slot operation
 * parseLlamaCppLogLevel('slot update_slots: id 7 | task 0 | new prompt')
 * // Returns: 'debug'
 *
 * // Actual error
 * parseLlamaCppLogLevel('Failed to load model: file not found')
 * // Returns: 'error'
 * ```
 */
export function parseLlamaCppLogLevel(line: string): LogLevel {
  const lowerLine = line.toLowerCase();

  // Filter out Jinja template dumps (startup noise)
  // These are verbose template code snippets that clutter logs
  if (
    lowerLine.includes('{%') ||
    lowerLine.includes('{{') ||
    lowerLine.includes('example_format:')
  ) {
    return 'debug';
  }

  // HTTP requests with 2xx status are successful operations
  if (lowerLine.includes('request:') && /\s2\d{2}(\s|$)/.test(lowerLine)) {
    return 'info';
  }

  // HTTP requests with 4xx/5xx are errors
  if (lowerLine.includes('request:') && /\s[45]\d{2}(\s|$)/.test(lowerLine)) {
    return 'error';
  }

  // Slot operations are internal state management (verbose)
  // These track request processing but aren't user-relevant
  if (
    lowerLine.includes('slot') &&
    (lowerLine.includes('update_slots') ||
      lowerLine.includes('launch_slot') ||
      lowerLine.includes('release') ||
      lowerLine.includes('get_availabl') ||
      lowerLine.includes('print_timing'))
  ) {
    return 'debug';
  }

  // Server lifecycle events (informational)
  if (
    lowerLine.includes('server is listening') ||
    lowerLine.includes('all slots are idle') ||
    lowerLine.includes('main:') ||
    lowerLine.includes('params_from_')
  ) {
    return 'info';
  }

  // Actual errors (failures, exceptions)
  if (
    lowerLine.includes('failed') ||
    lowerLine.includes('error:') ||
    lowerLine.includes('exception') ||
    lowerLine.includes('fatal')
  ) {
    return 'error';
  }

  // Warnings
  if (lowerLine.includes('warn')) {
    return 'warn';
  }

  // Default: treat as info
  // llama.cpp marks everything as [ERROR], so we default to info
  // for lines that don't match specific patterns
  return 'info';
}

/**
 * Check if log line should be filtered out based on log level preferences
 *
 * @param line - Raw log line from llama-server
 * @param includeDebug - Whether to include debug-level logs
 * @returns True if the log should be filtered out (not shown)
 *
 * @example
 * ```typescript
 * // Template code with debug disabled
 * shouldFilterLlamaCppLog('{%- set foo = bar %}', false)
 * // Returns: true (filter out)
 *
 * // Template code with debug enabled
 * shouldFilterLlamaCppLog('{%- set foo = bar %}', true)
 * // Returns: false (show it)
 *
 * // Important info always shown
 * shouldFilterLlamaCppLog('Server is listening on port 8080', false)
 * // Returns: false (show it)
 * ```
 */
export function shouldFilterLlamaCppLog(line: string, includeDebug: boolean): boolean {
  const level = parseLlamaCppLogLevel(line);

  // Filter out debug logs if not requested
  if (level === 'debug' && !includeDebug) {
    return true;
  }

  return false;
}

/**
 * Strip llama.cpp's timestamp and level prefix from log line
 *
 * llama.cpp logs include their own formatting with timestamp and level.
 * We strip these to avoid duplicate timestamps when LogManager adds its own.
 *
 * Note: Current llama.cpp versions output plain text without brackets,
 * so this function typically returns the input unchanged. However, we
 * keep the stripping logic for compatibility with different llama.cpp
 * versions or future changes.
 *
 * @param line - Raw log line from llama-server
 * @returns Clean message without llama.cpp's timestamp/level prefix
 *
 * @example
 * ```typescript
 * // llama.cpp formatted log (older versions)
 * stripLlamaCppFormatting('[2025-10-17T12:26:20.354Z] [ERROR] slot release: id 7')
 * // Returns: 'slot release: id 7'
 *
 * // Plain text (current llama.cpp)
 * stripLlamaCppFormatting('srv  log_server_r: request: GET /health 200')
 * // Returns: 'srv  log_server_r: request: GET /health 200'
 * ```
 */
export function stripLlamaCppFormatting(line: string): string {
  // Try multiple patterns to handle different llama.cpp versions

  // Pattern 1: Standard format - [timestamp] [LEVEL] message
  const pattern1 = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+)$/;
  const match1 = line.match(pattern1);
  if (match1 && match1[3]) {
    return match1[3].trim();
  }

  // Pattern 2: Relaxed spacing - handles extra spaces/tabs
  const pattern2 = /^\[\s*([^\]]+?)\s*\]\s*\[\s*([^\]]+?)\s*\]\s*(.+)$/;
  const match2 = line.match(pattern2);
  if (match2 && match2[3]) {
    return match2[3].trim();
  }

  // Pattern 3: With possible prefix before brackets
  const pattern3 = /^.*?\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+)$/;
  const match3 = line.match(pattern3);
  if (match3 && match3[3]) {
    return match3[3].trim();
  }

  // Pattern 4: Just timestamp in brackets, no level tag
  const pattern4 = /^\[([^\]]+)\]\s*(.+)$/;
  const match4 = line.match(pattern4);
  if (match4 && match4[2]) {
    return match4[2].trim();
  }

  // No pattern matched - return original line
  // (This is normal for current llama.cpp versions that output plain text)
  return line;
}
