/**
 * HuggingFace URL conversion utilities
 * @module download/huggingface
 */

/**
 * Convert HuggingFace repository and file to direct download URL
 *
 * @param repo - Repository name (e.g., "TheBloke/Llama-2-7B-GGUF")
 * @param file - File path within the repository (e.g., "models/llama-2-7b.Q4_K_M.gguf")
 * @param revision - Raw Git revision (branch, tag, or full commit SHA; defaults to "main")
 * @returns Direct download URL
 * @throws {TypeError} If revision is empty or whitespace-only
 *
 * @example
 * ```typescript
 * const url = getHuggingFaceURL(
 *   'organization/model',
 *   'weights/model Q4.gguf',
 *   '0123456789abcdef0123456789abcdef01234567'
 * );
 * console.log(url);
 * // https://huggingface.co/organization/model/resolve/0123456789abcdef0123456789abcdef01234567/weights/model%20Q4.gguf
 * ```
 */
export function getHuggingFaceURL(repo: string, file: string, revision = 'main'): string {
  if (revision.trim().length === 0) {
    throw new TypeError('Hugging Face revision must be a non-empty string');
  }

  // Revisions occupy one route segment, while file paths retain their hierarchy.
  const encodedRevision = encodeURIComponent(revision);
  const encodedFile = file.split('/').map(encodeURIComponent).join('/');

  // Construct the direct download URL
  return `https://huggingface.co/${repo}/resolve/${encodedRevision}/${encodedFile}`;
}

/**
 * Parse HuggingFace URL to extract repository and file name
 *
 * @param url - HuggingFace URL
 * @returns Object with decoded repo revision and file, or null if not a valid HuggingFace URL.
 * In the inherently ambiguous route where both a single-segment repo revision
 * and a namespaced repo name are "resolve", the namespaced repo shape wins.
 *
 * @example
 * ```typescript
 * const parsed = parseHuggingFaceURL('https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf');
 * console.log(parsed);
 * // { repo: 'TheBloke/Llama-2-7B-GGUF', revision: 'main', file: 'llama-2-7b.Q4_K_M.gguf' }
 * ```
 */
export function parseHuggingFaceURL(
  url: string
): { repo: string; revision: string; file: string } | null {
  try {
    const urlObj = new URL(url);

    // Check if it's a HuggingFace URL
    if (urlObj.hostname !== 'huggingface.co') {
      return null;
    }

    // Parse either /repo/resolve/revision/file or /owner/repo/resolve/revision/file.
    const pathParts = urlObj.pathname.split('/').filter((p) => p);

    // Need at least 4 parts: [repo, 'resolve', revision, ...file]
    if (pathParts.length < 4) {
      return null;
    }

    // Prefer the namespaced shape when both candidates are possible (for a repo
    // named "resolve"), otherwise accept a single-segment repo ID such as gpt2.
    const resolveIndex =
      pathParts[2] === 'resolve' && pathParts.length >= 5
        ? 2
        : pathParts[1] === 'resolve' && pathParts.length >= 4
          ? 1
          : -1;
    if (resolveIndex === -1) {
      return null;
    }

    // Extract repo (everything before 'resolve')
    const repo = pathParts.slice(0, resolveIndex).join('/');

    const revisionPart = pathParts[resolveIndex + 1];
    const fileParts = pathParts.slice(resolveIndex + 2);
    if (!revisionPart || fileParts.length === 0) {
      return null;
    }

    const revision = decodeURIComponent(revisionPart);
    const file = decodeURIComponent(fileParts.join('/'));

    return { repo, revision, file };
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
