#!/usr/bin/env node
/**
 * Generate the self-contained adm-zip preamble used by the inline ZIP worker.
 *
 * The generated TypeScript source is committed so clean checkouts can build and
 * run tests without mutating the repository. Normal builds use --check; run the
 * write mode intentionally only when updating the exact adm-zip or esbuild pin.
 *
 * @module scripts/generate-zip-worker
 */

import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const rootPackagePath = path.join(repoRoot, 'package.json');
const defaultOutputPath = path.join(repoRoot, 'src', 'generated', 'adm-zip-worker-source.ts');
const require = createRequire(import.meta.url);

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function parseArguments(args) {
  let check = false;
  let outputPath = defaultOutputPath;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--check') {
      check = true;
    } else if (argument === '--output') {
      const value = args[index + 1];
      if (!value) throw new Error('--output requires a path');
      outputPath = path.resolve(repoRoot, value);
      index++;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { check, outputPath };
}

function assertExactVersion(name, value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${name} must be declared as an exact semantic version; received ${value}`);
  }
}

function makeLicenseBanner(version, licenseText) {
  if (licenseText.includes('*/')) {
    throw new Error('adm-zip license text cannot be embedded safely in a block comment');
  }

  return [
    '/*!',
    ` * adm-zip ${version} embedded by genai-electron`,
    ' * https://github.com/cthackers/adm-zip',
    ' *',
    ...licenseText.split('\n').map((line) => (line ? ` * ${line}` : ' *')),
    ' */',
  ].join('\n');
}

function renderGeneratedSource({ version, globalKey, sha256, preamble }) {
  return `${[
    '/**',
    ' * GENERATED FILE - DO NOT EDIT.',
    ' *',
    ' * Regenerate with: npm run generate:zip-worker',
    ' * Verify with:     npm run check:zip-worker',
    ' *',
    ` * Embedded adm-zip: ${version}`,
    ` * Preamble SHA-256: ${sha256}`,
    ' */',
    '',
    `export const ADM_ZIP_WORKER_VERSION = ${JSON.stringify(version)};`,
    `export const ADM_ZIP_WORKER_SHA256 = ${JSON.stringify(sha256)};`,
    `export const ADM_ZIP_WORKER_GLOBAL_KEY = ${JSON.stringify(globalKey)};`,
    `export const ADM_ZIP_WORKER_PREAMBLE: string = ${JSON.stringify(preamble)};`,
    '',
  ].join('\n')}`;
}

async function generateSource() {
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
  const declaredAdmZip = rootPackage.devDependencies?.['adm-zip'];
  const declaredEsbuild = rootPackage.devDependencies?.esbuild;

  if (rootPackage.dependencies?.['adm-zip'] !== undefined) {
    throw new Error('adm-zip must not be declared as a runtime dependency');
  }
  assertExactVersion('devDependencies.adm-zip', declaredAdmZip);
  assertExactVersion('devDependencies.esbuild', declaredEsbuild);

  const admZipPackagePath = require.resolve('adm-zip/package.json');
  const admZipPackage = JSON.parse(await readFile(admZipPackagePath, 'utf8'));
  if (admZipPackage.version !== declaredAdmZip) {
    throw new Error(
      `Installed adm-zip ${admZipPackage.version} does not match the exact ${declaredAdmZip} pin`
    );
  }
  if (esbuildVersion !== declaredEsbuild) {
    throw new Error(
      `Installed esbuild ${esbuildVersion} does not match the exact ${declaredEsbuild} pin`
    );
  }

  const admZipRoot = path.dirname(admZipPackagePath);
  const licenseText = normalizeNewlines(
    await readFile(path.join(admZipRoot, 'LICENSE'), 'utf8')
  ).trimEnd();
  const globalKey = `__genai_electron_adm_zip_${declaredAdmZip.replaceAll('.', '_')}__`;
  const entrySource = [
    "import AdmZip from 'adm-zip';",
    `globalThis[${JSON.stringify(globalKey)}] = AdmZip;`,
    '',
  ].join('\n');

  const result = await build({
    absWorkingDir: repoRoot,
    banner: { js: makeLicenseBanner(declaredAdmZip, licenseText) },
    bundle: true,
    charset: 'utf8',
    format: 'cjs',
    legalComments: 'none',
    logLevel: 'silent',
    minify: false,
    platform: 'node',
    sourcemap: false,
    stdin: {
      contents: entrySource,
      loader: 'js',
      resolveDir: repoRoot,
      sourcefile: 'genai-electron-adm-zip-entry.mjs',
    },
    target: 'node22',
    treeShaking: true,
    write: false,
  });

  if (result.outputFiles?.length !== 1 || !result.outputFiles[0]) {
    throw new Error(`Expected one esbuild output, received ${result.outputFiles?.length ?? 0}`);
  }

  const preamble = `${normalizeNewlines(result.outputFiles[0].text).trimEnd()}\n`;
  if (!preamble.includes(globalKey)) {
    throw new Error('Generated preamble does not initialize the exported worker global key');
  }
  const forbiddenRuntimeLoads = [
    /(?:require|import)\s*\(\s*['"]adm-zip(?:\/[^'"]*)?['"]\s*\)/,
    /\.resolve\s*\(\s*['"]adm-zip(?:\/[^'"]*)?['"]\s*\)/,
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]adm-zip(?:\/[^'"]*)?['"]/,
  ];
  if (forbiddenRuntimeLoads.some((pattern) => pattern.test(preamble))) {
    throw new Error('Generated preamble still contains a runtime adm-zip module load');
  }

  const absoluteRootCandidates = [repoRoot, repoRoot.replaceAll('\\', '/')];
  if (absoluteRootCandidates.some((candidate) => preamble.includes(candidate))) {
    throw new Error('Generated preamble contains a machine-specific absolute repository path');
  }

  const sha256 = createHash('sha256').update(preamble, 'utf8').digest('hex');
  return renderGeneratedSource({
    version: declaredAdmZip,
    globalKey,
    sha256,
    preamble,
  });
}

async function main() {
  const { check, outputPath } = parseArguments(process.argv.slice(2));
  const expected = await generateSource();

  if (check) {
    let actual;
    try {
      actual = normalizeNewlines(await readFile(outputPath, 'utf8'));
    } catch (error) {
      throw new Error(
        `Generated ZIP worker source is missing at ${outputPath}. Run npm run generate:zip-worker.`,
        { cause: error }
      );
    }

    if (actual !== expected) {
      throw new Error(
        `Generated ZIP worker source is stale at ${outputPath}. Run npm run generate:zip-worker.`
      );
    }
    console.warn(`[zip-worker] OK - ${path.relative(repoRoot, outputPath)} is current`);
    return;
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, 'utf8');
  console.warn(`[zip-worker] wrote ${path.relative(repoRoot, outputPath)}`);
}

await main();
