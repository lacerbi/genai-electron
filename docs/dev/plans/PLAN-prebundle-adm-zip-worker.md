# Plan: Prebundle adm-zip Worker

Created: 2026-08-05
Status: COMPLETE (approved and completed 2026-08-05)
Release target: v0.22.1

## Summary

Replace the ZIP worker's runtime `adm-zip` module resolution with a deterministic, self-contained
worker payload generated from an exact-pinned `adm-zip` release. This removes the package-root
startup crash in bundled Electron mains and lets real ZIP provisioning work from a single bundle
with no loose or resolvable `node_modules`, while preserving the existing worker-thread
responsiveness, entry progress, path containment, and typed extraction/provisioning errors.

The generated payload will be committed and verified rather than regenerated implicitly during a
normal build. `adm-zip` remains visible as an exact development dependency for updates, tests,
auditing, and provenance, but is removed from published runtime dependencies. No handwritten ZIP
parser, runtime fallback, new public API, version bump, migration guide, or release action is part
of this work.

## Task Understanding and Evidence

The accepted issue is
[`ISSUE-adm-zip-eager-resolve.md`](../issues/ISSUE-adm-zip-eager-resolve.md). In v0.22.0,
[`src/utils/archive-utils.ts`](../../../src/utils/archive-utils.ts) resolves `adm-zip` at module
evaluation so its inline `eval` worker can import an absolute module URL. That utility is on the
static package-root import chain through the server and binary managers. A consumer bundler can
inline genai-electron without including the dynamically resolved CommonJS package, leaving the
resolve to run from the final bundle location and crash the Electron main process before any ZIP
operation.

The report was independently reproduced with the repository's installed esbuild: the bundled root
retained `createRequire(import.meta.url).resolve("adm-zip")`, and the isolated bundle failed with
`MODULE_NOT_FOUND`. The reported scope is also correct: 11 of the 15 configured main/dependency
provisioning artifacts are ZIPs.

The user accepted these decisions before planning:

1. Support a bundled Electron main with no packaged `node_modules` as a real packaging contract.
2. Prebundle the maintained `adm-zip` implementation; do not reimplement ZIP parsing.
3. Keep ZIP work in the existing inline worker rather than adding a separately packaged worker
   asset.
4. Commit deterministic generated source, exact-pin its inputs, preserve the MIT notice, and fail
   verification when the committed payload is stale.
5. Remove `adm-zip` from runtime dependencies and do not retain a runtime resolution fallback.
6. Require an isolated bundle-only real-ZIP test as the acceptance gate.

## Durable Artifact Ownership

- This plan owns the implementation sequence, generated-payload contract, packaging decision,
  risks, and acceptance criteria.
- The archived issue will preserve the downstream incident and original asks, then append the
  resolution and exact validation evidence.
- [`src/utils/archive-utils.ts`](../../../src/utils/archive-utils.ts) remains the authoritative
  typed worker protocol and extraction implementation. The generator owns only the bundled
  `adm-zip` preamble, not a second copy of the extraction loop.
- A new root `THIRD_PARTY_NOTICES.md` has a distinct durable legal/provenance role: it will carry
  the full license notice for embedded third-party code shipped inside genai-electron. The
  project's own [`LICENSE`](../../../LICENSE) cannot accurately own that third-party attribution.
- [`docs/dev/UPDATING-BINARIES.md`](../UPDATING-BINARIES.md) will own the maintainer workflow for
  updating and regenerating the embedded ZIP implementation.
- Current setup/integration guides own the consumer-facing dependency and bundling contract.
  Historical release entries, migration guides, resolved issues, and prior plans remain unchanged.
- [`PROGRESS.md`](../../../PROGRESS.md) owns the concise Unreleased record. No migration guide is
  created until a release is explicitly requested.

## Scope

- **In scope**:
  - Exact-pinned build inputs and deterministic committed worker-payload generation.
  - Full MIT attribution for the embedded implementation.
  - Removal of all runtime `adm-zip` resolution/import paths.
  - Preservation of current ZIP worker behavior, progress, containment, cleanup, and typed errors.
  - Real bundle-only ZIP extraction from an isolated packed consumer with no resolvable
    `adm-zip`.
  - Package metadata, lockfile, build/check scripts, focused tests, living documentation,
    Unreleased status, and issue resolution/archive.
