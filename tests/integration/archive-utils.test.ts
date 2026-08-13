/**
 * Integration tests for archive extraction with the real adm-zip and tar packages.
 */

import AdmZip from 'adm-zip';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { extractArchive, extractBinary } from '../../src/utils/archive-utils.js';

const TEXT_CONTENT = 'archive compatibility fixture\n';
const BINARY_CONTENT = 'nested executable fixture\n';
const BINARY_NAME = 'fixture-binary';
const LARGE_ENTRY_SIZE = 12 * 1024 * 1024;

describe('archive-utils integration', () => {
  let tempRoot: string;
  let zipPath: string;
  let tarPath: string;
  let secondTarPath: string;
  let traversalZipPath: string;
  let largeZipPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'genai-archive-test-'));
    zipPath = path.join(tempRoot, 'fixture.zip');
    tarPath = path.join(tempRoot, 'fixture.tar.gz');
    secondTarPath = path.join(tempRoot, 'second-fixture.tar.gz');
    traversalZipPath = path.join(tempRoot, 'traversal.zip');
    largeZipPath = path.join(tempRoot, 'large-fixture.zip');

    const sourceDir = path.join(tempRoot, 'source');
    const nestedDir = path.join(sourceDir, 'nested');
    const binaryDir = path.join(nestedDir, 'bin');
    await mkdir(binaryDir, { recursive: true });
    await writeFile(path.join(nestedDir, 'message.txt'), TEXT_CONTENT);
    await writeFile(path.join(binaryDir, BINARY_NAME), BINARY_CONTENT);

    const zip = new AdmZip();
    zip.addFile('nested/message.txt', Buffer.from(TEXT_CONTENT));
    zip.addFile(`nested/bin/${BINARY_NAME}`, Buffer.from(BINARY_CONTENT));
    await zip.writeZipPromise(zipPath);

    const traversalZip = new AdmZip();
    traversalZip.addFile('../escape.txt', Buffer.from('contained fixture\n'));
    await traversalZip.writeZipPromise(traversalZipPath);

    const largeZip = new AdmZip();
    largeZip.addFile('large/runtime.bin', Buffer.alloc(LARGE_ENTRY_SIZE, 0x5a));
    await largeZip.writeZipPromise(largeZipPath);

    await tar.c({ file: tarPath, cwd: sourceDir, gzip: true }, ['nested']);
    await writeFile(path.join(sourceDir, 'second.txt'), 'second archive fixture\n');
    await tar.c({ file: secondTarPath, cwd: sourceDir, gzip: true }, ['second.txt']);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    ['ZIP', () => zipPath],
    ['tar.gz', () => tarPath],
  ])('extracts a real %s archive', async (format, getArchivePath) => {
    const extractTo = path.join(tempRoot, `extract-${format}`);

    await extractArchive(getArchivePath(), extractTo);

    await expect(readFile(path.join(extractTo, 'nested', 'message.txt'), 'utf8')).resolves.toBe(
      TEXT_CONTENT
    );
    await expect(
      readFile(path.join(extractTo, 'nested', 'bin', BINARY_NAME), 'utf8')
    ).resolves.toBe(BINARY_CONTENT);
  });

  it.each([
    ['ZIP', () => zipPath],
    ['tar.gz', () => tarPath],
  ])('finds a nested binary in a real %s archive', async (format, getArchivePath) => {
    const extractTo = path.join(tempRoot, `binary-${format}`);
    const expectedPath = path.join(extractTo, 'nested', 'bin', BINARY_NAME);
    let extractedFiles: readonly string[] = [];

    const binaryPath = await extractBinary(
      getArchivePath(),
      extractTo,
      [BINARY_NAME],
      undefined,
      (files) => {
        extractedFiles = files;
      }
    );

    expect(binaryPath).toBe(expectedPath);
    expect(extractedFiles).toEqual(
      expect.arrayContaining(['nested/message.txt', `nested/bin/${BINARY_NAME}`])
    );
    await expect(readFile(binaryPath, 'utf8')).resolves.toBe(BINARY_CONTENT);
  });

  it('keeps the main event loop responsive while ZIP extraction runs in a worker', async () => {
    const extractTo = path.join(tempRoot, 'responsive-zip');
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      heartbeatCount++;
    }, 1);

    try {
      await extractArchive(zipPath, extractTo);
    } finally {
      clearInterval(heartbeat);
    }

    expect(heartbeatCount).toBeGreaterThan(0);
  });

  it.each([
    [
      'extractArchive',
      (extractTo: string, onProgress: Parameters<typeof extractArchive>[2]) =>
        extractArchive(zipPath, extractTo, onProgress),
    ],
    [
      'extractBinary',
      (extractTo: string, onProgress: Parameters<typeof extractBinary>[3]) =>
        extractBinary(zipPath, extractTo, [BINARY_NAME], onProgress),
    ],
  ])('reports monotonic ZIP entry progress through %s', async (consumer, extract) => {
    const progress: Array<{ completedEntries: number; totalEntries: number }> = [];

    await extract(path.join(tempRoot, `progress-${consumer}`), (event) => {
      progress.push(event);
    });

    const entryTransitions = progress
      .map((event) => event.completedEntries)
      .filter((count, index, counts) => index === 0 || count !== counts[index - 1]);
    expect(entryTransitions).toEqual([0, 1, 2]);
    expect(progress.every((event) => event.totalEntries === 2)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ completedEntries: 2, totalEntries: 2 });
  });

  it('reports byte progress while one large ZIP entry is still incomplete', async () => {
    const extractTo = path.join(tempRoot, 'large-progress-zip');
    const progress: Array<{
      completedEntries: number;
      totalEntries: number;
      writtenBytes?: number;
      totalUncompressedBytes?: number;
    }> = [];

    await extractArchive(largeZipPath, extractTo, (event) => progress.push(event));

    const written = progress.map((event) => event.writtenBytes ?? 0);
    expect(written.every((value, index) => index === 0 || value >= written[index - 1]!)).toBe(true);
    expect(
      progress.some(
        (event) =>
          event.completedEntries === 0 && event.writtenBytes !== undefined && event.writtenBytes > 0
      )
    ).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      completedEntries: 1,
      totalEntries: 1,
      writtenBytes: LARGE_ENTRY_SIZE,
      totalUncompressedBytes: LARGE_ENTRY_SIZE,
    });
    expect(progress.length).toBeLessThanOrEqual(103);
    await expect(readFile(path.join(extractTo, 'large', 'runtime.bin'))).resolves.toHaveLength(
      LARGE_ENTRY_SIZE
    );
  });

  it('isolates throwing ZIP progress callbacks from extraction', async () => {
    const extractTo = path.join(tempRoot, 'throwing-progress-callback');

    await expect(
      extractArchive(zipPath, extractTo, () => {
        throw new Error('consumer callback failure');
      })
    ).resolves.toEqual(expect.arrayContaining(['nested/message.txt', `nested/bin/${BINARY_NAME}`]));
    await expect(readFile(path.join(extractTo, 'nested', 'message.txt'), 'utf8')).resolves.toBe(
      TEXT_CONTENT
    );
  });

  it('rejects a corrupt ZIP and leaves the worker lifecycle settled', async () => {
    const corruptZipPath = path.join(tempRoot, 'corrupt.zip');
    await writeFile(corruptZipPath, 'not a ZIP archive');

    await expect(
      extractArchive(corruptZipPath, path.join(tempRoot, 'corrupt-output'))
    ).rejects.toThrow('Failed to extract archive');

    // A subsequent extraction proves the failed worker cannot deliver a late
    // result or leave the archive utility in a poisoned state.
    await expect(extractArchive(zipPath, path.join(tempRoot, 'after-corrupt'))).resolves.toEqual(
      expect.arrayContaining(['nested/message.txt', `nested/bin/${BINARY_NAME}`])
    );
  });

  it('returns only files from the current tar extraction when staging already has content', async () => {
    const extractTo = path.join(tempRoot, 'shared-tar-staging');

    await expect(extractArchive(tarPath, extractTo)).resolves.toEqual(
      expect.arrayContaining(['nested/message.txt', `nested/bin/${BINARY_NAME}`])
    );
    await expect(extractArchive(secondTarPath, extractTo)).resolves.toEqual(['second.txt']);
  });

  it('keeps traversal-like ZIP entries inside the extraction root', async () => {
    const extractTo = path.join(tempRoot, 'contained-zip');

    await expect(extractArchive(traversalZipPath, extractTo)).resolves.toEqual(['escape.txt']);
    await expect(readFile(path.join(extractTo, 'escape.txt'), 'utf8')).resolves.toBe(
      'contained fixture\n'
    );
    await expect(access(path.join(tempRoot, 'escape.txt'))).rejects.toThrow();
  });
});
