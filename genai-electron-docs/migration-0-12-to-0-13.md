# Migrating from v0.12.x to v0.13.0

v0.13.0 is an additive API release. Existing model download configurations and legacy metadata
continue to work without changes. The bundled stable-diffusion.cpp pin does change, so applications
using image generation should re-verify their model, text-encoder, and VAE combinations.

Because this package is still below `1.0.0`, a dependency range such as `^0.12.1` does **not** admit
`0.13.0`. Update the range explicitly when you are ready to adopt this release.

## What changed

- Structured Hugging Face downloads now support an optional branch, tag, or commit `revision`.
- Nested repository file paths are encoded per segment while preserving `/` separators.
- Newly written diffusion component metadata retains a normalized `source` locator.
- Callers can persist optional artifact license-declaration context through `ArtifactProvenance`.
- stable-diffusion.cpp moves from `master-746-2574f59` to `master-782-b290693`.

## No required code migration

Existing two-argument `getHuggingFaceURL(repo, file)` calls still resolve `main`. Existing
`DownloadConfig` and `DiffusionComponentDownload` objects may omit `revision` and `provenance`.
Metadata written by older versions without component `source` or provenance fields still loads.

The genai-lite integration contract is unchanged.

## Pin reproducible Hugging Face downloads

Pass a full commit SHA when reproducibility matters. Branches and tags are supported but can move.

```typescript
const model = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'example/model-GGUF',
  file: 'Q4_K_M/model-00001-of-00003.gguf',
  revision: '0123456789abcdef0123456789abcdef01234567',
  name: 'Example Model Q4 K M',
  type: 'llm',
});

console.log(model.source.revision);
```

Bare sibling shards inherit the primary revision. Each multi-component download entry may select
its own revision.

`parseHuggingFaceURL()` now returns `{ repo, revision, file }`. Code that deep-compares its complete
return value against the older `{ repo, file }` shape must account for the additive `revision`
property.

## Persist artifact license declarations

`ArtifactProvenance` is caller-supplied license-declaration context:

```typescript
const model = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'example/image-model',
  file: 'model.gguf',
  revision: '0123456789abcdef0123456789abcdef01234567',
  name: 'Example Image Model',
  type: 'diffusion',
  provenance: {
    license: 'Apache-2.0',
    licenseUrl: 'https://example.com/image-model/LICENSE',
    lastCheckedOn: '2026-07-26',
    note: 'Declaration recorded by the application.',
  },
  components: [
    {
      role: 'vae',
      source: 'huggingface',
      repo: 'example/vae',
      file: 'vae.safetensors',
      provenance: {
        license: 'inferred:Apache-2.0',
        note: 'Application-specific supporting evidence.',
      },
    },
  ],
});
```

The package stores and returns these strings but never validates, normalizes, interprets, fetches,
compares, or makes policy decisions from them. Top-level provenance describes the primary artifact;
additional components receive only their own declarations. Sharded models store the declaration
once on `ModelInfo`, not on individual shards.

When model variants reuse a physical component file, each installed model record retains the
declaration supplied for that configuration. This is configuration metadata, not forensic
first-download history.

## stable-diffusion.cpp compatibility re-verification

The binary pin changes:

```text
master-746-2574f59 → master-782-b290693
```

The next diffusion-server start downloads and validates the new platform binary. All CLI flags
currently emitted by genai-electron remain accepted, and the pinned upstream `docs/flux2.md` still
lists `black-forest-labs/FLUX.2-small-decoder` /
`full_encoder_small_decoder.safetensors` as a Flux 2 VAE option.

Nevertheless, re-run a meaningful image-generation smoke test for every production model/VAE
combination. An incompatible VAE can produce a gray or otherwise invalid image without a useful
error, so process startup alone is not sufficient validation.

The new upstream `dpm++2m_sde` and `dpm++2m_sde_bt` samplers are deliberately not exposed because
the pinned source has an out-of-bounds display-name lookup for them. Existing sampler APIs are
unchanged.

## Upgrade checklist

1. Change your dependency to `genai-electron@^0.13.0` (or an exact version).
2. Rebuild the Electron application and allow the new sd.cpp binary to provision.
3. Generate and visually inspect a representative image for each production diffusion setup.
4. Add full commit revisions where reproducible Hugging Face downloads are required.
5. Add provenance declarations only where your application has authoritative data.

## See also

- [Model Management](model-management.md)
- [TypeScript Reference](typescript-reference.md)
- [Migrating 0.11 → 0.12](migration-0-11-to-0-12.md)