- **Out of scope**:
  - A custom ZIP parser or a switch to another archive library.
  - Moving ZIP inflation back to the Electron main thread.
  - A standalone worker file required at application runtime.
  - A runtime fallback to external or loose `adm-zip`.
  - Changes to tar extraction, binary selection, archive checksums, dependency caching, or public
    progress/error types.
  - General guarantees that arbitrary consumer bundlers can rewrite every Electron application
    correctly; the acceptance contract is the documented Node/Electron ESM main-bundle shape.
  - Version changes, migration guides, PRs, tags, releases, publication, pushing, or downstream
    workaround removal before a fixed release is available.

## Design Decisions

### 1. Preserve one typed worker harness

Keep `zipExtractionWorkerMain()` in `src/utils/archive-utils.ts` as the readable, TypeScript-checked
owner of worker messages, entry extraction, canonical paths, progress, error posting, and parent
port cleanup. Generate only a preamble that bundles `adm-zip` and installs its constructor under a
private, collision-resistant `globalThis` key. The generated module owns and exports that key as
well as the preamble; the parent passes the exported key through `workerData`, and the worker uses
that value to retrieve and remove the constructor. Construct `ZIP_WORKER_SOURCE` from the preamble
plus the existing stringified worker function.

This avoids maintaining production extraction logic in both TypeScript and an untyped generated
entry while still giving the eval worker one self-contained source string. The worker captures and
then removes the private global constructor before processing the archive.

### 2. Commit generated source and verify it byte-for-byte

Add a small `.mjs` generator using esbuild's programmatic `write: false` API. It will bundle a
stable virtual/maintainer entry that imports the exact `adm-zip` package and assigns the constructor
to the agreed private global key. The output uses Node 22, CommonJS worker semantics, normalized LF
newlines, no inner source map, no timestamps, no absolute source paths, and a literal license
banner.

The committed generated TypeScript module will contain:

- a DO-NOT-EDIT header and regeneration command;
- the exact embedded `adm-zip` version;
- a SHA-256 of the normalized worker preamble;
- the single authoritative private global key used by both the generated preamble and worker data;
- the preamble as an explicitly `string`-typed constant so declarations do not infer or reproduce
  the entire payload as a string-literal type.

The generator supports write and `--check` modes. `--check` regenerates in memory and compares the
complete expected file byte-for-byte, rejecting mismatched dependency declarations, versions,
hashes, license text, or payload bytes with an actionable regeneration command. Normal build,
watch, CI, and prepublish paths check but do not mutate generated source.

### 3. Exact development pins own embedded-code updates

Move `adm-zip` from runtime dependencies to the exact development pin `0.6.0`, which retains the
real integration fixtures, upstream types, dependency-update visibility, and full-audit coverage.
Add an exact esbuild development pin for deterministic generation; use the currently exercised
`0.28.1` unless dependency installation demonstrates an incompatibility that requires returning
for approval.

The production manifest will then contain only `@huggingface/gguf` and `tar`. A downstream override
can no longer patch the embedded ZIP implementation, so every future `adm-zip` security/version
update must update the exact pin, regenerate the payload, review the bundle/notice, run the isolated
smoke, and ship through a genai-electron release.

### 4. No missing-module fallback or new error type

Prebundling satisfies the issue's first ask more strongly than lazy resolution: there is no runtime
module to resolve or be missing. Remove `createRequire`, `pathToFileURL`, `admZipModuleUrl`, and the
worker's dynamic `import()` entirely. Do not add a lazy fallback, because it would preserve the
packaging ambiguity this change is intended to remove.

Corrupt archives, filesystem failures, worker exceptions/exits, and binary-provisioning failures
continue through the existing `FileSystemError` and `BinaryError` contracts. No new missing-module
error is required once the runtime dependency is structurally absent.

### 5. Execution is the packaging proof

