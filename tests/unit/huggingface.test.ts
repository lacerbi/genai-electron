import {
  getHuggingFaceURL,
  isHuggingFaceURL,
  parseHuggingFaceURL,
} from '../../src/download/huggingface.js';

describe('HuggingFace URL utilities', () => {
  describe('getHuggingFaceURL()', () => {
    it('uses main by default without changing top-level filenames', () => {
      expect(getHuggingFaceURL('owner/model', 'model.gguf')).toBe(
        'https://huggingface.co/owner/model/resolve/main/model.gguf'
      );
    });

    it('preserves nested separators while encoding each file segment', () => {
      expect(getHuggingFaceURL('owner/model', 'split files/vae/a+b.safetensors')).toBe(
        'https://huggingface.co/owner/model/resolve/main/split%20files/vae/a%2Bb.safetensors'
      );
    });

    it('encodes a raw slash-bearing revision as one segment', () => {
      expect(getHuggingFaceURL('owner/model', 'model.gguf', 'release/1.0')).toBe(
        'https://huggingface.co/owner/model/resolve/release%2F1.0/model.gguf'
      );
    });

    it('rejects empty or whitespace-only revisions', () => {
      expect(() => getHuggingFaceURL('owner/model', 'model.gguf', '')).toThrow(TypeError);
      expect(() => getHuggingFaceURL('owner/model', 'model.gguf', '   ')).toThrow(
        /non-empty string/
      );
    });

    it('treats revision input as raw and encodes existing percent escapes', () => {
      expect(getHuggingFaceURL('owner/model', 'model.gguf', 'release%2F1.0')).toContain(
        '/resolve/release%252F1.0/'
      );
    });
  });

  describe('parseHuggingFaceURL()', () => {
    it('parses a namespaced repo and returns the revision', () => {
      expect(
        parseHuggingFaceURL(
          'https://huggingface.co/owner/model/resolve/0123456789abcdef/model.gguf'
        )
      ).toEqual({
        repo: 'owner/model',
        revision: '0123456789abcdef',
        file: 'model.gguf',
      });
    });

    it('round-trips a single-segment repo ID', () => {
      const url = getHuggingFaceURL('gpt2', 'weights/model.gguf');
      expect(parseHuggingFaceURL(url)).toEqual({
        repo: 'gpt2',
        revision: 'main',
        file: 'weights/model.gguf',
      });
    });

    it.each([
      ['resolve', 'resolve'],
      ['resolve/model', 'resolve/model'],
      ['owner/resolve', 'owner/resolve'],
    ])('round-trips repo ID %s without route-marker ambiguity', (repo, expectedRepo) => {
      expect(parseHuggingFaceURL(getHuggingFaceURL(repo, 'model.gguf'))).toEqual({
        repo: expectedRepo,
        revision: 'main',
        file: 'model.gguf',
      });
    });

    it('prefers the namespaced repo shape for an inherently ambiguous resolve route', () => {
      const url = getHuggingFaceURL('gpt2', 'nested/model.gguf', 'resolve');
      expect(parseHuggingFaceURL(url)).toEqual({
        repo: 'gpt2/resolve',
        revision: 'nested',
        file: 'model.gguf',
      });
    });

    it('round-trips decoded slash-bearing revisions and nested files', () => {
      const url = getHuggingFaceURL(
        'owner/model',
        'split files/vae/a+b.safetensors',
        'release/1.0'
      );
      expect(parseHuggingFaceURL(url)).toEqual({
        repo: 'owner/model',
        revision: 'release/1.0',
        file: 'split files/vae/a+b.safetensors',
      });
    });

    it('parses legacy URLs with encoded file separators', () => {
      expect(
        parseHuggingFaceURL(
          'https://huggingface.co/owner/model/resolve/main/split_files%2Fvae%2Fmodel.safetensors'
        )
      ).toEqual({
        repo: 'owner/model',
        revision: 'main',
        file: 'split_files/vae/model.safetensors',
      });
    });

    it.each([
      'https://example.com/owner/model/resolve/main/model.gguf',
      'https://huggingface.co/owner/model/resolve/main',
      'https://huggingface.co/owner/model/resolve//model.gguf',
      'https://huggingface.co/owner/model/blob/main/model.gguf',
      'not a URL',
    ])('returns null for invalid URL %s', (url) => {
      expect(parseHuggingFaceURL(url)).toBeNull();
    });

    it('returns null for malformed percent encoding', () => {
      expect(
        parseHuggingFaceURL('https://huggingface.co/owner/model/resolve/main/%E0%A4%A')
      ).toBeNull();
    });
  });

  describe('isHuggingFaceURL()', () => {
    it('accepts only valid huggingface.co URLs', () => {
      expect(isHuggingFaceURL('https://huggingface.co/owner/model')).toBe(true);
      expect(isHuggingFaceURL('https://example.com/owner/model')).toBe(false);
      expect(isHuggingFaceURL('not a URL')).toBe(false);
    });
  });
});
