# ISSUE: Upgrade vulnerable archive dependencies

Created: 2026-07-25
Status: RESOLVED (2026-07-25)
Package: genai-electron
Severity: high (`adm-zip`) / moderate (`tar`)

## Problem

`genai-electron@0.12.0` previously declared `adm-zip ^0.5.16` and `tar ^7.5.19`.
Both ranges admit versions with published security advisories, and downstream
consumers cannot fully repair the findings without overriding this package.

`adm-zip <0.6.0` is affected by
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85):
a small crafted ZIP can declare a huge uncompressed size and make extraction
allocate gigabytes, crashing the process. This is directly relevant because
`src/utils/archive-utils.ts` calls `AdmZip.extractAllTo()` in both
`extractBinary()` and `extractArchive()`. A normal `npm audit fix` only updates
to 0.5.18, which remains inside the advisory range; the manifest must admit
0.6.0.

`tar <=7.5.20` is affected by
[GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m).
The reported exploit requires member selection, while genai currently calls
`tar.x({ file, C })` without a selection list, so this exact path is not
reachable. The locked 7.5.19 is still vulnerable, however, and the published
dependency floor should prevent consumers from retaining it.

Binary and dependency downloads are checksum-verified before extraction, which
reduces normal exploitability but does not justify retaining vulnerable runtime
dependencies or propagating unavoidable audit findings to consumers.

## Resolution

The archive dependency upgrade required no archive source change. The `AdmZip`
constructor and `extractAllTo(target, overwrite)` API used here remain
available in 0.6.0; its documented behavior changes affect APIs genai does not
call.

- Raised `adm-zip` to `^0.6.0` and `tar` to `^7.5.22`.
- Removed `@types/adm-zip`; version 0.6.0 supplies the declarations used by the build.
- Regenerated `package-lock.json` with patched archive resolutions.
- Migrated the development toolchain to ESLint 10, TypeScript ESLint 8.65,
  Jest 30.4, and `ts-jest` 29.4.
- Updated CI to report the full development audit while enforcing the clean
  production-dependency audit.
- Recorded the completed work in `PROGRESS.md`.

## Tests

The existing unit tests mock both extraction libraries. A real
temporary-directory integration suite now covers the archive boundary.

- Extracts a small ZIP and `.tar.gz` through `extractArchive()`.
- Locates a nested executable in both formats through `extractBinary()`.
- Verifies extracted paths and content, then cleans up all temporary files.
- Leaves the multi-gigabyte allocation regression test to upstream.

## Acceptance criteria

All acceptance criteria are satisfied:

- `package.json` requires `adm-zip ^0.6.0` and `tar ^7.5.22`.
- `@types/adm-zip` is removed and TypeScript builds against upstream types.
- The lockfile resolves `adm-zip 0.6.0` and `tar 7.5.22`.
- Real ZIP and tar extraction compatibility tests pass.
- `npm run build`, `npm run lint`, `npm run format:check`, and all 570 tests pass.
- `npm audit --omit=dev` reports zero vulnerabilities.
- The remaining full-audit finding is isolated to Jest's development-only
  `glob`/`minimatch` dependency chain.
