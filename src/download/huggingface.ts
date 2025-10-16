/**
 * HuggingFace URL conversion utilities
 * @module download/huggingface
 */

/**
 * Convert HuggingFace repository and file to direct download URL
 *
 * @param repo - Repository name (e.g., "TheBloke/Llama-2-7B-GGUF")
 * @param file - File name (e.g., "llama-2-7b.Q4_K_M.gguf")
 * @returns Direct download URL
 *
 * @example
 * ```typescript
 * const url = getHuggingFaceURL('TheBloke/Llama-2-7B-GGUF', 'llama-2-7b.Q4_K_M.gguf');
 * console.log(url);
 * // https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf
 * ```
 */
export function getHuggingFaceURL(repo: string, file: string): string {
  // Encode the file name for URL
  const encodedFile = encodeURIComponent(file);

  // Construct the direct download URL
  return `https://huggingface.co/${repo}/resolve/main/${encodedFile}`;
}

/**
 * Parse HuggingFace URL to extract repository and file name
 *
 * @param url - HuggingFace URL
 * @returns Object with repo and file, or null if not a valid HuggingFace URL
 *
 * @example
 * ```typescript
 * const parsed = parseHuggingFaceURL('https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf');
 * console.log(parsed);
 * // { repo: 'TheBloke/Llama-2-7B-GGUF', file: 'llama-2-7b.Q4_K_M.gguf' }
 * ```
 */
export function parseHuggingFaceURL(url: string): { repo: string; file: string } | null {
  try {
    const urlObj = new URL(url);

    // Check if it's a HuggingFace URL
    if (urlObj.hostname !== 'huggingface.co') {
      return null;
    }

    // Parse the path: /repo/user/Model-Name/resolve/main/file.gguf
    const pathParts = urlObj.pathname.split('/').filter((p) => p);

    // Need at least 4 parts: [user, model, 'resolve', 'main', ...file]
    if (pathParts.length < 5) {
      return null;
    }

    // Find 'resolve' index
    const resolveIndex = pathParts.indexOf('resolve');
    if (resolveIndex === -1 || resolveIndex < 2) {
      return null;
    }

    // Extract repo (everything before 'resolve')
    const repo = pathParts.slice(0, resolveIndex).join('/');

    // Extract file (everything after 'main')
    const mainIndex = resolveIndex + 1;
    if (pathParts[mainIndex] !== 'main') {
      return null;
    }

    const file = decodeURIComponent(pathParts.slice(mainIndex + 1).join('/'));

    return { repo, file };
  } catch {
    return null;
  }
}

/**
 * Check if a URL is a HuggingFace URL
 *
 * @param url - URL to check
 * @returns True if URL is from HuggingFace
 *
 * @example
 * ```typescript
 * const isHF = isHuggingFaceURL('https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/model.gguf');
 * console.log(isHF); // true
 * ```
 */
export function isHuggingFaceURL(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'huggingface.co';
  } catch {
    return false;
  }
}
