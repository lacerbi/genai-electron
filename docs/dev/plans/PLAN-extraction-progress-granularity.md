# Plan: Extraction Progress Granularity

Created: 2026-08-13
Status: COMPLETE (2026-08-13)

## Execution Tracker

- [x] Phase 1: Worker byte telemetry
- [x] Phase 2: Public mapping and installation phase
- [x] Phase 3: Regression and package coverage
- [x] Phase 4: Documentation and durable issue record
- [x] Phase 5: Full project verification and final double-check

## Summary

Make first-run binary provisioning accurately observable during large Windows ZIP extraction and
during the post-validation installation tail. The existing self-contained `adm-zip` worker will
retain its extraction, path-containment, responsiveness, packaging, and error contracts while
adding throttled cumulative write-byte telemetry alongside the existing entry counters.
`BinaryProgressEvent` will also gain an `installing` phase, and extraction will no longer represent
a missing progress denominator as 100%.

## Current-State Findings

- `zipExtractionWorkerMain()` emits once before extraction and once after each
  `extractEntryTo()` call. A large ZIP member therefore produces no intermediate event.
- `ArchiveExtractionProgress` carries only entry counts; `BinaryManager.extractionProgress()` maps
  those counts to public `BinaryProgressEvent` values and currently maps `totalEntries === 0` to
  `percent: 100`.
- Main-archive collision checking occurs after extraction and before `testing`. Candidate copying,
  dependency installation, metadata/checksum writes, the recoverable directory swap, and backup
  cleanup occur after `testing` and have no subsequent progress phase.
- The embedded `adm-zip` API accepts a custom filesystem implementation. Its extraction path writes
  each fully inflated entry through `writeSync`, so a worker-local adapter can split that write into
  bounded chunks and report bytes actually written without replacing `extractEntryTo()`.
- `adm-zip` still inflates a complete member before writing it. This plan improves write progress;
  it does not claim streaming decompression progress.
- On flat Windows archives, candidate assembly can copy dependency files through the directory copy
  and then explicitly copy them again. That performance concern is related but is not required to
  correct the public observability contract.

## Scope

- **In scope**:
  - Add optional cumulative ZIP write-byte fields to the internal archive progress protocol and the
    public `BinaryProgressEvent`.
  - Keep `completedEntries` / `totalEntries` intact and monotonic for compatibility.
  - Derive extraction `percent` from valid uncompressed-byte progress when available, with entry
    progress as the compatibility fallback and no percentage when no positive denominator exists.
  - Add and emit a public `installing` phase for successful candidate assembly and publication.
  - Bound worker-to-parent progress traffic through whole-percent/chunk throttling while retaining
    entry-completion events.
  - Update focused unit/integration/packed-package coverage, living API and maintainer docs, the
    root issue, and `PROGRESS.md`.
- **Out of scope**:
  - Replacing `adm-zip`, adding a runtime dependency, changing its exact pin, regenerating its
    committed preamble, or implementing a custom ZIP parser.
  - Streaming inflate progress or changing the archive extraction/security/error behavior.
  - Byte progress for the existing `tar.x()` path.
  - Percentage progress for candidate installation.
  - Optimizing or deduplicating candidate/dependency copies.
  - New progress phases for cached-dependency staging, cleanup, or already-installed fast paths.
  - Binary-version changes, package-version changes, migration guides, releases, tags, publication,
    or downstream application changes.

## Public Contract

`BinaryProgressEvent` will remain additive and phase-specific:

```typescript
interface BinaryProgressEvent {
  phase: 'downloading' | 'extracting' | 'verifying' | 'testing' | 'installing';
  file: string;
  downloaded?: number;
  total?: number;
  percent?: number;
  completedEntries?: number;
  totalEntries?: number;
  writtenBytes?: number;
  totalUncompressedBytes?: number;
}
```

- `writtenBytes` is the cumulative number of uncompressed ZIP payload bytes successfully written
  for the current archive.
- `totalUncompressedBytes` is the sum of valid non-directory central-directory sizes and is used
  only as progress metadata. It must not drive allocation, extraction, or containment decisions.
- For ZIP extraction, `percent` uses `writtenBytes / totalUncompressedBytes` when the total is a
  positive safe integer. If byte totals are unavailable or zero and `totalEntries > 0`, it falls
  back to `completedEntries / totalEntries`. Otherwise `percent` is omitted.
