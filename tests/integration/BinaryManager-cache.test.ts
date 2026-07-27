/**
 * Real-filesystem dependency-cache integration coverage.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { BinaryManagerConfig } from '../../src/managers/BinaryManager.js';
import type { BinaryProgressEvent } from '../../src/types/index.js';

interface DownloadOptions {
  url: string;
  destination: string;
  onProgress?: (downloaded: number, total: number) => void;
}

const fixtureArchives = new Map<string, string>();
const mockDownload = jest.fn();

async function copyFixtureArchive(options: DownloadOptions): Promise<void> {
  const source = fixtureArchives.get(options.url);
  if (!source) {
    throw new Error(`No fixture archive configured for ${options.url}`);
  }

  await copyFile(source, options.destination);
  const { size } = await stat(source);
  options.onProgress?.(size, size);
}

class MockDownloader {
  download = mockDownload;
  cancel = jest.fn();
  downloading = false;
}

jest.unstable_mockModule('../../src/download/Downloader.js', () => ({
  Downloader: MockDownloader,
}));

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof jest.fn>;
};

const mockSpawn = jest.fn();
let requireRuntimeBesideCommand = false;

function createSuccessfulChildProcess(command: string): MockChildProcess {
  if (requireRuntimeBesideCommand) {
    expect(readFileSync(path.join(path.dirname(command), 'runtime.dll'), 'utf8')).toBe(
      'runtime fixture\n'
    );
  }

  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = jest.fn(() => {
    child.killed = true;
    return true;
  });

  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('version 1.0\n'));
    child.emit('exit', 0, null);
  });

  return child;
}

jest.unstable_mockModule('child_process', () => ({
  exec: jest.fn(),
  spawn: mockSpawn,
}));

const binaryRoots = {
  llama: '',
  diffusion: '',
};

jest.unstable_mockModule('../../src/config/paths.js', () => ({
  PATHS: {
    binaries: binaryRoots,
  },
  getBinaryPath: (type: keyof typeof binaryRoots, binaryName: string) =>
    path.join(binaryRoots[type], process.platform === 'win32' ? `${binaryName}.exe` : binaryName),
}));

const { BinaryManager } = await import('../../src/managers/BinaryManager.js');

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

describe('BinaryManager dependency cache integration', () => {
  let tempRoot: string;
  let mainArchivePath: string;
  let dependencyArchivePath: string;
  let mainChecksum: string;
  let dependencyChecksum: string;

  const mainUrl = 'fixture://llama-main.zip';
  const dependencyUrl = 'fixture://runtime-original.zip';
  const movedDependencyUrl = 'fixture://runtime-moved.zip';
  const dependencyDescription = 'Runtime fixture';
  const serverFilename = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

  beforeEach(() => {
    requireRuntimeBesideCommand = false;
    mockDownload.mockImplementation(copyFixtureArchive);
    mockSpawn.mockImplementation(createSuccessfulChildProcess);
  });

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'genai-binary-cache-test-'));
    binaryRoots.llama = path.join(tempRoot, 'binaries', 'llama');
    binaryRoots.diffusion = path.join(tempRoot, 'binaries', 'diffusion');
    await mkdir(binaryRoots.llama, { recursive: true });

    mainArchivePath = path.join(tempRoot, 'main.zip');
    const mainArchive = new AdmZip();
    mainArchive.addFile(serverFilename, Buffer.from('binary fixture\n'));
    await mainArchive.writeZipPromise(mainArchivePath);

    dependencyArchivePath = path.join(tempRoot, 'runtime.zip');
    const dependencyArchive = new AdmZip();
    dependencyArchive.addFile('runtime.dll', Buffer.from('runtime fixture\n'));
    await dependencyArchive.writeZipPromise(dependencyArchivePath);

    mainChecksum = await sha256(mainArchivePath);
    dependencyChecksum = await sha256(dependencyArchivePath);
    fixtureArchives.set(mainUrl, mainArchivePath);
    fixtureArchives.set(dependencyUrl, dependencyArchivePath);
    fixtureArchives.set(movedDependencyUrl, dependencyArchivePath);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('persists a manifest and reuses its installed dependency across manager instances', async () => {
    const firstProgress: BinaryProgressEvent[] = [];
    const baseConfig: BinaryManagerConfig = {
      type: 'llama',
      binaryName: 'llama-server',
      platformKey: 'integration-test',
      variants: [
        {
          type: 'cpu',
          url: mainUrl,
          checksum: mainChecksum,
          dependencies: [
            {
              url: dependencyUrl,
              checksum: dependencyChecksum,
              description: dependencyDescription,
            },
          ],
        },
      ],
      onProgress: (event) => firstProgress.push(event),
    };

    const firstManager = new BinaryManager(baseConfig);
    const binaryPath = await firstManager.ensureBinary();
    const manifestPath = path.join(binaryRoots.llama, '.deps.json');
    const runtimePath = path.join(binaryRoots.llama, 'runtime.dll');

    expect(mockDownload.mock.calls.map(([options]) => options.url)).toEqual([
      dependencyUrl,
      mainUrl,
    ]);
    expect(firstProgress).toContainEqual(
      expect.objectContaining({ phase: 'extracting', file: dependencyDescription })
    );
    await expect(readFile(runtimePath, 'utf8')).resolves.toBe('runtime fixture\n');

    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version: number;
      dependencies: Array<{ url: string; checksum: string; files: string[] }>;
    };
    expect(firstManifest).toEqual({
      version: 1,
      dependencies: [
        {
          url: dependencyUrl,
          checksum: dependencyChecksum,
          files: ['runtime.dll'],
        },
      ],
    });

    // Force main-binary reprovisioning while preserving the installed
    // dependency and manifest, mirroring a version-change replacement.
    await rm(binaryPath);
    mockDownload.mockClear();
    mockSpawn.mockClear();
    requireRuntimeBesideCommand = true;
    const secondProgress: BinaryProgressEvent[] = [];

    const secondManager = new BinaryManager({
      ...baseConfig,
      variants: [
        {
          ...baseConfig.variants[0]!,
          dependencies: [
            {
              url: movedDependencyUrl,
              checksum: dependencyChecksum,
              description: dependencyDescription,
            },
          ],
        },
      ],
      onProgress: (event) => secondProgress.push(event),
    });

    await expect(secondManager.ensureBinary()).resolves.toBe(binaryPath);

    expect(mockDownload.mock.calls.map(([options]) => options.url)).toEqual([mainUrl]);
    expect(secondProgress).not.toContainEqual(
      expect.objectContaining({ phase: 'extracting', file: dependencyDescription })
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await expect(readFile(runtimePath, 'utf8')).resolves.toBe('runtime fixture\n');

    const secondManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies: Array<{ url: string }>;
    };
    expect(secondManifest.dependencies).toEqual([
      expect.objectContaining({ url: movedDependencyUrl }),
    ]);
    expect((await readdir(binaryRoots.llama)).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  }, 15_000);
});
