# Plan: Artifact License Provenance

Created: 2026-07-26
Status: COMPLETE

## Summary

Add an optional, caller-supplied artifact license declaration to model download inputs and preserve
it in installed model/component metadata. The package will carry the declaration structurally
without validating, normalizing, fetching, comparing, interpreting, or making policy decisions from
its contents.

The implementation uses **configuration-record semantics**: provenance describes the declaration
supplied for this installed model/component record. For a reused shared file, it does not claim to
be forensic proof of the first network transfer or the original terms attached to the physical
bytes. A true acquisition-history registry is a separate, larger design and is out of scope.

## Task Understanding

Implement the accepted request in
[`ISSUE-artifact-license-provenance.md`](../issues/ISSUE-artifact-license-provenance.md) as an additive
unreleased change:

- Define and publicly export `ArtifactProvenance`.
- Accept optional `provenance` on `DownloadConfig` and `DiffusionComponentDownload`.
- Persist optional `provenance` on `ModelInfo` and `DiffusionComponentInfo`.
- Preserve the declared string values through single-file, sharded, multi-component, shared-file,
  save/load, and `getModelInfo()` flows.
- Keep legacy metadata and callers fully compatible.
- Never use the declaration to warn, block, permit, rank, or otherwise influence behavior.

“Verbatim” and “byte-for-byte” mean structural field/value equality after the package’s normal JSON
round trip. JSON whitespace, object identity, prototypes, non-enumerable properties, and explicit
`undefined` are not preservation guarantees.

The user pre-authorized implementation after the required plan double-check and requested another
gate only if that review reveals a critical scope or correctness change.

## Design Decisions

- `ArtifactProvenance` has the requested fields:
  - required `license: string`
  - optional `licenseUrl?: string`
  - optional `lastCheckedOn?: string`
  - optional `note?: string`
- The public API spelling is `license`; documentation may discuss “license declarations” but will
  not imply legal endorsement.
- `lastCheckedOn` is caller-supplied date text (recommended `YYYY-MM-DD`) and is never parsed or
  freshness-validated.
- Provenance remains a standalone sibling of `source`, `revision`, and `checksum`; those fields are
  not duplicated inside it.
- The complete supplied object is shallow-copied at `downloadModel()` entry, before the first
  asynchronous operation, rather than reconstructed field by field. This snapshots the declared
  string fields, avoids in-flight caller mutation and input/output aliasing, and does not interpret
  their contents.
- Omitted provenance produces no own `provenance` property on newly returned metadata.
- Single-file and sharded downloads copy top-level provenance only to `ModelInfo`; `ShardInfo` does
  not gain provenance.
- In a multi-component download:
  - top-level `DownloadConfig.provenance` describes the primary diffusion model;
  - it is copied independently to `ModelInfo.provenance` and
    `components.diffusion_model.provenance`;
  - each additional component receives only its own `DiffusionComponentDownload.provenance`;
  - primary provenance never implicitly inherits into unrelated components.
- Reused shared components record the current model configuration’s supplied provenance, matching
  existing component `source` semantics. Different model records may therefore carry different
  declarations for the same physical path; no cross-record reconciliation is attempted.
- `StorageManager` already serializes and loads complete `ModelInfo` objects, so it needs regression
  coverage but no production filtering or schema changes.
- `updateModelMetadata()` must continue preserving provenance through its existing object-spread
  update.

## Scope

- **In scope**:
  - Additive types and package-root exports.
  - Single-file, sharded, and multi-component propagation.
  - Primary/component copy independence and omitted-field behavior.
  - Configured-declaration semantics for shared-file reuse.
  - Storage round-trip and legacy compatibility coverage.
  - Living model-management, TypeScript reference, design, issue, and Unreleased documentation.
  - Generated `dist` verification through the normal build.
- **Out of scope**:
  - SPDX parsing or validation.
  - Built-in license catalogs, policy warnings, blocking, or compliance decisions.
  - Fetching or reconciling Hugging Face/model-card license metadata.
  - Legal conclusions or package-endorsed license claims.
  - Per-shard provenance.
  - A physical-artifact acquisition registry, sidecar, or chain-of-custody record.
  - Reconciliation when two model records declare different provenance for one shared path.
  - Solving the existing shared-file checksum-replacement behavior.
  - Version bumps, migrations, releases, tags, publishing, pushing, or PR creation.

## Task Tracking

- [x] Phase 1: Public type and export contract
- [x] Phase 2: Metadata propagation
- [x] Phase 3: Regression and integration coverage
- [x] Phase 4: Documentation and issue resolution
- [x] Phase 5: Full verification and final double-check

## Phases

