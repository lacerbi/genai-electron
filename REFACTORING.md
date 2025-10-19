# Refactoring Playbook (Low Effort First)

This document captures pragmatic refactoring steps we can ship without repeating earlier painful attempts. Every recommendation below is:

- **Scoped** – fits comfortably in a small PR.
- **Reversible** – touches a narrow surface so we can back out quickly if needed.
- **Testable** – has a clear validation plan using the existing unit suite.

The priorities are ordered; complete one fully (including tests) before moving to the next.

---

## 1. Centralize Log Management in `ServerManager`

**Problem:** `LlamaServerManager` and `DiffusionServerManager` each declare `logManager`, `getLogs`, and `clearLogs` with identical logic.

**Outcome:** One implementation in `ServerManager`; subclasses no longer duplicate boilerplate.

**Implementation Steps:**
1. Move the shared `logManager?: LogManager` property to `ServerManager`.
2. Copy the existing `getLogs` / `clearLogs` bodies into protected methods on `ServerManager`.
3. Update each server manager to call the inherited versions and remove local duplicates.

**Tests to Run:**  
`npm test -- --runTestsByPath tests/unit/LlamaServerManager.test.ts tests/unit/DiffusionServerManager.test.ts`

---

## 2. Add `checkPortAvailability` Helper

**Problem:** Both managers import `isServerResponding` and throw `PortInUseError` with identical code.

**Outcome:** Port validation lives in one protected method; future managers reuse it automatically.

**Implementation Steps:**
1. Add `protected async checkPortAvailability(port: number, timeout = 2000)` to `ServerManager`.
2. Move the duplicated logic (dynamic import + `PortInUseError`) into the helper.
3. Replace inline checks in both managers with `await this.checkPortAvailability(port);`.

**Tests to Run:** Same as Step 1 (port logic is already covered there).

---

## 3. Provide `initializeLogManager` Utility

**Problem:** Both managers build log paths and write the same “Starting …” message with only string differences.

**Outcome:** A shared helper handles log bootstrapping while allowing custom filenames/messages.

**Implementation Steps:**
1. Add `protected async initializeLogManager(logFileName: string, startupMessage: string)` to `ServerManager`.
2. Call the helper inside each `start()` method using server-specific filenames/messages.
3. Remove the duplicated log initialisation code from subclasses.

**Tests to Run:** Rerun the two unit suites and confirm expected log lines are still asserted (update test fixtures if message text changes).

---

## 4. Unify Startup Error Handling

**Problem:** `catch` blocks in each `start()` method reimplement the same cleanup and error rethrow logic.

**Outcome:** `ServerManager` exposes `protected async handleStartupError(serverName: string, error: unknown)` that encapsulates logging, status reset, and error normalization.

**Implementation Steps:**
1. Extract the duplicated code into the new helper inside `ServerManager`.
2. Replace the subclass `catch` bodies with `await this.handleStartupError('llama-server', error);` (adjust name per manager).
3. Keep any truly custom cleanup in the subclass before calling the helper.

**Tests to Run:**  
`npm test -- --runTestsByPath tests/unit/LlamaServerManager.test.ts tests/unit/DiffusionServerManager.test.ts`

---

## 5. Add `ensureBinaryHelper`

**Problem:** Binary bootstrapping differs only by string literals (type, binary name, version map).

**Outcome:** Subclasses call a shared helper and supply only the values that differ.

**Implementation Steps:**
1. Implement `protected async ensureBinaryHelper(type: 'llama' | 'diffusion', binaryName: string, config: BinaryConfig)` in `ServerManager`.
2. Move the existing `BinaryManager` instantiation into the helper.
3. Update each manager to call `return this.ensureBinaryHelper('llama', 'llama-server', BINARY_VERSIONS.llamaServer);` (and the diffusion equivalent).

**Tests to Run:** Same focused unit suites; these already stub or spy on binary logic.

---

## Rollout Checklist for Each Step

- [ ] Keep diffs mechanical: no unrelated formatting or renames.
- [ ] Touch one concern per PR; rebase between steps if needed.
- [ ] Run targeted unit tests locally; capture results in the PR description.
- [ ] Optionally add a one-off regression test if a helper gains new behavior.
- [ ] After merge, smoke test locally (start/stop both managers) before publishing.

Staying disciplined with these bite-sized changes will let us harvest the easy wins from the earlier analysis without the regressions we hit in the past.