Do not rely only on bundle-text inspection or a Jest snapshot of generated bytes. Extend the packed
consumer harness to build and run a real isolated bundle that first proves `adm-zip` cannot be
resolved, imports the packed package root, executes the packed archive utility, extracts a real ZIP
inside the worker, and validates content and progress. Text inspection remains a supplementary
diagnostic for forbidden runtime resolver/module-URL patterns.

## Task Tracking

- [x] Phase 1: deterministic payload generation, dependency pins, and licensing
- [x] Phase 2: self-contained worker integration and focused unit updates
- [x] Phase 3: isolated packed/bundled acceptance coverage
- [x] Phase 4: living documentation, Unreleased record, and issue resolution
- [x] Phase 5: full verification and implementation double-check

## Phases

### Phase 1: Deterministic Payload and Package Contract

**Goal**: Establish one reproducible, attributable build-time source for the embedded ZIP
implementation and remove it from published runtime dependencies.

**Work**:

- [x] Add a generator under `scripts/` that bundles only the pinned `adm-zip` implementation into
  a Node/CommonJS worker preamble using esbuild in memory.
- [x] Add a minimal stable generator entry/virtual source that exposes the constructor only under
  the generated module's exported private worker-global key; it must not duplicate extraction
  behavior.
- [x] Add write and byte-for-byte `--check` modes with exact manifest/version validation,
  normalized output, embedded version/hash, and actionable failures.
- [x] Commit `src/generated/adm-zip-worker-source.ts` with an explicitly `string`-typed payload and
  generated-file header.
- [x] Add `generate:zip-worker` and `check:zip-worker` scripts. Make `build`, `build:watch`, and
  therefore `prepublishOnly` verify freshness before TypeScript execution without rewriting the
  repository.
- [x] Ignore the generated TypeScript file in Prettier and ESLint while keeping it inside the
  strict TypeScript build.
- [x] Move `adm-zip` to exact-pinned development dependencies, add exact-pinned esbuild, remove
  `adm-zip` from runtime dependencies, and regenerate `package-lock.json` normally.
- [x] Create `THIRD_PARTY_NOTICES.md` containing the complete adm-zip MIT notice, embedded version,
  upstream identity, and generated-code relationship. Add it to `package.json.files`; keep the
  project `LICENSE` unchanged.
- [x] Ensure the full MIT copyright and permission notice is also preserved in the generated
  worker banner rather than relying on upstream source comments or esbuild legal-comment
  detection.

**Verification**:

- [x] Two consecutive generations are byte-identical and the second leaves the worktree unchanged.
- [x] `check:zip-worker` passes for the committed output and fails deterministically against a
  controlled stale copy in a temporary output/check seam, without editing the canonical generated
  file merely to test failure.
- [x] The generator structurally verifies that the emitted preamble initializes the exact exported
  global key that the parent will pass through worker data.
- [x] Generated output contains no timestamp or machine-specific absolute path.
- [x] The inner payload contains its license banner and no source map; its outer declaration is
  compact rather than a payload-sized literal type.
- [x] `package-lock.json` marks `adm-zip` and esbuild as development-only direct dependencies, and
  `npm ls --omit=dev adm-zip` reports no runtime installation requirement.
- [x] The dry-run package includes `THIRD_PARTY_NOTICES.md`.

### Phase 2: Self-Contained ZIP Worker Integration

**Goal**: Execute real `adm-zip` code wholly inside the existing inline worker without runtime
module resolution or behavioral regressions.

**Work**:

- [x] Import the generated preamble in `src/utils/archive-utils.ts` and prepend it to the existing
  stringified worker function.
- [x] Pass the generated module's exported global key through `ZipWorkerData`; read, validate, and
  remove that keyed private constructor before constructing `AdmZip`.
- [x] Remove `createRequire`, `pathToFileURL`, the top-level eager resolve, `admZipModuleUrl` from
  `ZipWorkerData`, and the worker's dynamic import.