### Phase 1: Public Type and Export Contract

**Goal**: Establish the additive, policy-free data model.

**Work**:

- [x] Add `ArtifactProvenance` to [`src/types/models.ts`](../../../src/types/models.ts).
- [x] Add optional `provenance` fields to `DownloadConfig`, `DiffusionComponentDownload`,
  `ModelInfo`, and `DiffusionComponentInfo`.
- [x] Re-export the type from [`src/types/index.ts`](../../../src/types/index.ts) and
  [`src/index.ts`](../../../src/index.ts).
- [x] Document omission, legacy compatibility, and non-interpretation semantics in source JSDoc.

**Steps**:

1. Define the interface beside the model source/provenance types.
2. Add optional input and persisted fields at the four requested boundaries.
3. Thread the type through both public export barrels.

**Verification**:

- [x] Existing typed fixtures compile unchanged.
- [x] Package-root consumers can import `ArtifactProvenance`.
- [x] No runtime validation or policy API is introduced.

### Phase 2: Metadata Propagation

**Goal**: Snapshot and preserve declarations across all applicable download shapes.

**Work**:

- [x] Add one policy-free provenance copy helper in
  [`src/managers/ModelManager.ts`](../../../src/managers/ModelManager.ts).
- [x] Conditionally attach a copied declaration to single-file `ModelInfo`.
- [x] Conditionally attach a copied declaration to sharded `ModelInfo`.
- [x] Carry independent primary/component declarations through the multi-component download plan.
- [x] Conditionally attach separate copies to `ModelInfo` and every applicable
  `DiffusionComponentInfo`.
- [x] Preserve property absence when no declaration was supplied.

**Steps**:

1. Copy the complete enumerable declaration object without reading individual values.
2. Apply the copy at metadata construction boundaries rather than in `StorageManager`.
3. Keep top-level and primary component copies independent.
4. Apply the same current-configuration rule when a shared component download is skipped.

**Verification**:

- [x] Mutating an input or returned primary/component object cannot mutate its sibling copy.
- [x] Omitted provenance is absent from immediate returned objects and persisted JSON.
- [x] Existing `updateModelMetadata()` behavior preserves the field without special handling.

### Phase 3: Regression and Integration Coverage

**Goal**: Lock propagation, persistence, compatibility, and non-policy behavior.

**Work**:

- [x] Extend [`tests/unit/ModelManager.test.ts`](../../../tests/unit/ModelManager.test.ts) for single-file,
  omitted, sharded, multi-primary, independent-component, and copy-isolation behavior.
- [x] Add focused `getModelInfo()` and `updateModelMetadata()` cases proving persisted declarations
  are returned unchanged and survive metadata refresh.
- [x] Extend [`tests/unit/StorageManager.test.ts`](../../../tests/unit/StorageManager.test.ts) with an
  explicit provenance save/load round trip by feeding the exact captured write JSON back through
  the mocked read, while retaining legacy provenance-less fixtures.
- [x] Extend
  [`tests/integration/multi-component-download.test.ts`](../../../tests/integration/multi-component-download.test.ts)
  for deep-cloned persisted primary/component declarations and shared-file
  configured-declaration semantics.
- [x] Add explicit non-inheritance cases: primary-only provenance leaves unrelated components
  without the property, and component-only provenance never appears at the top level.
- [x] Use non-SPDX/inferred labels plus deliberately noncanonical URL/date/whitespace/case strings
  and evidence notes to prove every opaque field is preserved without validation.
- [x] Audit production code so no path reads or branches on `license`, `licenseUrl`,
  `lastCheckedOn`, or `note`.

**Steps**:

1. Add focused manager tests beside the existing source/revision cases.
2. Add direct `getModelInfo()` and spread-based metadata-refresh preservation tests.
3. Add one captured-write-to-read JSON persistence round trip.
4. Deep-clone captured integration metadata and add local HTTP assertions for fresh and reused
   component records.
5. Assert absent fields with own-property checks, not only serialized omission.

**Verification**:

- [x] Supplied values are deep-equal after return and storage round trip.
- [x] Omitting provenance succeeds and produces no field.
- [x] Legacy metadata loads without migration.
- [x] Shared variant A and B retain their independently configured declarations.
- [x] Tests demonstrate that arbitrary caller labels are accepted unchanged.
- [x] Sharded `ModelInfo` carries top-level provenance while every `ShardInfo` remains
  provenance-free.

### Phase 4: Documentation and Issue Resolution

**Goal**: Make the public contract clear without overstating compliance or acquisition history.

**Work**:

- [x] Update
  [`genai-electron-docs/model-management.md`](../../../genai-electron-docs/model-management.md) with a
  compact input/retrieval example and the caller-responsibility boundary.
- [x] Update
  [`genai-electron-docs/typescript-reference.md`](../../../genai-electron-docs/typescript-reference.md)
  with the interface, all four fields, and package-root export.
- [x] Update the existing `DESIGN.md` policy/non-goal boundary, shared-component storage, and
  persisted-model-metadata sections with the policy-free storage boundary and configured
  shared-file semantics; do not duplicate it in the Hugging Face URL decision.
- [x] Add a distinct Unreleased subsection to [`PROGRESS.md`](../../../PROGRESS.md); its status header and
  exact build/test counts are finalized in Phase 5.
- [x] Append a clearly separated, non-destructive resolution note to
  [`ISSUE-artifact-license-provenance.md`](../issues/ISSUE-artifact-license-provenance.md) with the
  implemented semantics and structural-round-trip clarification; preserve the original proposal
  and acceptance wording as filed.

**Steps**:

1. Document that the package stores declarations but never judges them.
2. State explicitly that shared-file provenance belongs to each model configuration record.
3. Clarify structural JSON round-trip behavior in living docs and the appended issue resolution
   note without rewriting the original issue history.
4. Keep released migration/history documents unchanged.

**Verification**:

- [x] Docs match source signatures and runtime behavior.
- [x] No text presents the package as a license authority.
- [x] Public prose defines `ArtifactProvenance` narrowly as license-declaration context, with
  `source`, `revision`, and `checksum` remaining separate.
- [x] No new standalone provenance guide is created; existing authoritative documents own the
  material.
- [x] No version or release action occurs.

### Phase 5: Full Verification and Final Double-Check

**Goal**: Satisfy repository quality gates and deeply review the completed change.

**Work**:

- [x] Format touched files only.
- [x] Run focused provenance tests, then the full library suite.
- [x] Clean generated output, then run the library build, lint, touched-file formatting check,
  example build, and package dry run with a task-local npm cache.
- [x] Inspect generated runtime/declarations and package exports.
- [x] Run the `doublecheck` skill against the completed implementation and resolve valid findings.
- [x] Rerun affected and full verification after review fixes.
- [x] Update this tracker and `PROGRESS.md` with exact final results.

**Verification**:

- [x] `npm.cmd run clean`
- [x] `npm.cmd run build`
- [x] `npm.cmd run lint`
- [x] Touched-file `npx.cmd prettier --check`
- [x] `npm.cmd test`
- [x] `npm.cmd --prefix examples/electron-control-panel run build`
- [x] `npm.cmd pack --dry-run --json --cache C:\tmp\genai-electron-npm-cache`
- [x] Generated `dist` declaration/runtime inspection
- [x] `git diff --check`
- [x] Final `git status --short` contains only intended uncommitted implementation changes

The repository-wide Prettier check currently has six known mismatches in untouched baseline files.
Touched files must pass; the baseline exception must remain explicit unless those independent files
are separately authorized for formatting.

## Documentation

No new user-facing document is needed. The existing model-management guide owns usage and
responsibility boundaries; the TypeScript reference owns exact signatures; `DESIGN.md` owns the
policy/storage boundary; `PROGRESS.md` owns Unreleased status; and the issue owns the original
request plus its resolution. This plan is the required implementation tracker and design record.

## Risks and Mitigations

- **Configured declaration mistaken for acquisition history**: state the shared-file semantics in
  source, docs, tests, issue resolution, and the Unreleased entry.
- **Caller input aliases persisted/returned metadata**: shallow-copy at metadata boundaries and
  test reference independence.
- **Omitted field appears as an own `undefined` property**: attach conditionally and assert
  `Object.hasOwn()` behavior.
- **Package accidentally becomes a policy engine**: keep production access limited to copying the
  entire object and audit for field-name reads/branches.
- **Future fields get dropped by named reconstruction**: spread the whole supplied object.
- **JSON overpromises**: guarantee structural values for JSON-serializable declarations, not raw
  textual bytes or prototypes.
- **Shared file is later replaced after checksum mismatch**: do not claim forensic history; leave
  the existing replacement behavior out of scope.

## Rollback

The change is additive. Revert the source, tests, documentation, and plan changes; metadata already
written with `provenance` remains readable because older/current storage paths parse complete JSON
objects without filtering. No files are rewritten in place and no migration rollback is required.

## Open Questions

None. The configured-declaration semantics above were accepted through the user’s instruction to
plan, double-check, and proceed without another routine gate.

---

**Approval recorded in conversation. Begin implementation automatically after the required plan
double-check unless it reveals a critical blocker or scope change.**
