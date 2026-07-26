# Plan: Hugging Face Download Provenance

Created: 2026-07-26
Status: COMPLETE — repository-wide formatting baseline exception documented

## Summary

Correct Hugging Face URL construction for nested repository paths, add optional revision selection
and parsing across every structured Hugging Face download path, and persist a normalized source
locator for every diffusion component. The change will remain backward-compatible with existing
two-argument helper calls and stored metadata, and will be accumulated as an unreleased batch with
no version bump or release action.

## Task Understanding

The implementation must address all validated items in
[`ISSUE-genai-electron-huggingface-downloads.md`](../issues/ISSUE-genai-electron-huggingface-downloads.md):

- Preserve repository path separators while encoding each file-path segment.
- Allow callers to select a Hugging Face branch, tag, or commit revision, defaulting to `main`.
- Parse non-`main` resolve URLs and return the decoded revision.
- Preserve structured source information for all files in a multi-component diffusion model.

Only a full commit SHA is an immutable pin; branches and tags are selectable but movable. Downstream
range requests that followed the redirect confirmed that Hugging Face serves byte-identical content
for legacy `%2F` paths and literal nested paths (with a bogus-path `404` control), so the path change
is correctness and portability hardening rather than a production-outage repair.

## Design Decisions

- `getHuggingFaceURL(repo, file, revision = 'main')` accepts a raw revision, encodes the entire
  revision as one URL segment, and encodes file paths per segment so literal `/` separators remain.
- Omitted revisions default to `main`. Explicit empty/whitespace-only revisions are invalid rather
  than silently producing a malformed URL or normalizing to a different ref. Callers pass raw,
  unencoded revisions; already encoded values are encoded again by design.
- `parseHuggingFaceURL()` returns decoded `{ repo, revision, file }` data. It supports both newly
  generated literal nested paths and legacy URLs whose file separators are encoded as `%2F`.
- The parser supports both single-segment repo IDs (`gpt2`) and namespaced IDs (`owner/repo`) and
  locates the route marker by those known URL shapes rather than an ambiguous global
  `indexOf('resolve')`. For the inherently ambiguous route where a single-segment repo revision and
  a namespaced repo name are both `resolve`, the namespaced repo shape takes precedence.
- `revision?: string` remains optional on input and persisted types for source compatibility and
  legacy metadata. New structured Hugging Face records persist the effective revision, including
  `main` when the caller omits it.
- `DiffusionComponentInfo.source?: ModelSource` remains optional for legacy records, but every new
  multi-component record populates it for every role, including `diffusion_model`.
- Component `source` means the configured/resolved locator associated with the component. It is not
  forensic proof of which network endpoint originally supplied a reused shared file.
- The primary component and top-level `ModelInfo.source` will derive from one canonical
  normalization result and be assigned as separate objects so they cannot drift or alias mutable
  state.
- Direct URL sources remain authoritative and omit incidental `repo`, `file`, and `revision`
  properties.

## Scope

- **In scope**:
  - Public helper behavior and JSDoc in `src/download/huggingface.ts`.
  - Additive public type fields in `src/types/models.ts`.
  - Revision propagation through single-file, multi-component, and derived-shard downloads.
  - Per-component source persistence, including skipped/reused shared components.
  - Focused unit and local integration coverage.
  - Living API/design documentation and a concise `PROGRESS.md` Unreleased entry.
  - The downstream `%2F` validation amendment and future sd.cpp pin release-note rule requested
    during final review.
  - Generated `dist` verification through the normal TypeScript build.
- **Out of scope**:
  - Acquisition-history or chain-of-custody metadata for shared files.
  - Reconstructing unknown sources for legacy installed components.
  - License metadata, automatic remote checksum discovery, or resolved-commit capture from response
    headers.
  - Per-shard provenance for caller-supplied full shard URLs.
  - Automatic parsing of direct URLs into structured Hugging Face sources.
  - Dataset/Space URL variants and ambiguous raw slash-bearing revision URLs; generated revisions
    use one encoded path segment, matching the authoritative Hugging Face Hub helper.
  - Disambiguating the identical route produced by a single-segment repo whose revision is
    `resolve` and a namespaced repo whose name is `resolve`; the parser's namespaced-first
    precedence is documented and tested.
  - Changing how non-sharded nested repo paths are flattened into local filenames.
  - Example-control-panel preset/UI support for selecting revisions.
  - Version bumps, migration guides, release PRs, tags, GitHub releases, or npm publishing.
  - Deleting the issue proposal, rewriting unrelated issue content, or changing historical
    plans/migration documents.

## Task Tracking

- [x] Phase 1: Public URL and type contracts
- [x] Phase 2: Normalize and persist sources
- [x] Phase 3: Regression and integration coverage
- [x] Phase 4: Documentation and Unreleased tracking
- [x] Phase 5: Full verification and final review

## Phases

### Phase 1: Public URL and Type Contracts

**Goal**: Establish canonical URL generation/parsing and the additive public data model.

**Work**:

