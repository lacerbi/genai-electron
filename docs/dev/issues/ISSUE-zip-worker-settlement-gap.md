# Issue: ZIP Worker Settlement Gap

Status: RESOLVED (2026-08-13, targets v0.23.0)

## Summary

On Windows with the real b9860 CUDA archives, ZIP extraction reached its final byte/entry progress
event but provisioning did not advance for another 34.7-51.2 seconds. The delay was not download,
checksum, extraction, validation, or publication work visible to callers.

## Evidence

- Baseline acceptance report:
  `C:\Users\luigi\AppData\Local\genai-electron-acceptance\reports\extraction-progress-20260813-103628.json`
- CUDA runtime archive: final extraction event at 20,659 ms; the next phase/log at 55,311 ms
  (34,652 ms gap).
- Main binary archive: final extraction event at 61,748 ms; testing at 112,904 ms
  (51,156 ms gap).
- In `src/utils/archive-utils.ts`, the worker posted `done` immediately after the extraction loop and
  closed its message port. The parent stored the result on `done` but deliberately settled only from
  the worker's `exit` event so that no worker handle escaped the API call.

The observed delay was therefore successful worker settlement after extraction had completed. The
large archive buffers/decompression allocations make isolate/resource teardown the leading cause;
its duration is variable and real-archive verification was required.

## Required Behavior

- Successful extraction must still resolve only after the worker has exited.
- Once a complete `done` result has been received, explicitly request prompt worker termination and
  treat only that success-path termination as an expected non-zero exit.
- Worker errors, premature exits, missing results, containment, callback isolation, and extracted-file
  correctness must retain their existing contracts.
- If teardown remains material, report it immediately under an accurate phase instead of leaving the
  UI at completed extraction.
- Confirm the timing change with the checksum-verified cached b9860 archives in a temporary Electron
  profile, without touching the active Palimpsest installation.

## Resolution

The parent now requests `Worker.terminate()` only after receiving the complete success result and
still settles exclusively from `exit`. Only exit code 1, Node's intentional-termination result, is
accepted after that success-path termination request; errors, other non-zero codes, and
premature/missing-result exits retain their rejection behavior.
Throwing progress/finalization consumers remain isolated from extraction.

The first repeat with explicit termination
(`worker-settlement-20260813T085438Z.json`) still measured 24,395 ms and 30,175 ms from final entry
to the next phase, so termination did not reliably remove the teardown interval. The durable
correction therefore also adds the `'finalizing'` member to `BinaryProgressEvent.phase`, emitted
from the worker `done` boundary after all synchronous payload writes and before termination. This
phase carries no percentage and remains active until the worker exits.

The accepted repeat
(`C:\Users\luigi\AppData\Local\genai-electron-acceptance\reports\worker-settlement-20260813T090029Z.json`)
reported `finalizing` in the same millisecond as both final extraction events. It truthfully covered
34,258 ms of CUDA-worker cleanup and 1,357 ms for the main worker before verification/testing. No
downloads occurred; basic CUDA validation, candidate publication, and archive-cache preservation
passed. The four monitored active Palimpsest marker hashes and directory timestamp were unchanged,
and its pre-existing server stayed healthy and was not targeted. Both temporary profiles and the
acceptance harness were removed; the verified archive cache and JSON reports remain for audit.

Final automated validation passed 99/99 focused tests and 1051/1051 full tests across 37 suites
with `--detectOpenHandles`, plus build/generated-worker freshness, packed-consumer runtime/type,
formatting, and whitespace gates. ESLint passed with 0 errors and the existing 118 warnings.
