# Migrating from v0.22.1 to v0.23.0

v0.23.0 adds finer and more truthful binary-provisioning progress. The API changes are additive:
existing event listeners continue to work, while progress UIs can opt into byte-level extraction
telemetry and two newly named lifecycle phases.

Because genai-electron is pre-1.0, a dependency range such as `^0.22.1` does not admit v0.23.0.
Update the range or exact pin explicitly to adopt this release.

## What changed

`BinaryProgressEvent` adds two optional fields during ZIP extraction:

- `writtenBytes`: cumulative uncompressed payload bytes written across archive entries;
- `totalUncompressedBytes`: total uncompressed payload bytes when the archive supplies a positive
  denominator.

Extraction percentages prefer this byte ratio. They fall back to the existing entry counters when
byte totals are unavailable, and remain omitted when neither denominator is usable. The fields are
optional, so consumers must not require them for tar archives, older event producers, or unknown
archive totals.

The `phase` union adds:

- `'finalizing'`: all ZIP payload writes are complete, and the extraction worker is releasing its
  isolate/resources. Extraction still resolves only after worker exit;
- `'installing'`: binary validation succeeded, and the candidate is being assembled, checksummed,
  recorded, and atomically published.

The worker uses bounded synchronous write chunks to emit within-entry byte advances without
changing ZIP containment, extracted contents, or the self-contained bundled-worker contract.
Inflation still completes per entry before that entry's write progress begins.

## Consumer action

1. Update the dependency to `genai-electron` v0.23.0 or a compatible range beginning at v0.23.0.
2. If a progress renderer switches exhaustively on `BinaryProgressEvent.phase`, add cases for
   `'finalizing'` and `'installing'`.
3. Prefer `event.percent` for display. Treat `writtenBytes` and `totalUncompressedBytes` as optional
   diagnostic detail rather than recomputing a required percentage.
4. Keep the last extraction percentage visible only while `phase === 'extracting'`; show
   finalization and installation as indeterminate work unless the host has its own presentation.
5. Rebuild the Electron application and exercise one ZIP-backed binary provisioning flow.

## Compatibility

- No existing fields, phases, exports, manager methods, configuration options, or events were
  removed.
- Existing listeners that ignore unknown phase values remain compatible.
- Persisted models, installed binaries, validation metadata, and schema-v4 LLM calibration reports
  remain valid.
- Node, Electron, llama.cpp, stable-diffusion.cpp, and genai-lite compatibility are unchanged.
- ZIP extraction still waits for worker exit, isolates throwing consumer callbacks, rejects worker
  failures or abnormal exits, and preserves path containment.

## Verification and rollback

During a fresh or forced ZIP-backed provision, verify that large entries advance within
`'extracting'`, that `'finalizing'` follows completed writes, and that successful validation is
followed by `'installing'` before the manager reports readiness.

If an application cannot update its progress handling immediately, pin v0.22.1. Provisioning
correctness is unchanged there, but extraction remains entry-granular and the worker-cleanup and
candidate-publication tails are not named separately.

## Checklist

- [ ] Update the dependency to v0.23.0.
- [ ] Handle the two additive phase values in exhaustive renderers or reducers.
- [ ] Keep byte fields optional and continue to support entry-counter fallback.
- [ ] Rebuild the packaged Electron application.
- [ ] Exercise one real ZIP-backed binary provisioning flow.
