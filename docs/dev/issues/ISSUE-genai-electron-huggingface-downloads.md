# ISSUE (for genai-electron) — Hugging Face download URLs and component provenance

> **This issue is filed against [`lacerbi/genai-electron`](https://github.com/lacerbi/genai-electron),
> not against palimpsest-engine.** It is parked here only because it was written while auditing a
> consumer. Move it to that repository and delete this copy.

**Observed in:** `genai-electron@0.12.1`
**Filed:** 2026-07-26, from a third-party license audit of a downstream Electron app
**Status:** RESOLVED (2026-07-26, unreleased)

Line references below are to the published `dist/`, since that is what was inspected; the fixes
belong in the corresponding `src/` files.

## Context

The consumer assembles multi-component diffusion models from several Hugging Face repositories —
a Flux 2 Klein preset draws its diffusion model, its Qwen3 text encoder and its VAE from three
different repos under two different licenses. Auditing which artifact came from where surfaced
one likely bug and two gaps. Nothing here is specific to that consumer; any caller downloading
nested paths, pinning versions, or tracking component origins hits the same things.

---

## 1. `getHuggingFaceURL` percent-encodes path separators — latent canonicalization issue

`dist/download/huggingface.js:1-4`

```js
export function getHuggingFaceURL(repo, file) {
    const encodedFile = encodeURIComponent(file);
    return `https://huggingface.co/${repo}/resolve/main/${encodedFile}`;
}
```

`encodeURIComponent` does not spare `/`, so any file inside a subdirectory has its separators
turned into `%2F`:

```
.../resolve/main/split_files%2Fvae%2Fflux2-vae.safetensors     ← produced today
.../resolve/main/split_files/vae/flux2-vae.safetensors         ← intended
```

This affects every repository laying files out in subdirectories, which includes the whole
ComfyUI-style `split_files/...` convention.

**Validated 2026-07-26:** Hugging Face tolerates the encoded separators. Range requests that follow
the redirect returned `206` and the same 1,024 bytes for both `%2F` and literal `/` forms; a bogus
path returned `404` as a control. This is therefore canonicalization and portability cleanup, not a
download regression. The original HEAD-only probe was insufficient because both forms return a
redirect before the CDN response:

```bash
curl -sSL -r 0-1023 -o /dev/null -w "%{http_code} %{size_download}\n" \
  "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files%2Fvae%2Fflux2-vae.safetensors"
curl -sSL -r 0-1023 -o /dev/null -w "%{http_code} %{size_download}\n" \
  "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors"
```

**Proposed fix** — encode per segment:

```js
const encodedFile = file.split('/').map(encodeURIComponent).join('/');
```

**No migration needed.** `parseHuggingFaceURL` decodes after joining path segments
(`dist/download/huggingface.js:24`), so it round-trips both the current and the corrected form.
Fixing the generator does not break the parser.

**Suggested regression test:** a nested path must produce literal `/` separators, and a filename
containing a space or `+` must still be encoded.

---

## 2. No way to pin a download to an immutable revision

`resolve/main` is hardcoded in the same function. Every download therefore resolves against a
mutable branch: an artifact's bytes, and its declared license, can change with no change on the
consumer's side and no signal that anything moved.

For anything with supply-chain or compliance requirements, pinning is the whole point — a
checksum detects that an artifact changed, but only a revision prevents fetching a different one.

**Request:** an optional `revision?: string` (branch, tag or commit SHA, defaulting to `main`) on
`ModelSource`, `DownloadConfig` and `DiffusionComponentDownload`, threaded into
`getHuggingFaceURL(repo, file, revision)`.

**Today's workaround, and why it is not sufficient.** A caller can bypass the helper with
`source: 'url'` and a hand-built `https://huggingface.co/<repo>/resolve/<sha>/<file>`;
`resolveComponentURL` (`dist/managers/ModelManager.js:531`) returns it unvalidated, so this works.
But it discards the structured `repo`/`file` pair, so the model's recorded source becomes an
opaque URL, and it collides with the next item.

### 2b. `parseHuggingFaceURL` rejects every non-`main` URL

`dist/download/huggingface.js:20-23`

```js
const mainIndex = resolveIndex + 1;
if (pathParts[mainIndex] !== 'main') {
    return null;
}
```

This is exported public API, and it returns `null` for precisely the pinned URLs the workaround
above produces. It is unused internally today, so nothing breaks yet — but a caller who pins a
revision and then tries to parse their own URL gets `null` with no explanation.

**Proposed fix:** return the revision rather than requiring it to be `main`:

```js
return { repo, revision: pathParts[mainIndex], file };
```

Worth doing in the same change as item 2 so the two halves stay consistent.

---

## 3. Component downloads discard where they came from

`dist/types/models.d.ts:3-7`

```ts
export interface DiffusionComponentInfo {
    path: string;
    size: number;
    checksum?: string;
}
```

`DiffusionComponentDownload` accepts `repo`, `file` and `url`, but none of it survives the
download. `ModelManager` builds `componentsMap` from `path`, `size` and `checksum` only
(`dist/managers/ModelManager.js:295-308`), while the *primary* file's origin is preserved in
`ModelInfo.source` (`:318`).

So for a model assembled from three repositories, the installed record can say where the
diffusion model came from but not the VAE or the text encoder. There is no way, after install, to
answer "which repository supplied this component" — which is exactly what an audit needs when
components carry different licenses, and what a re-verification pass needs to re-check a source
that may have changed.

**Request:** add the component's origin to `DiffusionComponentInfo`, mirroring `ModelInfo.source`:

```ts
export interface DiffusionComponentInfo {
    path: string;
    size: number;
    checksum?: string;
    source?: ModelSource;   // type, url, repo, file (and revision, per item 2)
}
```

The data is already in hand at download time in `resolveComponentURL`; it is dropped rather than
unavailable.

---

## Ruled out — no action needed

Recorded so these are not re-investigated:

- **Checksum support is complete.** `DownloadConfig.checksum` and
  `DiffusionComponentDownload.checksum` both exist and are verified after download
  (`verifyChecksum`, and re-verification of already-present files at
  `dist/managers/ModelManager.js:230`). Where a consumer cannot pin a component checksum, that is
  the consumer's own IPC type missing the field, not this package.
- **Arbitrary component URLs work.** `resolveComponentURL` does not restrict `source: 'url'` to
  `huggingface.co`, so the item-2 workaround is viable in the meantime.
- **License metadata on `ModelInfo`** was considered and is deliberately not requested here. A
  generic passthrough would work, but which side should own model licensing is a design question,
  and the consumer that raised it holds the data in its own catalog already.

---

## Resolution note (2026-07-26, unreleased)

All requested download-provenance work was implemented and verified:

- Nested Hugging Face file paths are encoded per segment while retaining repository-relative `/`
  separators. Downstream range requests established that legacy `%2F` paths also worked, so this
  was latent correctness/portability hardening rather than a production-regression repair.
- Optional Hugging Face revisions are threaded through structured single-file, sharded, and
  multi-component downloads; the effective revision is persisted, and the URL parser returns
  non-`main` revisions.
- Newly written diffusion component metadata retains a normalized source locator for every role,
  including the primary `diffusion_model`. Reused shared files record the current model
  configuration's locator.
- The checksum findings remain correctly ruled out.

The originally deferred license-declaration question was later reopened and resolved separately in
[`ISSUE-artifact-license-provenance.md`](ISSUE-artifact-license-provenance.md).
Implementation and verification details are retained in
[`PLAN-huggingface-download-provenance.md`](../plans/PLAN-huggingface-download-provenance.md).
