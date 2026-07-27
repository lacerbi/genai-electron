# Plan: Binary Provisioning Robustness

Created: 2026-07-27
Status: COMPLETE — follow-ups folded in (2026-07-27)

## Summary

Make first-run and version-change binary provisioning responsive, resumable at verified archive
boundaries, and observable after both success and failure. The work covers both llama.cpp and
stable-diffusion.cpp provisioning, while keeping the public start APIs and binary variant policy
unchanged.

This plan is the implementation contract required by the planning workflow. The incident,
acceptance criteria, and eventual resolution evidence remain owned by
[`ISSUE-binary-provisioning-robustness.md`](../issues/ISSUE-binary-provisioning-robustness.md);
existing user and maintainer guides remain authoritative for runtime behavior.

## Scope

- **In scope**: worker-thread ZIP extraction with entry progress; checksum-addressed dependency
  reuse; clean staging and verified archive reuse after interruption; diffusion Phase-2 offload
  parity; line-aware GPU diagnostics; durable provisioning logs; tests and existing documentation.
- **Out of scope**: HTTP range-resume for `.partial` files; new archive dependencies; binary pin or
  package-version changes; healing a hypothetical already-cached lower-priority variant; release,
  tag, or publication work.

## Decisions

- Keep `adm-zip` 0.6.x and run ZIP construction plus per-file extraction in an inline
  `worker_threads` worker. Resolve the installed `adm-zip` module from the library and pass its
  absolute path through `workerData`; this avoids a separately packaged worker asset and works when
  Jest executes TypeScript sources directly.
- Preserve hardened `adm-zip` path handling by extracting each non-directory entry with
  `extractEntryTo()`. The worker reports completed/total entries and the sanitized relative file
  list; tar extraction remains on the existing async path.
- Add optional `completedEntries` and `totalEntries` fields to `BinaryProgressEvent` instead of
  overloading download byte counters. Existing event fields and `'binary-log'` behavior remain
  compatible.
- Store `.deps.json` entries as `{ url, checksum, files }`, match by checksum (URLs can move), and
  validate every relative path. On a hit, stage installed dependency files into the clean candidate
  directory with asynchronous copy-on-write/copy—no network transfer or inflation. Do not hard-link
  staging to permanent files: a same-named main-archive entry could otherwise mutate the installed
  dependency through the shared inode.
- Commit dependency-manifest entries atomically only after the candidate passes Phase 1/2 and its
  files are installed permanently. Prune entries whose checksums are no longer configured.
- Diffusion validation uses the same resolver as production for `clipOnCpu`, `vaeOnCpu`,
  `offloadToCpu`, and `diffusionFlashAttention`. Batch size and thread count remain outside the
  tiny validation command.
- GPU diagnostics are matched at diagnostic-line starts while preserving known upstream function
  prefixes such as `ggml_cuda_host_malloc: CUDA error: ...`.
- Initialize each normal server's existing per-server `LogManager` before provisioning and keep
  that instance through startup/error handling. No buffering layer or new log file is introduced.

## Phase 1: Responsive ZIP Extraction and Structured Progress

**Goal**: Windows ZIP parsing and inflation never run on the Electron main thread, and consumers
receive visible entry-level extraction progress.

**Work**:

- [x] Add an internal inline worker extraction boundary in `src/utils/archive-utils.ts`, including
  single-settlement error/exit handling and worker cleanup.
- [x] Route both `extractBinary()` and `extractArchive()` ZIP paths through the worker; leave
  `tar.x()` behavior unchanged and preserve `FileSystemError` wrapping.
- [x] Return/collect sanitized extracted file paths for dependency bookkeeping without exporting a
  new package-root API.
- [x] Extend `BinaryProgressEvent` in `src/types/servers.ts` with optional entry counters and wire
  worker progress through the main-binary and dependency extraction callbacks in
  `src/managers/BinaryManager.ts`.

**Verification**:

- [x] Real ZIP and tar fixtures still extract nested files and locate binaries.
- [x] A scheduled main-thread heartbeat runs while ZIP extraction is in flight.
- [x] ZIP entry progress is monotonic and reaches completed = total for both archive consumers.
- [x] Worker failures reject once with the existing archive error contract and leave no open worker.

## Phase 2: Dependency Cache and Interrupted-Provisioning Recovery

**Goal**: Re-provisioning reuses already installed byte-identical dependencies and complete verified
archives, while never mixing stale staging residue with fresh content.

**Work**:

- [x] Add validated load/save/prune helpers for atomic
  `PATHS.binaries[type]/.deps.json` persistence in `src/managers/BinaryManager.ts`.
- [x] Clean `<binary>.<variant>.extract/` as the first variant action and fail safely if cleanup
  cannot complete.
