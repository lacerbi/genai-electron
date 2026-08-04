# Migrating from v0.21.x to v0.22.0

v0.22.0 adds a supported Electron-free entry for LLM calibration policy metadata and establishes a
strict package boundary. Applications using only documented package-root imports can update
without code changes. Consumers that import files beneath `genai-electron/dist/` must migrate those
imports before adopting this release.

## Required migration

### Replace calibration-policy deep imports

Use the new public subpath anywhere a plain-Node test, build script, or other non-Electron process
needs the calibration policy identifier:

```typescript
import { LLAMA_CALIBRATION_DEFAULTS } from 'genai-electron/llm-calibration-policy';

if (stored.policyVersion !== LLAMA_CALIBRATION_DEFAULTS.policyVersion) {
  discardStoredCalibration(stored);
}
```

Replace imports such as:

```typescript
// v0.21.x workaround — no longer resolves in v0.22.0.
import { LLAMA_CALIBRATION_DEFAULTS } from 'genai-electron/dist/config/defaults.js';
```

The supported subpath exports `LLAMA_CALIBRATION_DEFAULTS` only. It deliberately does not expose
`resolveLlamaCalibrationTimeBudget()` or other calibration implementation helpers.

### Remove internal-resolver contract assertions

Delete consumer tests that deep-import `resolveLlamaCalibrationTimeBudget()`. The helper is internal
and a resolver-only assertion cannot detect limits introduced elsewhere in the manager. Pin
`LLAMA_CALIBRATION_DEFAULTS.policyVersion` instead; policy-affecting changes must now bump that
identifier whenever existing reports or recommendations would no longer be trustworthy.

### Audit every package deep import

v0.22.0 declares only these package entries:

- `genai-electron`;
- `genai-electron/llm-calibration-policy`;
- `genai-electron/package.json`.

Every undeclared path, including `genai-electron/dist/...`, now fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. There is no transitional wildcard or private-path exception.

## Compatibility

- The package root remains Electron-specific. Import the policy subpath, not the root, from plain
  Node runtime code.
- genai-electron remains ESM-only. The export map provides declaration, import, and default
  conditions; it does not promise synchronous ESM execution through `require()` across the full
  supported Node/Electron range.
- LLM calibration reports remain `schemaVersion: 4` with policy `'llama-runtime-v4'`. This release
  does not itself invalidate persisted v0.21 calibration reports or require recalibration.
- LLM calibration behavior, server lifecycle APIs, model management, diffusion calibration, and
  genai-lite pairing are otherwise unchanged.
- Pre-1.0 caret ranges such as `^0.21.0` do not adopt v0.22.0 automatically; consumers must update
  their dependency range explicitly.

## Verification and rollback

Run plain-Node contract tests before upgrading production dependencies. A successful policy import
should return `'llama-runtime-v4'`, while any remaining deep import should fail immediately during
module resolution.

If a consumer cannot migrate all deep imports immediately, keep it pinned to v0.21.x. Do not add a
runtime fallback that reaches into `dist/`; migrate to the supported subpath before moving to
v0.22.0.

## Checklist

- [ ] Update the dependency to `genai-electron` v0.22.0.
- [ ] Replace the calibration policy deep import with `genai-electron/llm-calibration-policy`.
- [ ] Remove assertions that import `resolveLlamaCalibrationTimeBudget()`.
- [ ] Audit and remove every other `genai-electron/dist/...` import.
- [ ] Run plain-Node contract tests and the consuming Electron application build.
