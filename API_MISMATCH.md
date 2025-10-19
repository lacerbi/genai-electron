# API vs Implementation Review

The following items highlight where `docs/API.md` diverges from the current implementation. Each entry includes a recommendation on whether to align the documentation or adjust the code.

---

## 1. Instantiating `SystemInfo`

- **Docs**: suggest `new SystemInfo()`.
- **Reality**: constructor is private; only the singleton (`systemInfo`) or `SystemInfo.getInstance()` works.
- **Recommendation**: update the docs to show `SystemInfo.getInstance()` (or the exported singleton). The singleton design is intentional, so no code change needed.

---

## 2. `SystemInfo.canRunModel` return shape

- **Docs**: `{ canRun: boolean; reason?: string }`.
- **Reality**: `{ possible: boolean; reason?: string; suggestion?: string }`.
- **Recommendation**: fix the docs/examples to use the `possible` property and mention the `suggestion` field. The implementation is already shipping and consistent internally, so renaming the property would be breaking.

---

## 3. `SystemInfo.getOptimalConfig` return type

- **Docs**: promises a full `ServerConfig`.
- **Reality**: returns `Partial<ServerConfig>` (threads/context/gpuLayers/etc., but no `modelId`/`port`).
- **Recommendation**: clarify in the docs that it returns a partial config meant to be spread into a full start call. The existing behaviour is reasonable and widely used in examples.

---

## 4. Instantiating `ModelManager`

- **Docs**: show `new ModelManager()`.
- **Reality**: constructor is private; callers must use `modelManager` or `ModelManager.getInstance()`.
- **Recommendation**: update the docs. The singleton pattern is deliberate; no code change required.

---

## 5. `ModelManager.verifyModel` behaviour without checksum

- **Docs**: state it “returns `true` if no checksum stored”.
- **Reality**: the method returns `false` when no checksum is available (it can’t verify integrity).
- **Recommendation**: fix the wording in the docs to reflect the actual behaviour.

---

## 6. `llamaServer.getStatus()` return value

- **Docs**: describe a structured object with `status`, `health`, `pid`, etc.
- **Reality**: `getStatus()` returns the `ServerStatus` enum (`'running'`, `'stopped'`, …). The detailed object comes from `getInfo()`.
- **Recommendation**: adjust the docs/examples to call `getInfo()` when the structured data is needed. Changing the method signature would break consumers.

---

## 7. `llamaServer.restart()` return type

- **Docs**: declared as `Promise<void>`.
- **Reality**: `ServerManager.restart()` returns `Promise<ServerInfo>`, and `LlamaServerManager` inherits that behaviour.
- **Recommendation**: update the docs; the ability to get the `ServerInfo` is useful and should remain.

---

## 8. `llamaServer.getLogs()` return type

- **Docs**: claim `Promise<string>`.
- **Reality**: returns `Promise<string[]>`.
- **Recommendation**: correct the docs. The implementation already matches its tests.

---

## 9. `diffusionServer.getStatus()` and structured info

- **Docs**: same issue as #6; expect a full `DiffusionServerInfo`.
- **Reality**: `getStatus()` returns `ServerStatus`, while `getInfo()` provides the structured object (with `busy`, etc.).
- **Recommendation**: update the docs to use `getInfo()`. No code change needed unless we decide to rename methods in a future major release.

---

## 10. `DiffusionServerConfig.vramBudget`

- **Docs**: document a `vramBudget` option.
- **Reality**: the manager ignores that field.
- **Recommendation**: choose one of:
  - remove the option from the docs (quickest: keeps API accurate), or
  - implement support by wiring the value into the stable-diffusion invocation (requires upstream flag support).
  
Until we commit to implementing it, the safer move is to drop it from the reference.

---

## 11. `diffusionServer.generateImage` error types

- **Docs**: list both `ServerError` and `ModelNotFoundError`.
- **Reality**: once the server is running, the method only throws `ServerError`. Model validation happens in `start()`.
- **Recommendation**: update the docs to mention `ServerError` (and note that model errors arise during `start()`).

---

## 12. `ResourceOrchestrator` constructor defaults

- **Docs**: imply all parameters are optional.
- **Reality**: defaults exist for `systemInfo` and `modelManager`, but callers must supply `llamaServer` and `diffusionServer`.
- **Recommendation**: either:
  - **Doc fix**: mark the LLM/diffusion managers as required (fastest, zero risk), or
  - **Code enhancement**: add default values pulling from the exported singletons so users can instantiate without arguments.

Given the current API shape, updating the docs is the minimal, non-breaking change. Adding defaults could be a future DX improvement.

---

## Summary

Most discrepancies stem from documentation drift rather than API bugs. The only substantive decision point is `DiffusionServerConfig.vramBudget`; every other mismatch is best solved by aligning the docs with the shipped behaviour. Once the documentation reflects the actual interfaces, developers won’t hit surprises when integrating against the library.***