- [x] Preserve archive/extraction paths plus the inert generated global-key string as the complete
  worker data, along with the single-settlement exit/error handling, callback isolation,
  non-directory entry loop, adm-zip path containment, normalized returned paths, entry progress,
  and parent-port closure.
- [x] Update `tests/unit/archive-utils.test.ts`: remove the now-obsolete adm-zip module mock, update
  worker-data expectations, and retain routing/progress/failure assertions without snapshotting the
  generated blob.
- [x] Retain the existing real ZIP/tar, nested binary, heartbeat responsiveness, progress,
  corruption recovery, traversal containment, BinaryManager cache, and binary-progress tests.

**Verification**:

- [x] Importing built `archive-utils` and the package root performs no `adm-zip` resolution.
- [x] Real ZIP extraction and nested binary discovery still pass through the generated worker.
- [x] Progress remains monotonic and reaches completed equals total through both archive consumers.
- [x] The main-thread heartbeat advances during ZIP inflation.
- [x] Corrupt/traversal-like ZIP fixtures preserve the existing typed error and containment
  behavior, and a subsequent extraction proves the worker lifecycle settles cleanly.
- [x] Generated `dist/utils/archive-utils.js` contains no `createRequire`, `pathToFileURL`,
  `admZipModuleUrl`, or runtime `import/resolve("adm-zip")` path.

### Phase 3: Packed Bundle-Only Acceptance Gate

**Goal**: Prove the published payload—not repository resolution—supports a one-file Electron main
bundle and real ZIP provisioning without `node_modules`.

**Work**:

- [x] Extend `scripts/packed-api/run.mjs`, which already packs and extracts the exact publishable
  tarball, rather than adding a disconnected fixture package. Update its header/contract to state
  that public API/type checks still use package-name exports exclusively, while the packaging-only
  archive smoke intentionally addresses a built file by absolute path inside the extracted
  tarball.
- [x] Remove `adm-zip` from its `LINKED_DEPENDENCIES`; generated declarations and runtime bundle
  must not require it.
- [x] Before isolation, use the development-only adm-zip fixture builder to create a small real ZIP
  with at least two nested files and record expected content.
- [x] Link only the remaining external build inputs inside the staging consumer so esbuild can
  resolve and inline them; none of those links may be copied into the isolated runtime directory.
- [x] Use the exact-pinned esbuild API for two explicit packaging checks: bundle a package-name root
  import with a tiny Electron `app.getPath()` stub, and separately bundle the packed
  `dist/utils/archive-utils.js` by its verified absolute filesystem path as a test-only internal
  seam. Do not import an undeclared package subpath or add a public archive-utils export.
- [x] Place only the resulting bundles, launcher/fixture data if needed, and ZIP in a fresh sibling
  isolation directory whose ancestor chain contains no `node_modules`.
- [x] Have the launcher first assert that `createRequire(import.meta.url).resolve('adm-zip')` fails
  with `MODULE_NOT_FOUND`, then import the root bundle and run the archive bundle, extracting the ZIP
  in the worker and asserting returned paths, file contents, and exact progress sequence.
- [x] Supplement execution with a diagnostic assertion that the emitted bundle has no forbidden
  runtime adm-zip resolver/module specifier. Do not treat text matching as the primary proof.
- [x] Inspect the packed manifest/payload to confirm `adm-zip` is absent from runtime dependencies
  and the third-party notice is present.

**Verification**:

- [x] The isolated root import succeeds with no resolvable `adm-zip`.
- [x] The isolated self-contained worker extracts the real ZIP and reports progress `[0, 1, 2]`.
- [x] No files outside the requested extraction root are created.
- [x] The packed API/type checks continue to pass without linking `adm-zip`.
- [x] The acceptance harness cleans every temporary directory on success and failure and leaves no
  worker/open-handle residue.
- [x] CI continues to run the packed acceptance on its existing package-validation job, while
  normal cross-platform build jobs verify identical committed generated bytes.

### Phase 4: Documentation and Issue Resolution

**Goal**: Make the new packaging, dependency, licensing, and update responsibilities explicit
without rewriting released history.

**Work**:

- [x] Update `AGENTS.md`, `docs/SETUP.md`, `genai-electron-docs/index.md`, and
  `genai-electron-docs/installation-and-setup.md` from three external runtime dependencies to two,
  while identifying the pinned embedded ZIP implementation and its development/update ownership.
- [x] Update `genai-electron-docs/integration-guide.md` as the durable consumer contract: the
  package root may be bundled into a single Electron main/ASAR and ZIP provisioning does not
  require loose/resolvable adm-zip; externalizing genai-electron remains supported but optional.
- [x] Minimally update `genai-electron-docs/llm-server.md` and
  `genai-electron-docs/image-generation.md` to call the responsive ZIP worker self-contained;
  progress behavior remains unchanged.
- [x] Update the current BinaryManager architecture in `DESIGN.md` with the generated embedded
  worker/no-runtime-resolution decision.
- [x] Update `docs/dev/UPDATING-BINARIES.md` with the exact adm-zip/esbuild pin, regeneration,
  license/hash review, audit, isolated-smoke, and release workflow.
- [x] Link `THIRD_PARTY_NOTICES.md` from the README license section; keep the generic minimal
  runtime-dependencies feature claim.
- [x] Add a concise Unreleased section above v0.22.0 in `PROGRESS.md`; update only current
  dependency-summary text elsewhere in that file and preserve historical v0.12.1/v0.14.0 entries.
- [x] After all acceptance checks pass, preserve the original root issue text, append a separated
  resolution with embedded version/hash and validation evidence, set it to `RESOLVED`, and move it
  to `docs/dev/issues/ISSUE-adm-zip-eager-resolve.md` with `git mv`.
- [x] Leave prior binary-provisioning/archive-security plans and issues, released migration guides,
  and historical PROGRESS sections unchanged.

**Verification**:

- [x] Current dependency counts and packaging claims agree across manifest, orientation, setup,
  integration, and reference documentation.
- [x] Documentation clearly distinguishes embedded audited code from external runtime packages.
- [x] The notice and maintainer guide make future security updates discoverable despite the code
  no longer appearing in production dependency audits.
- [x] The archived issue states that prebundling supersedes lazy resolution, satisfies both asks,
  and permits downstream workaround removal only after uptake of the fixed release.
- [x] No migration guide, version bump, release artifact, or rewrite of released history occurs.

### Phase 5: Full Verification and Final Review

**Goal**: Satisfy repository quality gates, verify the publishable artifact, and deeply review the
completed change before declaring the issue resolved.

**Work**:

- [x] Generate once intentionally, then run the non-mutating freshness check and inspect the
  generated version/hash/license header.
- [x] Run focused archive/BinaryManager tests, followed by the full Jest suite.
- [x] Run clean build, lint, repository formatting, packed API, example build, production audit,
  full audit report, package dry run, and diff/status checks.
- [x] Inspect generated runtime/declarations/maps for payload duplication, accidental public
  exports, runtime resolution, license presence, and worker-source readability.
- [x] Measure and record the packed/unpacked size delta; treat an unexplained or disproportionate
  increase as a review finding, not an automatic acceptance.
- [x] Run the `doublecheck` skill against the completed implementation, resolve every valid
  finding, and rerun affected plus full gates.
- [x] Finalize exact validation counts/evidence in `PROGRESS.md`, the archived issue, and this plan's
  tracker/status.

**Completion evidence:** The final tree passes a clean build and deterministic generated-source
check; 1038/1038 tests across 37 suites, including `--detectOpenHandles`; lint with 0 errors and
118 existing warnings; formatting; isolated packed execution; the example build; production and
embedded-input audit gates; and diff checks. The final v0.22.1 dry-run package is 264,882 bytes
packed and 1,390,495 bytes unpacked across 220 files, a measured +22,695/+110,970 bytes and +5 files versus
published v0.22.0. Independent double-check reviewers cleared runtime/package correctness,
security/licensing/install buckets, and documentation after their findings were resolved.

**Verification commands**:

