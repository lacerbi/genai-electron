/**
 * Integration tests for archive extraction with the real adm-zip and tar packages.
 */

import AdmZip from 'adm-zip';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { extractArchive, extractBinary } from '../../src/utils/archive-utils.js';

const TEXT_CONTENT = 'archive compatibility fixture\n';
const BINARY_CONTENT = 'nested executable fixture\n';
const BINARY_NAME = 'fixture-binary';

describe('archive-utils integration', () => {
  let tempRoot: string;
  let zipPath: string;
  let tarPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'genai-archive-test-'));
    zipPath = path.join(tempRoot, 'fixture.zip');
    tarPath = path.join(tempRoot, 'fixture.tar.gz');

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

    await tar.c({ file: tarPath, cwd: sourceDir, gzip: true }, ['nested']);
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

    const binaryPath = await extractBinary(getArchivePath(), extractTo, [BINARY_NAME]);

    expect(binaryPath).toBe(expectedPath);
    await expect(readFile(binaryPath, 'utf8')).resolves.toBe(BINARY_CONTENT);
  });
});
