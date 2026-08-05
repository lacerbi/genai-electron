# Eager adm-zip resolve crashes bundling consumers at startup

Filed: 2026-08-05, by palimpsest-engine
Status: OPEN
Package: genai-electron 0.22.0

Consumer context: Electron GUI, electron-vite/Rollup, genai-electron bundled into an ESM
main bundle inside an ASAR.

## Problem

`dist/utils/archive-utils.js:53` runs at module top level:

```js
const admZipModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve('adm-zip')).toString();
```

It resolves eagerly so the zip worker — built from a stringified function and started with
`eval: true` — can `import(data.admZipModuleUrl)` (`:17`). The resolve sits on the static
import chain from the package root (`index.js` → `LlamaServerManager` → `ServerManager` →
`BinaryManager` → `archive-utils`), so it executes the moment any consumer imports
genai-electron.

A bundler inlines the module but does not fold `createRequire(...).resolve`, so the call
runs at runtime from wherever the bundle lives. In a packaged Electron app that ships no
resolvable loose `adm-zip`, the main process dies at startup: *"A JavaScript error occurred
in the main process — Error: Cannot find module 'adm-zip'"*. The feature being on the
static chain means no amount of avoiding zip extraction avoids the crash.

## Reproduction

Observed end to end in palimpsest-engine's packaged GUI (electron-forge + maker-zip; the
ASAR carries the bundle, no node_modules anywhere in the app's ancestor chain). Minimal
sketch without Electron:

```bash
mkdir repro && cd repro && npm init -y && npm i genai-electron esbuild
printf "import 'genai-electron';\n" > entry.mjs
npx esbuild entry.mjs --bundle --platform=node --format=esm --external:electron --outfile=dist/bundle.mjs
mkdir /tmp/isolated && cp dist/bundle.mjs /tmp/isolated/ && node /tmp/isolated/bundle.mjs
# → throws at module evaluation: Cannot find module 'adm-zip'
```

## Impact scope (measured over dist/config/defaults.js, 0.22.0)

11 of 15 provisioning artifacts are `.zip`: all four Windows llama.cpp artifacts (including
the cudart dependency) and every existing stable-diffusion build (darwin-x64 ships no
diffusion build at all); macOS/Linux llama.cpp are `.tar.gz` (bundled `tar` handles those).
`detectArchiveFormat` defaults to zip for anything not `.tar.gz`/`.tgz`, and both
`extractBinary` (main binary) and `extractArchive` (dependency archives) funnel zip into the
adm-zip worker. Without a resolvable adm-zip: Windows loses local inference and image
generation; Linux and darwin-arm64 lose image generation.

## Asks

1. Make the resolve lazy (first zip extraction, not module evaluation) and guarded — a
   missing module should surface as a typed provisioning error on the zip path, not a
   startup crash on every path.
2. Consider inlining the zip implementation. adm-zip is ~122 KB of dependency-free JS in a
   137 KB package; vendoring or reimplementing the subset used would remove the runtime
   dependency outright, which is the only change that lets bundling consumers ship nothing.

## Workaround shipped by this consumer

The packaged GUI stages a loose `resources/node_modules/adm-zip` beside the ASAR, where
Node's resolution walk from inside the archive finds it (palimpsest-engine,
`docs/devlogs/2026-08-05-packaged-runtime-dependencies.md`). The staging stays until a
release changes the above; ask 2 would let the manifest shrink.
