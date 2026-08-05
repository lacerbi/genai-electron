#!/usr/bin/env node
/**
 * Fail on high/critical npm advisories affecting code embedded in runtime output.
 *
 * Production audits intentionally omit development dependencies, while a normal
 * full audit also covers tools that are never shipped. This focused gate keeps
 * exact-pinned generator inputs that become runtime code security-visible.
 *
 * @module scripts/check-embedded-audit
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EMBEDDED_RUNTIME_INPUTS = ['adm-zip'];
const BLOCKED_SEVERITIES = new Set(['high', 'critical']);

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && fs.existsSync(candidate));
  const cli = candidates[0];
  if (!cli) throw new Error('could not locate npm-cli.js to run the embedded-input audit');
  return cli;
}

const result = spawnSync(process.execPath, [findNpmCli(), 'audit', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (result.error) throw result.error;

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(result.stderr ?? '');
  throw new Error('npm audit did not return valid JSON for the embedded-input gate', {
    cause: error,
  });
}
if (report.error) {
  const message = report.message || report.error.summary || JSON.stringify(report.error);
  throw new Error(`npm audit failed: ${message}`);
}

const violations = EMBEDDED_RUNTIME_INPUTS.flatMap((name) => {
  const vulnerability = report.vulnerabilities?.[name];
  if (!vulnerability || !BLOCKED_SEVERITIES.has(vulnerability.severity)) return [];
  return [{ name, vulnerability }];
});

if (violations.length > 0) {
  for (const { name, vulnerability } of violations) {
    console.error(
      `[embedded-audit] ${name}: ${vulnerability.severity} advisory affects embedded runtime code`
    );
    for (const advisory of vulnerability.via ?? []) {
      if (typeof advisory === 'object') {
        console.error(`  - ${advisory.title ?? advisory.name}: ${advisory.url ?? 'no URL'}`);
      }
    }
  }
  process.exitCode = 1;
} else {
  console.warn(
    `[embedded-audit] OK - no high/critical advisories for ${EMBEDDED_RUNTIME_INPUTS.join(', ')}`
  );
}
