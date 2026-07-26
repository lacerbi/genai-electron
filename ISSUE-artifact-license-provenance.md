# ISSUE (for genai-electron) — Carry artifact licence provenance through download and install

**Filed:** 2026-07-26, from the same downstream third-party licence audit that produced
[`ISSUE-genai-electron-huggingface-downloads.md`](ISSUE-genai-electron-huggingface-downloads.md).
**Observed against:** `genai-electron@0.12.1`, and against the completed work in
[`PLAN-huggingface-download-provenance.md`](PLAN-huggingface-download-provenance.md).

**This amends the earlier issue.** It reopens exactly one entry from its "Ruled out" section — the
deferral of licence metadata on `ModelInfo` — and asks for nothing else. Everything else in that
issue is either implemented or correctly ruled out.

Not urgent, and not blocking anything downstream: the consumer keeps its own catalogue either way.
It is filed now because it belongs to the same record the provenance plan just built, and is far
cheaper to add while that surface is open than to retrofit later.

## Why this reopens a closed item

The original ruling was:

> **License metadata on `ModelInfo`** was considered and is deliberately not requested here. A
> generic passthrough would work, but which side should own model licensing is a design question,
> and the consumer that raised it holds the data in its own catalog already.

The reasoning is sound. The line just lands in an odd place, because the *same issue* requested —
and `PLAN-huggingface-download-provenance.md` has now implemented — `DiffusionComponentInfo.source`,
so that an installed component records where it came from.

Once the installed record can answer **"where did this file come from"**, the question **"under what
terms was it obtained"** is the same category of fact, learned at the same moment, from the same
caller, and useful to the same consumers. Splitting the two halves of one provenance record puts
half of it on disk and leaves the other half only in the consumer's source code.

## The test being applied

Does every consumer need it, and can genai-electron provide it *without making a policy choice*?

| Piece                                    | Universal? | Policy-free? | Status              |
| ---------------------------------------- | ---------- | ------------ | ------------------- |
| `checksum`                               | yes        | yes          | already present     |
| `revision` pinning                       | yes        | yes          | done (plan)         |
| component `source` retention             | yes        | yes          | done (plan)         |
| **provenance that survives install**     | yes        | yes          | **this request**    |
| "which licences need a warning"          | no         | no           | consumer's, refuse  |
| which models to offer                    | no         | no           | consumer's, refuse  |

## What is requested

A passthrough record, accepted at download time and persisted with the installed model. Structural
only — genai-electron stores and returns it, and never parses, validates, normalises, compares or
acts on its contents.

```ts
/** Opaque to this package: carried verbatim from download config to installed metadata. */
export interface ArtifactProvenance {
  /** SPDX identifier where one applies, otherwise a short label. Never interpreted here. */
  license: string;
  licenseUrl?: string;
  /** ISO date the consumer last confirmed the declaration. */
  lastCheckedOn?: string;
  note?: string;
}
```

- **Accepted on:** `DownloadConfig`, `DiffusionComponentDownload`
- **Persisted on:** `ModelInfo`, `DiffusionComponentInfo` — alongside the `source` field the plan
  just added

Optional everywhere, exactly like `source` and `revision`, so legacy metadata keeps loading and no
existing caller changes.

## What is explicitly NOT requested

These would be actively harmful and should be refused if proposed later:

- A built-in list of known, restricted, or non-commercial licences.
- SPDX parsing or validation of the `license` string.
- Fetching licence metadata from Hugging Face, or reconciling it against what the caller supplied.
- Any behaviour keyed off the value — no warnings, no blocking, no download refusal.

The reason is the failure mode this whole audit was about. A library that shipped a "restricted
licences" list would be making a compliance claim it cannot keep current, and consumers *would*
trust it. Licence judgement varies by product, jurisdiction, and distribution model; it has to sit
with the consumer that can actually answer for it. genai-electron's job is to not lose the data.

## Why the consumer's own catalogue is not sufficient

This is the part that has changed since the original deferral was written.

1. **The installed model cannot describe itself.** Provenance currently lives only in a
   pre-download catalogue, joined to what is on disk by `(repo, file)`. Interpreting an installed
   model requires the consumer's catalogue to be present, loaded, and still in agreement.
2. **Re-verification is recurring, not one-off.** Model cards mutate: licences get added, changed,
   or withdrawn on mutable branches. A periodic "re-check what we installed" pass wants to read the
   record that shipped with the file, not reconstruct what the catalogue said at download time.
3. **Catalogue edits desynchronise history.** If the consumer re-sources an artifact, an
   already-installed copy still needs to know what *it* was fetched under. Today that fact is
   overwritten by an unrelated source edit.
4. **Disclosure happens at point of use, not only at point of download.** Anything that surfaces
   terms in a settings pane or an about screen has to re-derive them from the catalogue.

## The downstream case, concretely

The consumer ships one image preset that assembles three artifacts from three different
repositories. Two carry declared Apache-2.0 terms. The third is recorded as an **inferred** licence
with a written evidentiary basis — because its distributor publishes no licence at all, and the
inference rests on a byte-identical sibling file in a repository that does declare one.

That evidence is exactly the kind of thing that must travel with the artifact and must not be
silently regenerated later from a guess. Today it lives only in the consumer's TypeScript, and the
three installed files carry none of it.

## Compatibility

Additive optional fields on four interfaces, mirroring precisely how `source` and `revision` landed
in the completed plan. No migration, no version-string implications beyond the usual unreleased
batching, and stored metadata stays readable in both directions since `StorageManager` preserves
unrecognised parsed JSON fields.

## Suggested acceptance

- A download supplying `provenance` on the primary and on each component round-trips it into
  `getModelInfo()` and the persisted metadata, byte-for-byte unchanged.
- A download omitting it succeeds and yields records without the field.
- Legacy metadata written before this change still loads.
- No code path anywhere in the package branches on the contents of `license`.
