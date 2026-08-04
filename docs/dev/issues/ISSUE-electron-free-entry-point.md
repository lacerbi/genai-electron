# ISSUE — No Electron-free entry point for LLM calibration policy

- Created: 2026-08-04
- Status: RESOLVED — implemented 2026-08-04; unreleased
- Package: genai-electron
- Affected API: package entry points (`package.json` `main` / `exports`),
  `LLAMA_CALIBRATION_DEFAULTS`
- Severity: low — the current workaround fails loudly, not silently

Related:

- `src/config/defaults.ts` — holds the pure policy values consumers need
- `src/config/paths.ts` — imports `electron` at module load
- `src/index.ts` — the package entry that transitively pulls the above
- `scripts/packed-api/run.mjs` — validates the packed package's public API

## Resolution

Implemented as proposed after review, with the final CommonJS compatibility constraint:

- added the constant-only `genai-electron/llm-calibration-policy` entry;
- kept `resolveLlamaCalibrationTimeBudget()` internal;
- declared strict package exports with `types`, `import`, and `default` conditions and no deep-path
  exception;
- made the packed tarball import the policy entry before Electron is linked and verify that
  CommonJS resolution selects the intended file;
- documented the prospective `policyVersion` compatibility rule.

The known downstream consumer must replace its policy deep import and remove its resolver assertion
before this breaking package-encapsulation change is released. That coordinated downstream change
is outside this repository and does not require keeping an internal package path open.

## Executive summary

The package cannot be imported at runtime outside Electron, even to read a plain constant. The root
entry transitively imports `electron`, so a consumer running under plain Node — a unit test, CI
check, or build script — fails at module load before it can reach a value with no Electron runtime
dependency of its own.

The values themselves are pure. `src/config/defaults.ts` has no Electron runtime import and its
built output loads in Node. Consumers therefore reach into `dist/config/defaults.js`, which works
only because the package currently has no `exports` map. That build path is not a supported API and
should not be required to read the documented LLM calibration policy identifier.

Publish a narrow, Electron-free entry point:

```ts
import { LLAMA_CALIBRATION_DEFAULTS } from 'genai-electron/llm-calibration-policy';
```

The entry exports the existing constant only. The internal
`resolveLlamaCalibrationTimeBudget()` helper remains internal, consumers remove their deep imports,
and a strict `exports` map seals undeclared package paths.

## Reproduction

Under plain Node, with the package installed:

```js
// Root entry — fails before any user code runs.
await import('genai-electron');
// SyntaxError: The requested module 'electron' does not provide an export named 'app'

// Internal build file — currently loads, but is not API.
const m = await import('genai-electron/dist/config/defaults.js');
m.LLAMA_CALIBRATION_DEFAULTS.policyVersion; // 'llama-runtime-v4'
```

The chain is `dist/index.js` → a manager/storage import → `dist/config/paths.js` →
`import { app } from 'electron'`. `paths.js` resolves storage roots through
`app.getPath('userData')` at module evaluation.

## Why consumers hit this

A host application that persists anything derived from calibration needs to know which policy
produced it. It can then reject or invalidate a stored result measured under an incompatible
policy. `LLAMA_CALIBRATION_DEFAULTS.policyVersion` is the existing documented value, but a host's
plain-Node contract test cannot load it through the package root.

The practical workaround is to hardcode the policy identifier in production and deep-import the
constant in a contract test to verify that the copy still matches the installed package. A hardcoded
copy with no such check can silently drift on a later policy bump.

One downstream contract test also deep-imported `resolveLlamaCalibrationTimeBudget()` to assert that
omitting `maxProbes` does not materialize a count limit. That assertion should be removed rather
than preserved as an encapsulation exception:

- v0.21 deliberately consolidated the resolver as an internal helper and explicitly rejected a
  replacement public resolver;
- testing the resolver alone would not catch a cap introduced elsewhere in `LlamaServerManager`;
- genai-electron already tests the stronger manager-level behavior through `calibrate()`, including
  absence of `report.budget.maxProbes`, no `probe-limited` result when omitted, and execution beyond
  the former derived attempt ceiling;
- the consumer's compatibility check should pin `policyVersion`, whose compatibility meaning is
  made explicit below.

## Why the current workaround is unsatisfactory

- It targets `dist/`, a build output. Renaming, bundling, or restructuring the build breaks the
  consumer without a documented API change.
- It survives only because there is no `exports` map. Adding one is normal package hygiene and
  should seal internal paths.
- It gives no reliable signal about which internal modules are Electron-free.
- Retaining a wildcard such as `"./dist/*": "./dist/*"` merely to support one white-box assertion
  would expose every internal module for coverage that does not verify the real manager boundary.

The issue is not urgent: the failure mode is a module-resolution error at test time, loud and
immediate. There is no silent wrong-answer risk in the current import failure.

## Decisions

### 1. Use an LLM-specific entry name

Use `genai-electron/llm-calibration-policy`, not the ambiguous `calibration-policy`. The package
also has diffusion calibration; the narrower name states exactly what the entry owns and can grow
without conflating the two systems.

### 2. Export the constant, not the internal resolver

The supported subpath exports `LLAMA_CALIBRATION_DEFAULTS` only.
`resolveLlamaCalibrationTimeBudget()` and its declaration-internal input/output interfaces remain
internal. This preserves the explicit v0.21 decision to remove public budget resolvers.

Existing calibration types remain available as type-only imports from the package root. Type-only
imports do not execute the Electron-dependent root module, so duplicating the broad calibration type
surface in this subpath is unnecessary.

