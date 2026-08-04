/**
 * Electron-free LLM calibration policy metadata.
 *
 * Import this entry from plain Node processes that must inspect the persisted-policy identifier
 * without loading Electron-backed managers from the package root.
 *
 * @module genai-electron/llm-calibration-policy
 */

export { LLAMA_CALIBRATION_DEFAULTS } from './config/defaults.js';