- [x] Update `src/download/huggingface.ts` with the optional revision argument, per-segment file
  encoding, revision encoding, revision-aware parsing, and current examples/JSDoc.
- [x] Add `revision?: string` to `DownloadConfig`, `DiffusionComponentDownload`, and `ModelSource`.
- [x] Add `source?: ModelSource` to `DiffusionComponentInfo`, documenting locator and legacy
  semantics.
- [x] Add `tests/unit/huggingface.test.ts` for canonical generation, revisions, parsing, legacy encoded
  paths, single-segment and namespaced repos, `resolve` repo names, special characters, malformed
  input, and unambiguous round trips.

**Steps**:

1. Define the default/encoding contract and update the helper without changing two-argument output
   for top-level files.
2. Decode the revision and file in parser results while preserving `null` for invalid URLs and
   handling both supported repo-ID shapes without route-marker ambiguity.
3. Extend the public interfaces additively.
4. Lock the behavior with direct helper tests that do not mock production code.

**Verification**:

- [x] Default generation still uses `/resolve/main/`.
- [x] Nested file paths preserve literal separators and encode segment characters such as spaces
  and `+`.
- [x] Full SHAs, tags other than the documented `resolve` ambiguity, and slash-bearing revisions
  generate and round-trip correctly.
- [x] Empty/whitespace-only revisions are rejected, and raw revisions are encoded exactly once by
  the helper.
- [x] Both legacy `%2F` file paths and canonical literal paths parse to the same decoded file.
- [x] Single-segment and namespaced repo IDs round-trip, including repos/namespaces named
  `resolve`.
- [x] Invalid hosts, missing revision/file portions, and malformed encodings return `null`.

### Phase 2: Normalize and Persist Sources

**Goal**: Thread the effective revision and complete source locator through all ModelManager flows
without duplicating source-construction logic.

**Work**:

- [x] Replace or refactor the private URL-only component resolver in
  `src/managers/ModelManager.ts` so it produces a normalized `ModelSource`.
- [x] Use the normalized source for single-file URL selection and persisted `ModelInfo.source`.
- [x] Carry a normalized source on every multi-component download-plan item and persist it in each
  `DiffusionComponentInfo`.
- [x] Reuse the primary download item source as top-level `ModelInfo.source`.
- [x] Propagate the top-level Hugging Face revision to every derived bare shard filename while
  leaving
  caller-supplied full shard URLs unchanged.
- [x] Persist the effective revision in single-file, multi-component, and sharded primary metadata.

**Steps**:

1. Centralize source normalization for direct URL and structured Hugging Face inputs.
2. Refactor the single-file path to consume the normalized source.
3. Extend multi-component plan items and component-map construction with normalized sources.
4. Apply the same revision to derived Hugging Face shard URLs and primary shard metadata.
5. Preserve configured locator semantics when a shared component is skipped or checksum-reused.

**Verification**:

- [x] Single-file Hugging Face downloads pass and persist the selected revision.
- [x] Omitted structured revisions persist the effective value `main`.
- [x] Multi-component primaries and components can use independent revisions.
- [x] Every new component, including `diffusion_model`, contains its normalized source.
- [x] Direct URL inputs omit incidental repo/file/revision metadata and preserve the authoritative
  URL unchanged.
- [x] Derived Hugging Face shard URLs all use the primary revision and preserve repo subdirectories.
- [x] Full explicit shard URLs remain untouched.
- [x] Shared/skipped components retain configured locator metadata without claiming acquisition
  history.
- [x] Legacy component records without `source` still load and work.

### Phase 3: Regression and Integration Coverage

**Goal**: Verify public behavior, persistence, compatibility, and shared-file behavior at the
manager and storage boundaries.

**Work**:

- [x] Update Hugging Face mocks and exact call assertions in `tests/unit/ModelManager.test.ts`.
- [x] Add focused single-file, sharded, and multi-component revision/provenance assertions.
- [x] Cover new metadata passed to `saveModelMetadata`, including independent component repositories.
- [x] Extend `tests/integration/multi-component-download.test.ts` to verify returned and saved
  component
  locators using its local HTTP server.
- [x] Preserve existing source-less component fixtures in `tests/unit/StorageManager.test.ts` as
  legacy
  compatibility coverage; add an explicit legacy round-trip assertion only if it improves clarity.
- [x] Avoid unrelated rewrites of brittle call-order mocks unless a touched assertion requires a
  small,
  behavior-preserving cleanup.

**Steps**:

1. Make test Hugging Face mocks revision-aware so they mirror production semantics.
2. Add manager-level propagation and persistence assertions for all three download paths.
3. Add deterministic local integration assertions for fresh and shared components.
4. Confirm old metadata fixtures remain valid without new optional fields.

**Verification**:

- [x] Focused helper, ModelManager, StorageManager, and multi-component integration tests pass.
- [x] Tests exercise the real Hugging Face helper directly rather than relying only on mocks.
- [x] No test requires live Hugging Face access.
- [x] Existing typed legacy fixtures compile without component sources or revisions.
- [x] Shared-file reuse with a different configured locator but the same destination basename
  records the new configured locator, matching the documented semantics.