- [x] `npm.cmd run generate:zip-worker` (intentional generation only)
- [x] `npm.cmd run check:zip-worker`
- [x] `npm.cmd run clean`
- [x] `npm.cmd run build`
- [x] Focused archive/BinaryManager Jest suites
- [x] `npm.cmd test`
- [x] `npm.cmd run lint`
- [x] `npm.cmd run format`
- [x] `npm.cmd run check:zip-worker` again after formatting
- [x] `npm.cmd run test:packed-api`
- [x] `npm.cmd --prefix examples/electron-control-panel run build`
- [x] `npm.cmd audit --omit=dev`
- [x] `npm.cmd run audit:embedded`
- [x] Full `npm.cmd audit` report, distinguishing known development-only findings
- [x] `npm.cmd pack --dry-run --json`
- [x] `git diff --check`
- [x] `git status --short`

## Documentation

One new non-plan document is required: `THIRD_PARTY_NOTICES.md`, whose durable audience is
downstream users, packagers, auditors, and maintainers who need the license and provenance of code
embedded inside the published worker. Existing project `LICENSE`, user guides, source comments,
tests, and the issue cannot replace a shipped third-party notice without conflating ownership or
being omitted from the npm package.

No new packaging guide, migration guide, completion report, devlog, or design-summary document is
needed. Existing integration/setup guides own consumer behavior, `DESIGN.md` owns architecture,
`docs/dev/UPDATING-BINARIES.md` owns maintenance, `PROGRESS.md` owns Unreleased status, the issue
owns the incident/resolution, and this plan is the implementation tracker/design record.

## Risks and Mitigations

- **Embedded vulnerabilities become invisible to production dependency audits**: retain exact
  `adm-zip` as a development dependency, keep full-audit/dependency-update visibility, embed
  version/hash/license, document the update workflow, and require regeneration plus isolated
  execution for every bump.
- **Generated bytes drift by platform or tool version**: exact-pin both inputs; fix target, format,
  working directory, source identity, newlines, banner, and absence of timestamps/absolute paths;
  let Windows/macOS/Linux builds run the same byte check.
- **Generated file becomes an unreviewable second implementation**: generate only the third-party
  constructor preamble and retain the typed extraction loop in `archive-utils.ts`.
- **Consumer bundling rewrites or omits a worker asset**: keep the complete worker source as an
  inert string passed to `Worker(..., { eval: true })`; ship no path-dependent worker asset.
- **CommonJS/ESM mismatch inside Electron**: build the inner payload explicitly for Node/CommonJS
  eval-worker semantics and execute it through existing real worker tests plus the isolated ESM
  main-bundle smoke.
- **License removal during minification/generation**: inject the full notice as a literal banner,
  verify it in `--check`, ship `THIRD_PARTY_NOTICES.md`, and inspect the packed output.
- **Package/declaration/map bloat**: annotate the payload as `string`, disable inner source maps,
  keep the generated module internal, inspect emitted declarations/maps, and measure pack size.
- **Downstream workaround removed too early**: state that removal follows adoption of a released
  fixed version; this unreleased repository change alone is not sufficient.

## Rollback

Before release, the generated embedding can be reverted as a unit without affecting user data,
downloaded models, binary caches, metadata schemas, or public APIs. However, rollback must never
restore the eager package-root resolve. If the bundle-only packaging guarantee is withdrawn,
restore `adm-zip` as a runtime dependency only together with a lazy, ZIP-path-only guarded resolver
whose missing-module failure maps through the typed provisioning contract; otherwise leave the
issue open rather than claiming it is fixed.

After a release, rollback requires a new patch release because published bundles may rely on the
self-contained worker and may have removed staged `adm-zip`. Do not silently restore runtime
resolution under the same package version.

## Open Questions

None. The packaging contract, prebundling strategy, exact pins, committed generation, licensing,
absence of runtime fallback, and acceptance gate were settled in discussion. If implementation
reveals that esbuild 0.28.1 cannot generate a cross-platform deterministic Node 22 payload, stop and
return for approval rather than silently changing the agreed generator/toolchain.

---

**Implementation approval and completion:** Approved and completed on 2026-08-05. The task tracker
and completion evidence above are the authoritative execution record.
