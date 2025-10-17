/**
 * llama.cpp Log Parser
 *
 * Parses llama.cpp server logs to determine actual log levels.
 * llama.cpp logs everything to stderr with [ERROR] markers, but most
 * are not actual errors. This module intelligently categorizes log lines.
 *
 * @module process/llama-log-parser
 */

import { LogLevel } from './log-manager.js';

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