- [x] Consolidate main/dependency archive handling behind a helper that reuses a bare archive only
  after its configured SHA-256 matches, deletes mismatches, and otherwise streams a fresh download.
- [x] On a dependency-manifest hit, validate contained relative paths and materialize the recorded
  installed files into clean staging via asynchronous copy-on-write/copy before candidate tests.
- [x] On a cache miss, retain the verified dependency archive through candidate testing, carry its
  extracted file list as pending state, and commit/replace manifest entries only after successful
  permanent installation.
- [x] Preserve current successful-run cleanup of large archives; leave `.partial` range-resume
  explicitly deferred.

**Verification**:

- [x] Same checksum with a changed release URL skips dependency download and inflation.
- [x] Missing/corrupt manifest data or missing installed files safely reprovisions.
- [x] A changed dependency checksum misses and invalidates the obsolete entry.
- [x] Valid main and dependency archives left by a hard kill are verified and reused.
- [x] A stale extract directory is removed before any dependency materialization or extraction.
- [x] Failed candidates never commit transient dependency state or corrupt an existing valid entry.

## Phase 3: Production-Parity Validation and Durable Logs

**Goal**: Binary selection tests the workload production would actually launch, and every
provisioning line is retained in the normal server log.

**Work**:

- [x] Introduce one internal resolved-diffusion-optimization shape and one shared flag mapper in
  `src/managers/DiffusionServerManager.ts`.
- [x] Resolve validation flags before `ensureBinary()`, pass them through
  `ServerManager.ensureBinaryHelper()` as a distinct internal `BinaryManagerConfig` field, and
  append them to the Phase-2 diffusion command.
- [x] Establish calibration's synthetic `_config` before provisioning so the shared resolver cannot
  read undefined or stale manager state; preserve the existing `finally` restoration.
- [x] Replace substring GPU-error matching in `src/managers/BinaryManager.ts` with line-aware,
  case-insensitive diagnostics that accept known function prefixes but ignore prose mentions.
- [x] Move normal llama and diffusion log initialization before `ensureBinary()` and replace the
  later reinitialization with an awaited startup/port log line.

**Verification**:

- [x] Low-VRAM and explicit override cases pass the same offload/flash-attention flags to validation
  that production argument building uses.
- [x] Calibration provisioning uses its synthetic config and restores prior state.
- [x] Genuine direct and function-prefixed GPU errors still trigger fallback; mid-line prose does
  not.
- [x] Both managers persist provisioning output on successful starts and all-variant failures, with
  logger initialization preceding `BinaryManager.ensureBinary()`.

## Phase 4: Regression Coverage and Documentation

**Goal**: Lock each acceptance criterion into tests and update only the existing authoritative
artifacts.

**Work**:

- [x] Expand `tests/integration/archive-utils.test.ts` and
  `tests/unit/archive-utils.test.ts` for worker extraction, progress, responsiveness, and errors.
- [x] Expand `tests/unit/BinaryManager.test.ts` for manifest hits/misses, staged dependency files,
  archive reuse, stale cleanup ordering, progress, atomic persistence, and diagnostic matching.
- [x] Expand `tests/unit/LlamaServerManager.test.ts`,
  `tests/unit/DiffusionServerManager.test.ts`, and
  `tests/unit/diffusion-calibration.test.ts` for early durable logs and validation-flag parity.
- [x] Update `genai-electron-docs/installation-and-setup.md`,
  `genai-electron-docs/llm-server.md`, `genai-electron-docs/image-generation.md`,
  `genai-electron-docs/typescript-reference.md`, `genai-electron-docs/troubleshooting.md`, and
  `docs/dev/UPDATING-BINARIES.md` with extraction progress, dependency reuse, validation parity,
  and durable-log behavior.
- [x] Add an Unreleased entry to `PROGRESS.md` without a version bump or release action.
- [x] After all acceptance checks pass, mark the root issue resolved with validation evidence and
  move it to `docs/dev/issues/` using repository convention.

**Verification**:

- [x] Source event types and all documented examples describe byte progress versus entry progress
  consistently.
- [x] The resolved issue, PROGRESS entry, and maintainer guide agree on cache invalidation and test
  behavior.
- [x] No migration guide or new summary document duplicates existing ownership.

## Phase 5: Final Validation

**Goal**: Demonstrate correctness across supported platforms and packaging boundaries.

**Work**:

- [x] Run focused archive, binary-manager, server-manager, and calibration tests.
- [x] Run `npm run format`, `npm run build`, `npm run lint`, and the full `npm test`.
- [x] Run `npm pack --dry-run` and inspect emitted runtime/declaration files so the inline worker and
  additive event fields are represented correctly.
- [x] Run `git diff --check`, inspect the complete diff for unrelated changes, and execute the
  mandatory implementation `/doublecheck`.

**Acceptance mapping**:

- Responsive window: Phase 1 worker boundary + heartbeat integration test.
- Dependency not re-downloaded: Phase 2 checksum manifest + cache-hit regression.
- Clean restart after kill: Phase 2 entry cleanup + verified bare-archive reuse regressions.
- Production offload parity: Phase 3 shared resolver/mapper + manager/BinaryManager command tests.
- Durable provisioning log: Phase 3 early shared logger + success/failure ordering tests.

## Risks and Rollback

- Worker extraction changes timing and error delivery. Real ZIP compatibility, path containment,
  single-settlement, and open-handle tests guard the boundary.
- Copy-on-write may be unavailable on the target filesystem; Node's asynchronous copy fallback
  preserves correctness at higher I/O cost without re-downloading, reinflating, or blocking the
  main event loop.
- A user can delete dependency DLLs while leaving `.deps.json`; existence/materialization checks
  turn that into a cache miss, while checksum re-verification of installed DLLs remains intentionally
  out of scope.
- Start-time VRAM availability can differ from generation-time availability after orchestration.
  The algorithm and precedence are shared; the resolved values correctly reflect each call's actual
  moment.
- Rollback is source-only. Deleting `.deps.json` is safe and forces ordinary dependency
  provisioning; existing binary and validation caches remain backward-compatible.

## Open Questions

- None blocking. The user pre-authorized execution after the mandatory plan double-check if no
  crucial design decision remained.

## Plan Doublecheck

- [x] Confirmed every issue acceptance criterion maps to implementation and regression coverage.
- [x] Confirmed the inline worker avoids source-test and packaged-worker path divergence without a
  new runtime dependency.
- [x] Corrected cached dependency staging from hard links to asynchronous copy-on-write/copy so
  main-archive overwrites cannot mutate permanent cached files through a shared inode.
- [x] Confirmed calibration config ordering, success/failure log draining, manifest commit timing,
  path containment, documentation ownership, rollback, and unreleased workflow are covered.
- [x] No blocking product, API, release, or migration decision remains.

## Implementation Doublecheck

- [x] Independent implementation review found no blocker against the issue's five acceptance
  criteria; a second focused review confirmed diffusion flag parity, calibration ordering, durable
  logging, progress-field consistency, and a clean build/test result.
- [x] Closed both medium-risk findings from the review: simultaneous `start()` calls can no longer
  share provisioning artifacts, and a main archive is rejected if it collides with a
  dependency-owned path. Both have regression coverage.
- [x] The local audit additionally constrained tar bookkeeping to the current archive, added
  traversal-like ZIP and unsafe manifest-path regressions, and corrected stale extraction-progress
  documentation.
- [x] Pre-Phase-6 validation passes: 215/215 focused tests; 631/631 tests across 25 suites with
  `--detectOpenHandles`; clean TypeScript build; format check; lint with 0 errors and the existing
  61 warnings; 163-file package dry run; emitted runtime/declaration inspection; and
  `git diff --check`.
- [x] ~~Two non-blocking follow-ups remain intentionally outside this issue: opportunistic cleanup
  of hard-kill residue after an already-installed binary takes the validation fast path, and a
  real-filesystem cross-instance dependency-manifest integration test.~~ Both were subsequently
  folded into Phase 6 below.

## Phase 6: Folded-in Lifecycle Follow-ups

**Goal**: Close the remaining cleanup edge case and verify dependency-cache persistence through the
real filesystem and archive stack.

**Work**:

- [x] Add best-effort cleanup of main archives, extraction directories, and manifest-backed
  dependency archives before a validated installed binary returns from
  `BinaryManager.ensureBinary()`.
- [x] Add a real-filesystem integration test that provisions a dependency, creates `.deps.json`,
  constructs a fresh manager, and proves the second run skips dependency download and extraction.
- [x] Preserve dependency archives that lack a matching committed manifest entry so the
  install-before-manifest kill window retains its only reusable recovery copy.
- [x] Strengthen the real-filesystem regression to verify the cached dependency is physically
  staged beside the second candidate when validation begins.
- [x] Update the resolved issue, `PROGRESS.md`, and this plan with the folded-in behavior and final
  validation evidence.

**Verification**:

- [x] Run focused cleanup/cache tests with `--detectOpenHandles` (58/58).
- [x] Run build, lint, repository formatting, the complete 634/634 test suite across 26 suites,
  package dry run, emitted output inspection, and `git diff --check`.
- [x] Run the task workflow's final `/doublecheck` and resolve all blocking findings.

**Completion:** The final review exposed the install-before-manifest kill window. Manifest-aware
dependency-archive cleanup, its recovery regression, and the spawn-time cached-DLL assertion were
added; re-review found no remaining blocker.

---

**Review gate:** PASSED. Implementation, folded-in follow-ups, and validation complete.