### 3. Seal deep paths

Declare only supported entries. Do not add a permanent or transitional `./dist/*` wildcard, and do
not add a one-off export for `dist/config/defaults.js`. The known downstream consumer can remove all
deep imports once the constant is available through the supported subpath.

Adding `exports` is the breaking portion of this change because undeclared deep imports stop
resolving. Audit known consumers and describe the encapsulation change in release/migration notes.
Under the project's release policy, implementation remains unreleased until an explicit release is
requested; no version bump belongs in the implementation batch itself.

### 4. Keep the Electron root unchanged

Do not make the package root importable under plain Node. It intentionally creates Electron runtime
managers and exposes Electron-backed paths. Lazifying path initialization or singleton construction
would be a broader lifecycle change unrelated to the policy-metadata use case.

### 5. Make `policyVersion` a compatibility contract

`policyVersion` is the persisted-calibration and consumer compatibility identifier. From this
decision forward, it must change whenever altered admission, ranking, scheduling, evidence, or
resource-validity semantics can invalidate reports or recommendations produced under otherwise
identical inputs. This includes correctness fixes when artifacts produced by the previous behavior
are no longer trustworthy.

An implementation-only correction may retain the identifier only when existing persisted artifacts
remain semantically valid. This is a prospective maintainer rule: historical patch releases did not
always bump the identifier for calibration behavior corrections, so the guarantee must be stated
explicitly rather than inferred from past releases.

Document the rule beside `LLAMA_CALIBRATION_DEFAULTS.policyVersion` and in the calibration
persistence guidance. The downstream policy pin then detects intentional compatibility changes
across package upgrades without depending on a private implementation helper.

## Proposed implementation

1. Add `src/llm-calibration-policy.ts` as a deliberately small public facade that re-exports
   `LLAMA_CALIBRATION_DEFAULTS` from `src/config/defaults.ts`.
2. Add a strict conditional `exports` map while retaining top-level `main` and `types` for older
   tooling. Publish `types`, `import`, and `default` conditions for each JavaScript entry. The
   package's supported Node/Electron range includes runtimes that cannot synchronously execute
   native ESM through `require()`, so do not advertise a dedicated `require` condition without a
   CommonJS build. `default` still lets CommonJS-oriented resolvers locate the same entry, matching
   the package's pre-existing ESM-only behavior:

   ```json
   "exports": {
     ".": {
       "types": "./dist/index.d.ts",
       "import": "./dist/index.js",
       "default": "./dist/index.js"
     },
     "./llm-calibration-policy": {
       "types": "./dist/llm-calibration-policy.d.ts",
       "import": "./dist/llm-calibration-policy.js",
       "default": "./dist/llm-calibration-policy.js"
     },
     "./package.json": "./package.json"
   }
   ```

3. Extend `scripts/packed-api/run.mjs` to test the actual packed artifact. After extracting the
   tarball, but before linking Electron into the temporary consumer, spawn plain Node and import
   `genai-electron/llm-calibration-policy`. Assert the expected `policyVersion`, then use
   `require.resolve()` to verify CommonJS resolution without promising synchronous ESM execution.
   This check verifies the export conditions, emitted and packed files, and Electron-free runtime
   graph.
4. Extend the packed TypeScript consumer to import `LLAMA_CALIBRATION_DEFAULTS` from the new subpath.
   Keep the existing negative assertion that the resolver is not a package-root export.
5. Document the supported plain-Node import, the strict package boundary, and the prospective
   `policyVersion` compatibility rule in README, LLM calibration/persistence guidance, and the
   TypeScript constants reference.
6. Record the work under a `PROGRESS.md` Unreleased section. At implementation completion, archive
   this issue under `docs/dev/issues/` with its resolution. Create release migration notes only when
   release preparation is explicitly requested.
7. Update the known downstream consumer: move the policy pin to the supported subpath and remove
   the resolver/deep-import assertion.

## Consequences

- Plain-Node consumers gain one explicit, stable policy-metadata entry without making the Electron
  runtime entry portable.
- The package gains a real encapsulation boundary. Existing undeclared deep imports will fail and
  must migrate in the breaking release.
- The resolver remains free to change with internal manager implementation because it is not a
  supported package API.
- The packed-package check enforces the Electron-free guarantee against what npm would actually
  publish, rather than relying on a source-level import convention.
- The new policy-version rule is a maintainer obligation that cannot be inferred mechanically from
  a diff; policy-affecting changes must review it explicitly.

## Acceptance criteria

- `genai-electron/llm-calibration-policy` is the only supported path a plain-Node consumer needs for
  the LLM calibration policy pin.
- `LLAMA_CALIBRATION_DEFAULTS` is reachable through that subpath with correct generated types.
- Importing the subpath from the packed tarball succeeds under plain Node before Electron is
  installed or linked, and CommonJS resolution selects its emitted file.
- The packed runtime check asserts `LLAMA_CALIBRATION_DEFAULTS.policyVersion` and fails if the entry
  transitively reaches Electron.
- `resolveLlamaCalibrationTimeBudget()` remains absent from the package root and the supported
  policy subpath.
- The package declares `.`, `./llm-calibration-policy`, and `./package.json`; undeclared `dist/`
  paths are sealed with no wildcard or exact exception.
- Before release, the known downstream consumer migrates off every `genai-electron/dist/...`
  import and removes its internal-resolver assertion.
- Documentation defines when a calibration-policy compatibility change must bump `policyVersion`.
- Release/migration notes identify strict `exports` encapsulation as breaking and state that deep
  imports stop resolving.