- Entry counters retain their current meaning. Byte-progress callbacks may occur without an entry
  completing, and entry-completion callbacks continue even when the whole-number byte percentage
  is unchanged.
- `installing` is a phase-only event emitted with `file: 'binary'` after validation succeeds and
  before candidate assembly. It covers copying/permissions, manifest and validation metadata,
  candidate checksum calculation, atomic publication/restoration handling, and backup cleanup.

## Phases

### Phase 1: Worker Byte Telemetry

**Goal**: Report real progress while a large ZIP member is being written without weakening the
existing worker or `adm-zip` extraction boundary.

**Work**:

- Extend `ArchiveExtractionProgress` and `ZipWorkerMessage` in
  `src/utils/archive-utils.ts` with optional `writtenBytes` and
  `totalUncompressedBytes` fields.
- Extend the worker-local ZIP entry shape only enough to read the uncompressed `header.size` used
  for progress metadata.
- Calculate a total only when every contributing size is finite, non-negative, and safely
  representable and the aggregate sum remains a safe integer; otherwise leave the byte denominator
  unavailable.
- Construct `AdmZip` with a worker-local filesystem adapter that delegates every operation except
  buffer `writeSync` unchanged. The adapter will:
  1. preserve the requested buffer range and file position;
  2. complete partial native writes safely and reject a zero-byte write rather than loop;
  3. split large writes into bounded chunks;
  4. advance telemetry only after native writes succeed; and
  5. return the same total byte count expected by `adm-zip`.
- Associate byte callbacks with the active canonical entry while continuing to use
  `extractEntryTo()` for extraction and containment.
- Emit an initial zero-byte/count event, throttled intermediate byte events, every entry-completion
  event, and a final state consistent with the actual successful writes.
- Keep consumer-callback exceptions isolated in the parent exactly as they are today.

**Verification**:

- [x] A real ZIP containing one entry larger than the write chunk produces at least one event with
  `writtenBytes > 0` while `completedEntries` is still unchanged.
- [x] Byte counts are monotonic and finish at the fixture's uncompressed payload size.
- [x] Entry counts retain the current initial and per-entry sequence.
- [x] Empty files, nested files, traversal-like names, corrupt ZIPs, callback exceptions, worker
  exit settlement, and main-thread heartbeat behavior retain their current results.
- [x] Progress traffic is bounded independently of a large member's raw byte size.

### Phase 2: Public Mapping and Installation Phase

**Goal**: Expose meaningful extraction percentages and name the long candidate-installation tail.

**Work**:

- Extend `BinaryProgressEvent` in `src/types/servers.ts` with `installing`, `writtenBytes`, and
  `totalUncompressedBytes`, with exact phase-specific JSDoc.
- Extend `BinaryManager.extractionProgress()` to forward byte and entry telemetry and implement the
  byte-first/fallback/omit percentage rules from the public contract.
- Preserve integer clamping to the valid 0-100 range and monotonicity for well-formed worker input.
- Emit `{ phase: 'installing', file: 'binary' }` immediately after `testBinary()` succeeds and
  before the candidate directory is created or populated. Do not emit it for a failed validation.
- Keep `ServerManager`'s shared forwarding path unchanged except for its descriptive comments; both
  llama and diffusion managers receive the additive payload automatically.

**Verification**:

- [x] Public extraction events forward the new byte fields alongside unchanged entry counters.
- [x] Extraction `percent` follows byte progress when its denominator is valid.
- [x] Entry percentage remains the fallback when byte telemetry is absent.
- [x] A zero/unknown denominator omits `percent` rather than emitting 100.
- [x] `installing` follows `testing` and precedes the first candidate-assembly filesystem action.
- [x] Variants that fail validation do not falsely report installation, while a later successful
  fallback does; a variant that enters installation and then fails may accurately have emitted the
  phase before fallback.
- [x] Calling without `onProgress`, or with a throwing listener at the archive callback boundary,
  does not alter provisioning behavior.

### Phase 3: Regression and Package Coverage

**Goal**: Lock the semantics into focused tests and prove the self-contained bundled-worker
contract remains intact.

**Work**:

- Update `tests/unit/archive-utils.test.ts` worker mocks and assertions for byte-field forwarding,
  initial/final state, and callback isolation.
- Extend `tests/integration/archive-utils.test.ts` with a deterministic single-large-entry fixture
  that proves within-entry progress, plus final byte/count/content assertions.
