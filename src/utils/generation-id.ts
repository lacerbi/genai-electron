/**
 * Generates a unique ID for image generation jobs.
 *
 * Format: gen_{timestamp}_{random}
 * Example: gen_1729612345678_x7k2p9q4m
 *
 * @returns A unique generation ID
 */
export function generateId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 11);
  return `gen_${timestamp}_${random}`;
}
