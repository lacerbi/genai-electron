# Extraction progress is entry-granular, and the tail of provisioning is unreported

Status: RESOLVED (2026-08-13, unreleased)

Observed on 0.22.1, Windows/NVIDIA, during a deliberate llama.cpp re-provision (the
`binaries/llama` tree renamed aside, then a packaged Electron app started a local
server). Extraction itself worked correctly — this is about what a host can tell the
user while it runs.

A host rendering `BinaryProgressEvent` faithfully shows a percentage that stops moving
for minutes at a time, twice, and reads as a hang:

| Displayed | Duration | What was actually happening |
|---|---|---|
| `Extracting CUDA 12.4 runtime libraries… 100%` | 2m40s | one 473 MB entry being written |
| `Extracting local AI runtime… 100%` | 2m28s | validation followed by unreported candidate assembly and publication |

## Two separate causes

**1. Entry counters cannot move inside an entry.** `cudart-llama-bin-win-cuda-12.4-x64.zip`
holds ~575 MB in a handful of entries, of which `cublasLt64_12.dll` alone is 473 MB. The
`completedEntries / totalEntries` pair in `ArchiveExtractionProgress` is therefore
constant for most of the extraction's wall clock. Byte-level progress (bytes written vs
uncompressed total) would track the work; entry counts only track archives whose bytes
are spread evenly across many entries.

**2. Candidate installation after validation is silent.** Once the main archive reaches
`completedEntries === totalEntries`, `BinaryManager` runs
`assertNoDependencyFileCollisions` and emits `phase: 'testing'`. If validation succeeds,
it then assembles the complete candidate tree, writes its metadata and checksum, publishes
it with a recoverable directory swap, and cleans the backup without another progress phase.
On the observed 1.1 GB tree, that unreported tail contributed the second multi-minute stale
display. A `phase: 'installing'` event after validation would let a host name the work
accurately.

## Smaller, related

`BinaryManager.extractionProgress` computes

```ts
percent: totalEntries > 0 ? Math.floor((completedEntries / totalEntries) * 100) : 100,
```

so an archive whose entry count is unknown reports **100%** — "no information" rendered
as "complete". Omitting `percent` in that branch would let hosts distinguish the two;
`BinaryProgressEvent.percent` is already optional, and the opening
`this.progress({ phase: 'extracting', file })` event omits it.

## What we did meanwhile

Palimpsest's label now stops showing a percentage once the entry count is exhausted and
names the remaining work instead. That is a presentation workaround: it removes the
false "100% and stuck" reading, but the host still cannot say how far along the large
entry or the staging copy is, because the events do not carry it.

## Suggested

1. Report extraction progress in bytes alongside entries (keeping the entry counters for
   compatibility).
2. Emit a phase for the post-validation candidate installation window.
3. Omit `percent` when `totalEntries` is 0 rather than reporting 100.

None of these change extraction behaviour, the worker-thread responsiveness, the
path-containment checks, or the public error surface.

## Resolution

Implemented unreleased on 2026-08-13:

- ZIP worker progress now includes cumulative `writtenBytes` and
  `totalUncompressedBytes` alongside the existing entry counters. A worker-local
  filesystem adapter splits `adm-zip` payload writes into bounded chunks while retaining
  `extractEntryTo()` for extraction and containment.
- Extraction `percent` prefers a valid byte ratio, falls back to entry counts, and is
  omitted when neither denominator is positive.
- `BinaryProgressEvent.phase` now includes `'installing'`, emitted after validation and
  before candidate assembly/publication.
- The byte fields measure successful uncompressed payload writes. `adm-zip` still inflates
  each complete entry before writing it, so this does not claim streaming decompression
  progress.

Focused archive/BinaryManager coverage passes 94/94. The full Jest suite passes 1046/1046 tests
across 37 suites with `--detectOpenHandles` and no reported handles. The TypeScript build and
committed ZIP-worker freshness check pass, and the isolated packed-package smoke extracts a real
ZIP with `adm-zip` unavailable while validating the new byte fields and public phase union.
Formatting passes; ESLint reports 0 errors with the existing 118 warnings; `git diff --check`
passes. Independent strong-agent reviews of the worker/security boundary, API/tests, and
documentation/integration found no remaining substantive implementation defect. The optional
live Windows/CUDA re-provision was subsequently run on 2026-08-13 with checksum-verified b9860
archives pre-seeded into an isolated Electron profile. It completed in 115.7 seconds with no
download events. The 547.5 MiB CUDA payload and 591.9 MiB main payload each produced 100
within-entry byte advances, remained monotonic through 100%, and retained their 3/3 and 52/52 entry
completions. `installing` followed basic validation and covered the successful 1.65-second
candidate-publication tail. The GUI-owned server was already running, so the isolated candidate
used `--version` validation rather than competing for GPU memory with a second real-model server.
The acceptance used an isolated profile and did not target the active Palimpsest installation; the
later settlement follow-up explicitly recorded four active-installation sentinel hashes, its root
timestamp, and its healthy endpoint before and after provisioning.

The acceptance also exposed a narrower residual outside this issue's implemented byte/phase
contract: the worker did not exit until 34.7 seconds after the CUDA archive's final extraction
event and 51.2 seconds after the main archive's final event. Hosts now see granular work within the
large members and an accurate installation phase, but may still briefly display completed
extraction while the worker tears down. Preserve this evidence for a focused worker-settlement
follow-up rather than attributing that interval to candidate installation. That follow-up is now
resolved in `ISSUE-zip-worker-settlement-gap.md`: `finalizing` begins at the worker `done` boundary
and covers teardown until exit.