- Update `tests/unit/BinaryManager.test.ts` for byte-preferred percentages, entry fallback,
  zero-total omission, phase ordering, failed-variant behavior, and compatibility without a
  callback.
- Extend `tests/integration/BinaryManager-cache.test.ts` only where needed to confirm the shared
  real-filesystem provisioning path emits `installing` without regressing dependency reuse.
- Extend `scripts/packed-api/run.mjs` so the isolated bundle smoke verifies the new byte fields on a
  real ZIP while `adm-zip` remains unresolvable and the existing containment/content checks remain.
  The dedicated integration fixture, not the packed smoke, owns the multi-chunk assertion.
- Do not regenerate `src/generated/adm-zip-worker-source.ts`; the ordinary freshness check must
  prove the embedded preamble is unchanged.

**Verification**:

- [x] Focused archive and BinaryManager unit/integration suites pass.
- [x] `npm run test:packed-api` passes from the packed, isolated runtime.
- [x] Generated declarations contain the additive public fields and `installing` union member.
- [x] The generated ZIP-worker freshness check passes without modifying generated source.

### Phase 4: Documentation and Durable Issue Record

**Goal**: Make the revised semantics usable by hosts and preserve the reason and acceptance
evidence without creating redundant documentation.

**Work**:

- Update the binary-management description in `DESIGN.md` from entry-only extraction progress to
  byte-plus-entry progress and the installation phase.
- Update current consumer guidance in:
  - `genai-electron-docs/llm-server.md`;
  - `genai-electron-docs/image-generation.md`;
  - `genai-electron-docs/installation-and-setup.md`;
  - `genai-electron-docs/troubleshooting.md`; and
  - `genai-electron-docs/typescript-reference.md`.
- Update examples to guard optional `percent` rather than asserting it whenever an entry total is
  present, and explain that write-byte progress does not imply streaming decompression.
- Do not rewrite historical migration guides; they describe the contracts of their releases. Do
  not create a new migration guide before an explicitly requested release.
- Add a concise `Unreleased` entry to `PROGRESS.md` rather than changing the current package
  version.
- Correct the phase-order wording in `ISSUE-extraction-progress-granularity.md`, record the final
  resolution and exact validation evidence after implementation, and move the resolved issue to
  `docs/dev/issues/`.
- When implementation and verification are complete, mark this plan `COMPLETE` and move it to
  `docs/dev/plans/`; the archived plan owns the design decisions and verification checklist, so no
  separate completion report or devlog is needed.

**Verification**:

- [x] Every current extraction-progress description agrees on field meaning, percentage basis,
  phase ordering, optionality, and the inflate-versus-write limitation.
- [x] Historical release and migration documentation remains unchanged.
- [x] The root contains no resolved issue or completed implementation plan after archival.

### Phase 5: Full Project Verification

**Goal**: Satisfy the repository's release-independent quality gates without performing release
work.

**Steps**:

1. [x] Run Prettier on the changed files, then `npm run format:check`.
2. [x] Run the focused archive/BinaryManager tests.
3. [x] Run `npm run build` (including the generated-worker freshness check).
4. [x] Run `npm run lint` and distinguish pre-existing warnings from new errors/warnings.
5. [x] Run `npm test`.
6. [x] Run `npm run test:packed-api`.
7. [x] Run `git diff --check`, inspect `git status --short`, the unstaged diff, and any staged diff,
   preserving unrelated user changes.
8. [x] Perform a final implementation double-check against this plan and the resolved issue before
   reporting completion.

**Optional live acceptance**:

- If the maintainer explicitly authorizes another deliberate Windows/CUDA re-provision, capture
  the event stream for a large llama.cpp dependency and confirm that byte percentages advance
  within `cublasLt64_12.dll` and that `installing` owns the candidate-copy tail. Automated
  synthetic coverage remains the required gate; destructive renaming or large network downloads
  are not implicit in this plan.

## Documentation Ownership

- The current API guides and TypeScript reference own consumer-facing semantics and examples.
- `DESIGN.md` owns the architectural worker/BinaryManager capability.
- `PROGRESS.md` owns the concise unreleased project status.
- The archived issue owns the observed downstream incident and resolution evidence.
- The archived plan owns implementation sequencing, deliberate exclusions, decisions, and
  verification criteria. No new migration guide, completion report, or parallel design document is
  justified before release.

## Decisions

