# Migrating from v0.22.0 to v0.22.1

v0.22.1 is a packaging-correctness patch for ZIP extraction in bundled Electron applications. It
does not add or remove public APIs, change TypeScript types, alter package exports, or invalidate
LLM calibration reports.

## What changed

v0.22.0 resolved `adm-zip` at package-root module evaluation so an inline worker could import the
resolved file later. A consumer that bundled the package root into an Electron main process could
therefore crash at startup when `adm-zip` was not copied as a loose runtime module beside the
bundle or inside the ASAR.

v0.22.1 embeds exact-pinned `adm-zip` 0.6.0 directly into the existing inline worker. Importing the
package root no longer resolves or imports `adm-zip`, and real ZIP extraction works from a
single-file bundle with no `node_modules` ancestor. The typed extraction loop, worker-thread
responsiveness, entry-progress sequence, path-containment checks, and public error behavior are
unchanged.

The embedded implementation's complete MIT notice ships in `THIRD_PARTY_NOTICES.md`. `adm-zip`
remains an exact development input for deterministic regeneration and auditing, but it is no longer
a published runtime dependency.

## Consumer action

1. Update exact dependency pins to `genai-electron` v0.22.1. A range such as `^0.22.0` already
   admits this patch under pre-1.0 semver rules.
2. Remove any direct `adm-zip` dependency that existed only to satisfy genai-electron's worker.
3. Remove ASAR unpack rules, copy steps, or bundler externalization/no-external exceptions that
   existed only to keep `adm-zip` resolvable at runtime.
4. Keep normal Electron lifecycle ordering: static package imports are safe, but call
   path-dependent managers only after `app.whenReady()`.
5. Rebuild the packaged Electron application and exercise a real binary download or ZIP extraction
   path.

Do not remove an application's own direct `adm-zip` dependency or packaging rules if its code uses
that package independently of genai-electron.

## Compatibility

- All documented v0.22.0 imports and public APIs remain valid.
- The `genai-electron/llm-calibration-policy` entry and strict package-export boundary are
  unchanged.
- Persisted schema-v4 LLM calibration reports remain valid; no recalibration is required.
- Node, Electron, llama.cpp, stable-diffusion.cpp, and genai-lite compatibility are unchanged.
- The published package is larger because it now carries the ZIP implementation and its license
  rather than relying on a separately installed runtime package.

## Verification and rollback

Verify the production bundle without providing `adm-zip` as a loose module. The application should
import `genai-electron` successfully and complete a real ZIP-backed provisioning flow with the
expected progress updates.

If an application cannot adopt v0.22.1 immediately, pin v0.22.0 and retain its existing loose-module
or bundler workaround. Do not remove that workaround while running v0.22.0.

## Checklist

- [ ] Update the dependency to genai-electron v0.22.1 or confirm the existing range admits it.
- [ ] Remove only genai-electron-specific `adm-zip` packaging workarounds.
- [ ] Rebuild the packaged Electron application.
- [ ] Exercise one real ZIP extraction or binary provisioning flow.
- [ ] Review `THIRD_PARTY_NOTICES.md` if redistributing bundled third-party notices separately.
