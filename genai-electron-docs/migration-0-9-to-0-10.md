# Migrating from v0.9.x to v0.10.0

v0.10.0 refreshes the **stable-diffusion.cpp runtime**: the pinned binaries jump 242 releases (`master-504-636d3cb` → `master-746-2574f59`), with one behavior change around CUDA CPU-offloading.

## Compatibility

API-compatible — no signatures changed. Two behavioral notes:

### CPU-offload flags now apply on CUDA (behavior change)

Previously, auto-detection never enabled `clipOnCpu` / `vaeOnCpu` / `offloadToCpu` on CUDA installs — a workaround for a silent crash (`0xC0000005`) in older sd.cpp CUDA builds. That crash is fixed upstream (re-verified live on `master-746-2574f59`, each flag alone and all three combined), so auto-detection is now identical on all backends.

Practical effect: low-VRAM CUDA setups may now auto-enable these flags — generations get slower but VRAM-safer (e.g. a 5 GB Flux 2 Klein on an 8 GB GPU now auto-enables `--clip-on-cpu`). Restore the old behavior with explicit `false`:

```typescript
await diffusionServer.start({
  modelId: 'flux-2-klein',
  clipOnCpu: false,
  vaeOnCpu: false,
  offloadToCpu: false,
});
```

**Upstream caveat:** SD3.5-Large conditioning is broken with `--clip-on-cpu` on *any* backend (leejet/stable-diffusion.cpp#1578) — pass `clipOnCpu: false` for that model family.

### Binary re-download on upgrade

The first `diffusionServer.start()` after upgrading re-provisions the binaries for the new pin (the cache is version-tagged): ~360 MB CUDA + 563 MB CUDA runtime on Windows NVIDIA, ~38 MB Vulkan, ~24 MB CPU.

## What's New

- **Windows CPU build**: runtime CPU dispatch — one zip works on every x64 CPU (replaces the AVX2-only build)
- **Linux Vulkan variant** ahead of the CPU fallback — Linux GPU acceleration out of the box
- **New samplers**: `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp`
- Loading-stage progress reporting adapted to the new sd.cpp log format (byte-rate progress bars)

## See Also

- [Image Generation](image-generation.md) · [Troubleshooting — CUDA + CPU offloading](troubleshooting.md) · [Migrating 0.8 → 0.9](migration-0-8-to-0-9.md)