- **Measure successful uncompressed bytes written** — this is observable through `adm-zip`'s
  supported custom filesystem seam while retaining `extractEntryTo()`. Rejected: claim streaming
  extraction bytes from entry header sizes alone (still stalls inside a member), or replace/fork
  the extractor to expose inflate chunks (larger security and packaging surface).
- **Name fields `writtenBytes` and `totalUncompressedBytes`** — the names state exactly what is
  measured and avoid overloading download-only `downloaded` / `total`. Rejected: reuse those
  download fields (ambiguous phase-dependent meaning) or use generic `completedBytes` (would imply
  inflation is also measured).
- **Make extraction `percent` byte-first with an entry fallback** — existing percent-only hosts
  improve automatically while entry counters remain compatible. Rejected: leave `percent`
  entry-derived and require every host to compute a second percentage, or add a competing
  `bytePercent` field.
- **Use one post-validation `installing` phase** — it is stable, user-facing language for the full
  candidate assembly/publication transaction. Rejected: expose internal `staging` terminology, or
  leave `testing` as the last event while unrelated copying continues.
- **Throttle in the worker and always retain entry completion** — this bounds cross-thread traffic
  closest to its source without losing compatibility events. Rejected: emit every native write or
  discard entry events when the rounded byte percentage is unchanged.
- **Keep copy optimization separate** — duplicate dependency copying may affect duration, but
  changing it alters the provisioning transaction and deserves its own evidence and regression
  scope. Rejected: silently fold a performance rewrite into an observability fix.
- **Keep tar behavior unchanged** — the reported incident and available byte seam are specific to
  Windows ZIP provisioning. Rejected: invent estimated tar progress without a verified equivalent
  contract.

## Risks and Mitigations

- **Extra write calls or progress messages reduce extraction performance** — use bounded chunks and
  whole-percent throttling; compare focused fixture timing for gross regressions.
- **Declared ZIP sizes are malformed or hostile** — validate sizes as progress metadata only,
  avoid allocation or filesystem decisions from them, clamp public percentages, and preserve
  `adm-zip`'s existing CRC/output/path checks.
- **Consumers assume extraction percentages are entry-derived** — retain entry counters, make all
  new fields optional, document the improved byte-first basis, and cover the exact mapping.
- **The serialized worker behaves differently after bundling** — retain the packed isolated real-ZIP
  smoke and generated-preamble freshness gate.
- **Write progress still pauses during inflation** — state the limitation explicitly and require a
  separate proposal if real-archive evidence shows inflation, rather than writing, dominates the
  remaining stall.

## Open Questions

None. Approval accepts the decisions and exclusions above; the optional destructive/live CUDA
acceptance still requires separate authorization at execution time.

## Outcome

Implemented the additive ZIP write-byte telemetry and post-validation `installing` phase without
changing the pinned extractor, generated preamble, tar behavior, or release state. Added public,
unit, real-archive integration, real-filesystem provisioning, and isolated packed-consumer
coverage; updated current API, setup, troubleshooting, maintainer, architecture, progress, and
issue documentation while leaving historical migration material unchanged.

Final validation passed 94/94 focused tests and 1046/1046 full tests across 37 suites with
`--detectOpenHandles` and no reported handles, plus build/generated-worker freshness, formatting,
packed-consumer, and `git diff --check` gates. ESLint passed with 0 errors and the existing 118
warnings. Three independent frontier-strength double-check tracks covered worker/security,
API/tests, and docs/integration; their low-severity completeness findings were corrected and no
substantive implementation defect remains.

The optional live acceptance was subsequently completed with the two checksum-verified pinned
Windows/CUDA b9860 archives pre-seeded into an isolated Electron profile. It passed the planned
criteria without download traffic: both real archives emitted monotonic within-entry byte progress,
and `installing` followed validation and covered successful candidate publication. The run used an
isolated profile and did not target the active Palimpsest installation; the later settlement
follow-up explicitly recorded four active-installation sentinel hashes, its root timestamp, and its
healthy endpoint before and after provisioning. Because a GUI-owned llama server became active
during setup, the isolated candidate used basic `--version` validation rather than starting a
second real-model GPU process. The 115.7-second run additionally found 34.7-second and 51.2-second
gaps between the final archive events and worker settlement; that narrower teardown observation is
recorded in the resolved issue for separate follow-up. The follow-up subsequently added immediate
`finalizing` telemetry while preserving worker-exit-before-resolution; see
`docs/dev/issues/ISSUE-zip-worker-settlement-gap.md`.