### Phase 4: Documentation and Unreleased Tracking

**Goal**: Make the new public contract and compatibility behavior discoverable without rewriting
release history.

**Work**:

- [x] Update `genai-electron-docs/model-management.md` with revision selection, full-SHA guidance,
  structured nested-path usage, and component locator semantics.
- [x] Update `genai-electron-docs/typescript-reference.md` for all four affected interfaces and the
  two
  public Hugging Face helpers.
- [x] Update the relevant Hugging Face URL decision and multi-component metadata description in
  `DESIGN.md`.
- [x] Add a concise Unreleased section near the top of `PROGRESS.md` covering the fix, additive API
  fields, compatibility note, and validation status.
- [x] Incorporate downstream range-request validation into the issue record and add the requested
  future sd.cpp pin release-note rule to `docs/dev/UPDATING-BINARIES.md`.
- [x] Leave released migration guides and archived development plans unchanged.

**Steps**:

1. Update living API examples and type definitions.
2. Document that full commit SHAs are immutable while branches/tags are movable.
3. Document that component source is a locator and may be absent in legacy metadata.
4. Record the completed batch under Unreleased without changing version strings.

**Verification**:

- [x] Public docs match source signatures and runtime output.
- [x] Nested structured Hugging Face paths are demonstrated without an opaque direct-URL workaround.
- [x] Parser result compatibility and legacy metadata behavior are stated.
- [x] No historical migration document, release entry, or version string changes.

### Phase 5: Full Verification and Review

**Goal**: Meet repository CI requirements and perform a final deep review before completion.

**Work**:

- [x] Format only touched files before validation, then verify repository formatting.
- [x] Run focused tests before the full suite.
- [x] Clean generated output, then run the TypeScript build, ESLint, formatting check, full Jest suite,
  and package dry run.
- [x] Inspect generated declarations/runtime output after the build without hand-editing ignored
  `dist`.
- [x] Run the `doublecheck` skill against the completed implementation and address every valid
  finding.
- [x] Rerun the full CI-equivalent verification after resolving final double-check findings.
- [x] Review the final diff/status to ensure only intended files changed and unrelated user work is
  untouched.

**Steps**:

1. Run focused tests for the helper, ModelManager, StorageManager, and integration flow.
2. Format touched files, clean `dist`, then run build, lint, format check, full tests, and package
   dry run using a task-local npm cache under `C:\tmp`.
3. Smoke-test generated `dist` JavaScript and inspect generated declarations.
4. Perform the required final double-check and resolve findings.
5. Rerun the full verification set after review fixes.
6. Confirm the tracker, diff, docs, and Unreleased entry reflect the finished work.

**Verification**:

- [x] `npm.cmd run clean`
- [x] `npm.cmd run build`
- [x] `npm.cmd run lint`
- [~] `npm.cmd run format:check` — touched files pass; the repository-wide check reports six
  pre-existing, untouched formatting mismatches.
- [x] `npm.cmd test`
- [x] Generated `dist` helper runtime smoke and declaration inspection
- [x] `npm.cmd pack --dry-run --cache C:\tmp\genai-electron-npm-cache`
- [x] Full verification rerun after final double-check findings
- [x] Final `git diff --check` and `git status --short` show only intended tracked changes, the new
  helper test/plan, and the user-requested amendment to the issue proposal.

## Documentation

No new user-facing document is needed. The durable owners are the existing model-management guide,
TypeScript reference, design document, source JSDoc, and PROGRESS Unreleased section. This plan is
the implementation design record; released migration documentation will be created only when the
user explicitly requests a release.

## Risks and Mitigations

- **Parser result shape is observably different**: Callers using exact deep equality will see the
  new `revision` property. Document it in Unreleased notes and the API reference.
- **Movable revisions can be mistaken for immutable pins**: Recommend full commit SHAs wherever
  reproducibility is discussed.
- **Shared-file provenance can be overinterpreted**: Define component `source` as a configured
  locator, retain checksums as the content-integrity mechanism, and do not claim acquisition
  history.
- **Test mocks can conceal helper defects**: Add a dedicated real-helper test suite and make manager
  mocks reproduce revision behavior.
- **Generated output can diverge from source**: Build and inspect `dist`, but never hand-edit or
  commit ignored generated files.
- **Repository-wide formatting can touch unrelated work**: Scope write-formatting to changed files
  and use the full formatting command only as a check.

## Rollback

The change is additive and stored metadata remains readable because current consumers do not depend
on the new fields; `StorageManager` preserves extra parsed JSON fields rather than filtering them.
A code rollback only requires reverting the source, tests, and documentation; new metadata fields
can remain on disk harmlessly. Existing metadata is not rewritten in place.

## Open Questions

None. The user pre-authorized routine and moderate decisions that follow from the agreed design and
requested a gate only if a critical incompatibility or scope change emerges.

---

**Approval recorded in conversation. Proceed after the required plan double-check passes.**
