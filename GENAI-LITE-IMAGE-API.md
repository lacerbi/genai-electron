# GENAI-LITE Image API Requirements

Author: _Codex (GPT-5)_  
Date: 2025-10-XX  
Target audience: genai-lite maintainers & contributors (junior developer friendly)

---

## 1. Purpose & Scope
- Extend **genai-lite** with first-class **image generation** capabilities, parallel to the existing LLM (chat) APIs.
- Provide a **provider-agnostic interface** that can call:
  - Cloud providers following the OpenAI `images.generate` contract.
  - Local diffusion endpoints managed by **genai-electron** (stable-diffusion.cpp wrapper).
- Maintain consistency with current genai-lite patterns: presets, adapters, API key provider, error envelopes.
- Initial scope: **text-to-image** generation. (Image editing & variations can be considered later.)
- We own both sides of the local stack; if a small change to genai-electron unlocks a cleaner API (e.g., adding native batching support), we can coordinate that update as part of this effort.

Deliverable: an implementation plan + API contract that a junior dev can follow to add image support without destabilising existing LLM features.

---

## 2. Success Criteria
- A new public API (e.g., `ImageService`) that mirrors `LLMService` ergonomics.
- Adapter architecture for cloud/local providers, reusing `ApiKeyProvider`.
- Requests/responses align with OpenAI image API semantics, while exposing diffusion-specific options when available.
- Comprehensive TypeScript types, error handling, and preset support.
- No breaking changes to existing LLM APIs.

---

## 3. Background & Current Architecture (LLM recap)
- `LLMService` orchestrates providers via adapters, using an `ApiKeyProvider`.
- Requests accept `providerId`, `modelId`, `messages`, `settings`, optional `presetId`.
- Responses normalise provider output into `chat.completion` or `error` envelopes.
- Presets live in `src/config/llm-presets.json` (will be renamed from `presets.json`, see §8.2) and can be extended/replaced via service options.
- Helpers exist for templates, reasoning, llama.cpp, etc.

Image capability should follow the same architectural pillars:
- **Service layer** orchestrates request flow.
- **Adapters/providers** encapsulate provider-specific logic.
- **Presets** configure defaults per provider/model.
- **Shared patterns** for authentication, options merging, and error translation.

---

## 4. Proposed Public API Surface

### 4.1 Service Entry Point
```ts
import { ImageService, fromEnvironment } from 'genai-lite';

const imageService = new ImageService(fromEnvironment);

const result = await imageService.generateImage({
  providerId: 'openai-images',
  modelId: 'gpt-image-1',
  prompt: 'A serene mountain lake at sunrise',
  settings: { size: '1024x1024', quality: 'high' }
});
```

### 4.2 Core Methods
| Method | Description |
| --- | --- |
| `generateImage(request: ImageGenerationRequest)` | Execute a single text-to-image request. |
| `generateImages(request: ImageGenerationRequest & { count?: number })` | Optional helper to request multiple images (maps to `n` for OpenAI). |
| `getProviders(): Promise<ImageProviderInfo[]>` | List registered image providers. |
| `getModels(providerId: ImageProviderId): Promise<ImageModelInfo[]>` | List models per provider. |
| `getPresets(): ImagePreset[]` | Return configured presets. Mirrors LLM preset behaviour. |
| `registerAdapter(id, adapter)` | Allow runtime registration of custom providers (parity with LLM). |

> **Note**: Method names can be revisited if we prefer `createImage` / `createImages` to mirror OpenAI. Implementation should support aliasing if needed.

### 4.3 Request / Response Types
```ts
type ImageProviderId = 'openai-images' | 'electron-diffusion' | string;

interface ImageGenerationRequestBase {
  providerId: ImageProviderId;
  modelId: string;
  prompt: string;
  presetId?: string;
  settings?: ImageGenerationSettings;
  metadata?: Record<string, unknown>; // Optional tracking tag
}

// For parity with OpenAI's `n`, allow multiple outputs.
interface ImageGenerationRequest extends ImageGenerationRequestBase {
  count?: number; // default 1
}

interface ImageGenerationResponse {
  object: 'image.result';
  created: number;
  providerId: ImageProviderId;
  modelId: string;
  data: GeneratedImage[];
  usage?: ImageUsage; // provider-specific metrics (tokens, credits, etc.)
}

interface GeneratedImage {
  index: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Buffer;              // Binary image data
  b64Json?: string;          // Base64 (if caller prefers)
  url?: string;              // For providers that host images (OpenAI)
  prompt?: string;           // Effective prompt after presets / provider transforms
  seed?: number | string;    // When available (diffusion)
  metadata?: Record<string, unknown>;
}

interface ImageUsage {
  cost?: number;             // USD or provider unit
  inputTokens?: number;      // For providers that bill tokens
  outputTokens?: number;
  credits?: number;          // Diffusion credit systems
}

interface ImageProviderInfo {
  id: ImageProviderId;
  displayName: string;
  description?: string;
  capabilities: ImageProviderCapabilities;
  models?: ImageModelInfo[];
}

type ResolvedImageGenerationSettings = ImageGenerationSettings & {
  size: string;
  responseFormat: 'b64_json' | 'url' | 'buffer';
  quality: 'standard' | 'high';
  style: 'vivid' | 'natural';
  diffusion?: ImageGenerationSettings['diffusion'] & {
    width: number;
    height: number;
    steps: number;
    cfgScale: number;
  };
};
```

### 4.4 Error Envelope
Align with existing `LLMFailureResponse` shape:
```ts
type ImageFailureResponse = {
  object: 'error';
  providerId: ImageProviderId;
  error: GenaiLiteError;       // reuse existing error type hierarchy
  partialResponse?: ImageGenerationResponse;
};
```

### 4.5 Settings
Split into **provider-neutral** keys (OpenAI-compatible) and **provider-specific** extensions:
```ts
interface ImageGenerationSettings {
  size?: '256x256' | '512x512' | '1024x1024' | `${number}x${number}`;
  responseFormat?: 'b64_json' | 'url' | 'buffer'; // default 'buffer'
  quality?: 'standard' | 'high';
  style?: 'vivid' | 'natural';
  user?: string;
  // Cloud provider toggles
  n?: number; // alias of count

  // Diffusion-only extensions (namespaced to avoid collisions)
  diffusion?: {
    negativePrompt?: string;
    steps?: number;          // Default 20 if omitted
    cfgScale?: number;       // Default 7.5 if omitted
    seed?: number;
    sampler?: 'euler_a' | 'euler' | 'heun' | 'dpm2' | 'dpm++2s_a' | 'dpm++2m' | 'dpm++2mv2' | 'lcm';
    width?: number;          // Default 512 when not provided
    height?: number;         // Default 512 when not provided
    onProgress?: ImageProgressCallback; // Optional callback for local provider
  };
}

type ImageProgressCallback = (progress: {
  stage: 'loading' | 'diffusion' | 'decoding';
  currentStep: number;
  totalSteps: number;
  percentage?: number;
}) => void;
```

### 4.6 Configuration Defaults
- `ImageService` should derive base URLs using the following priority (highest first):
  1. `request.settings.providerBaseUrl` (reserved for a future enhancement; not currently exposed).
  2. `options.baseUrls?.[providerId]` supplied when constructing the service.
  3. Environment variables (per provider):
     - OpenAI: `OPENAI_API_BASE_URL` (defaults to `https://api.openai.com/v1`).
     - Electron diffusion: `GENAI_ELECTRON_IMAGE_BASE_URL` (defaults to `http://localhost:8081`).
  4. Provider hard-coded default.
- Authentication:
  - Cloud providers use the existing `ApiKeyProvider` (e.g., `OPENAI_API_KEY`).
  - The diffusion adapter ignores `apiKey`.
- Error messages should include the resolved base URL when network failures occur to simplify debugging.

---

## 5. Provider & Adapter Contracts

### 5.1 Adapter Interface
```ts
interface ImageProviderAdapter {
  readonly id: ImageProviderId;
  readonly supports: ImageProviderCapabilities;

  generate(config: {
    request: ImageGenerationRequest;
    resolvedPrompt: string;
    settings: ResolvedImageGenerationSettings;
    apiKey: string | null;
  }): Promise<ImageGenerationResponse>;

  getModels?(): Promise<ImageModelInfo[]>;
}

interface ImageProviderCapabilities {
  supportsMultipleImages: boolean;
  supportsB64Json: boolean;
  supportsHostedUrls: boolean;
  supportsProgressEvents: boolean;
  supportsNegativePrompt: boolean;
  defaultModelId: string;
}

// Field meaning:
// - supportsMultipleImages: provider can return >1 image per request.
// - supportsB64Json: provider can return base64 in response body.
// - supportsHostedUrls: provider returns hosted URLs (e.g., OpenAI CDN).
// - supportsProgressEvents: adapter can emit incremental progress callbacks.
// - supportsNegativePrompt: provider accepts negative prompt input.
// - defaultModelId: fallback model when caller omits modelId in presets.
```

### 5.2 Built-in Adapters (Phase 1)
1. **OpenAI Images Adapter**
   - Uses existing HTTP client stack.
   - Requires `OPENAI_API_KEY`.
   - Base URL from `OPENAI_API_BASE_URL` (default `https://api.openai.com/v1`).
   - Maps settings to `/images/generations`.
   - Provides optional `n`, `size`, `quality`, `style`, `response_format`.
   - Returns `url` and `b64_json`; convert to `Buffer` when `responseFormat` includes binary.

2. **GenAI Electron Diffusion Adapter**
   - Communicates with genai-electron diffusion HTTP wrapper (`diffusionServer`).
   - Default base URL from `GENAI_ELECTRON_IMAGE_BASE_URL` (default `http://localhost:8081`).
   - HTTP endpoints exposed by the wrapper:
     - `GET /health` &rarr; `{ status: 'ok' | 'loading' | 'error', busy: boolean }`
     - `POST /v1/images/generations` &rarr; accepts `ImageGenerationConfig` JSON body (fields documented below).
   - No API key required (`apiKey` ignored).
   - Supports `diffusion` settings (prompt, negativePrompt, width/height, steps, cfgScale, seed, sampler).
   - Progress: Uses callback-based notifications via `onProgress` parameter (see §8.3 for rationale).
   - Returns PNG buffer; add base64 variant when requested.
   - Surface metadata: `timeTaken`, `seed`, `width`, `height`.
   - Supports `count` parameter for generating multiple images (see §8.4 for implementation details).

   **Request payload shape (JSON)**
   ```jsonc
   {
     "prompt": "A serene mountain lake at sunrise",
     "negativePrompt": "blurry, low quality",
     "width": 1024,
     "height": 1024,
     "steps": 30,
     "cfgScale": 7.5,
     "seed": 42,
     "sampler": "dpm++2m",
     "count": 1  // Optional, default 1 (see §8.4)
   }
   ```

   **Response payload (JSON)**
   ```jsonc
   {
     "images": [
       {
         "image": "<base64 PNG>",
         "seed": 42,
         "width": 1024,
         "height": 1024
       }
       // Additional images if count > 1
     ],
     "format": "png",
     "timeTaken": 5823
   }
   ```
   The adapter must convert the `image` field(s) back into `Buffer`(s), populate `GeneratedImage[]`, and optionally re-emit the base64 string when `responseFormat` requires it.

### 5.3 Model & Preset Definitions
```ts
interface ImageModelInfo {
  id: string;
  providerId: ImageProviderId;
  displayName: string;
  description?: string;
  defaultSettings?: ImageGenerationSettings;
  capabilities: ImageProviderCapabilities;
}

interface ImagePreset {
  id: string;
  displayName: string;
  providerId: ImageProviderId;
  modelId: string;
  promptPrefix?: string;         // Optional forced prefix (e.g., style guide)
  settings?: ImageGenerationSettings;
}
```

Presets should live in `src/config/image-presets.json` (separate from LLM presets, see §8.2), with the same extend/replace mechanism via `ImageServiceOptions`:
```ts
interface ImageServiceOptions {
  presets?: ImagePreset[];
  presetMode?: 'extend' | 'replace';
  adapters?: Record<ImageProviderId, ImageProviderAdapter>;
  /**
   * Override default base URLs per provider.
   * Example: { 'openai-images': 'https://api.openai.com/v1', 'electron-diffusion': 'http://localhost:8081' }
   */
  baseUrls?: Record<ImageProviderId, string>;
}
```

---

## 6. Prompt & Template Support
- Reuse existing `renderTemplate` / `createMessages` utilities where possible.
- Provide a helper for image prompts:
  - `imageService.createPrompt({ template, variables, presetId? })` returning `{ prompt, settings }`.
  - Optional support for multi-part prompts (e.g., `[ { type: 'text', text: ... }, { type: 'image', image: ... } ]`) if editing support is planned later.
- Encourage reuse of LLM templating by documenting recommended pattern.

---

## 7. Error Handling & Validation
- Reuse shared error classes (`GenaiLiteError` and subclasses).
- Validate:
  - `providerId` registered.
  - `modelId` known or allow passthrough if provider supports dynamic IDs.
  - Prompt is non-empty string.
  - Settings (size, quality, steps, etc.) fall within provider caps. (Provider adapters enforce, service performs basic guard rails.)
- Convert provider errors to normalized error envelopes with `error.type` (authentication, rate_limit, validation, server_error, etc.).
- For local provider timeouts, map to `network_error`.

---

## 8. Open Questions / Items Needing Clarification

### ✅ 1. Settings Namespacing - RESOLVED

**Question:** Should provider-specific options live under explicit namespaces (`diffusion`, `openaiExtras`) or a generic `providerExtras` object keyed by provider ID?

**Answer:** Use feature-based namespacing with explicit namespace like `diffusion`. The current design in §4.5 is correct.

**Rationale:**
- Follows existing genai-lite patterns (e.g., `reasoning` namespace for LLM reasoning features)
- Semantically accurate: parameters like `negativePrompt`, `steps`, `cfgScale`, `seed`, `sampler` are common to ALL diffusion-based image generation systems, not specific to genai-electron
- Provides type safety and discoverability via TypeScript autocomplete
- Any future diffusion provider (Stability AI, Replicate, etc.) can reuse these same settings
- OpenAI's simplified API (`quality`, `style`) is the outlier, not the norm

**Implementation:** The `diffusion` namespace in `ImageGenerationSettings` (as defined in §4.5) is the final design. No changes needed.

**Future extensibility:** If truly provider-specific settings emerge that don't fit any feature category, a generic `providerOptions?: Record<ImageProviderId, unknown>` escape hatch can be added later without breaking changes.

---

### ✅ 2. Preset Storage - RESOLVED

**Question:** Do we co-locate image presets with LLM presets (`presets.json`) or create a separate file? (Recommendation: new `image-presets.json` for clarity.)

**Answer:** Create separate `src/config/image-presets.json` file. Additionally, rename existing `presets.json` to `llm-presets.json` for consistency.

**Rationale:**
- Clear separation of concerns: `LLMService` and `ImageService` are distinct APIs with independent lifecycles
- Each service loads only its relevant presets (performance + clarity)
- Easier to maintain: image presets can evolve independently from LLM presets
- Follows convention: if genai-lite adds more services (audio, video), each would have its own preset file
- User customization stays clean: users extending presets know exactly which file to reference
- No risk of breaking existing LLM preset structure during image feature development

**File structure:**
```
src/config/
├── llm-presets.json      # LLM presets (renamed from presets.json)
└── image-presets.json    # Image presets (new)
```

**Example image preset:**
```json
{
  "id": "electron-sdxl-quality",
  "displayName": "SDXL (Quality)",
  "providerId": "electron-diffusion",
  "modelId": "sdxl",
  "settings": {
    "diffusion": {
      "steps": 30,
      "cfgScale": 7.5,
      "sampler": "dpm++2m",
      "width": 1024,
      "height": 1024
    }
  }
}
```

**Migration note:** Renaming `presets.json` → `llm-presets.json` is a breaking change for users who import presets directly. The implementation should include:
1. Keep `presets.json` as a re-export of `llm-presets.json` for backward compatibility (with deprecation notice)
2. Update all internal imports to use `llm-presets.json`
3. Document the migration path in CHANGELOG

---

### ✅ 3. Streaming Progress - RESOLVED

**Question:** Should `generateImage` support async iterable responses (for diffusion progress) or stick to callback-based notifications?

**Answer:** Use callback-based notifications as currently specified in §4.5. The `onProgress` callback in the `diffusion` settings namespace is the correct design.

**Rationale:**
- **Consistency with genai-electron**: The library already provides callbacks. genai-lite should pass these through rather than transforming the API
- **Provider reality**: Only local diffusion benefits from progress updates. OpenAI returns a single response with no intermediate updates
- **UI framework compatibility**: Callbacks are easier to integrate with React, Vue, etc.:
  ```typescript
  const [progress, setProgress] = useState(0);

  await imageService.generateImage({
    settings: {
      diffusion: {
        onProgress: (p) => setProgress(p.percentage || 0)
      }
    }
  });
  ```
- **Optional by design**: Providers that don't support progress simply don't call the callback. No special handling needed
- **Simpler implementation**: genai-lite's ElectronDiffusionAdapter just forwards the callback to genai-electron

**Future extensibility:** If async iterables become necessary later (e.g., for real-time video generation), add a separate `generateImageStream()` method without breaking the existing callback-based `generateImage()` API.

**Implementation note:** The current callback signature in §4.5 is correct and needs no changes.

---

### ✅ 4. Multiple Outputs - RESOLVED

**Question:** When callers request `count > 1`, should the service fan-out sequential calls for the diffusion provider or return an error? (Current HTTP wrapper produces one image per request, but we can extend it to support batching if needed.)

**Answer:** Add native `count` parameter support to genai-electron's diffusion API. genai-lite's ElectronDiffusionAdapter should pass through the `count` parameter directly.

**Rationale:**
- **We control both sides**: Since we maintain both genai-lite and genai-electron, we can coordinate this change
- **Clean abstraction**: genai-lite doesn't need to know about implementation details
- **Simpler adapter**: Just pass through the `count` parameter - no fan-out logic needed in genai-lite
- **Future-proof**: genai-electron can optimize later (using stable-diffusion.cpp's `-b` batch option) without any changes to genai-lite

**Implementation plan:**

1. **genai-electron changes** (in `DiffusionServerManager`):
   - Add `count?: number` parameter to `ImageGenerationConfig` (default: 1)
   - HTTP endpoint accepts `count` in request body
   - Initially: implement as sequential calls internally (simple loop)
   - Later optimization: use stable-diffusion.cpp's `-b` flag for true batching
   - Return array of images in response

2. **genai-lite changes** (in `ElectronDiffusionAdapter`):
   - Pass through `count` parameter to genai-electron API
   - No fan-out logic needed - genai-electron handles it

**Updated genai-electron API contract:**

Request payload:
```jsonc
{
  "prompt": "A mountain lake",
  "count": 3,  // NEW: generate 3 images
  "steps": 30,
  // ... other params
}
```

Response payload:
```jsonc
{
  "images": [
    { "image": "<base64>", "seed": 42, "width": 1024, "height": 1024 },
    { "image": "<base64>", "seed": 43, "width": 1024, "height": 1024 },
    { "image": "<base64>", "seed": 44, "width": 1024, "height": 1024 }
  ],
  "format": "png",
  "timeTaken": 15234
}
```

**Note:** This requires coordinated changes to both repositories, but keeps the architecture clean.

---

### ✅ 5. Future Editing APIs - RESOLVED

**Question:** Should the design leave room for `editImage`, `variations`, or mask-based calls? (Out of scope now, but naming should avoid conflicts.)

**Answer:** The current design already leaves appropriate room for future editing APIs. No changes needed, but document the namespace reservation.

**Rationale:**
- **Naming is specific**: `generateImage()` is clearly text-to-image, not a generic "create image" method
- **Types are scoped**: `ImageGenerationRequest`, `ImageGenerationSettings` are generation-specific
- **Adapters are extensible**: `ImageProviderAdapter` interface can add optional methods:
  ```typescript
  interface ImageProviderAdapter {
    generate(...): Promise<ImageGenerationResponse>;
    edit?(...): Promise<ImageEditResponse>;        // Future
    createVariations?(...): Promise<ImageVariationResponse>;  // Future
  }
  ```
- **Future methods have clear names**: `editImage()`, `createVariations()`, `inpaint()`, etc.

**Reserved API surface for future:**
```typescript
// Future Phase: Image Editing
interface ImageService {
  // Current (Phase 1)
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse | ImageFailureResponse>;

  // Future additions (reserved namespace, not implemented yet)
  editImage?(request: ImageEditRequest): Promise<ImageEditResponse | ImageFailureResponse>;
  createVariations?(request: ImageVariationRequest): Promise<ImageVariationResponse | ImageFailureResponse>;
  inpaint?(request: ImageInpaintRequest): Promise<ImageInpaintResponse | ImageFailureResponse>;
}
```

**Implementation note:** Ensure all Phase 1 types use "Generation" in their names (`ImageGenerationRequest`, `ImageGenerationSettings`, etc.) to avoid conflicts with future editing types.

---

### ✅ 6. Shared Utilities - RESOLVED

**Question:** Any shared token/usage tracking needed between LLM and image services? (For now, usage is optional metadata.)

**Answer:** No shared utility needed at this time. Keep usage tracking independent between services with optional `ImageUsage` metadata in responses.

**Rationale:**
- **Different metrics**: LLMs track tokens, images track dimensions/quality/credits
- **Optional by design**: The `usage` field in `ImageGenerationResponse` is already optional
- **Provider-specific**: Each adapter decides what usage data to include:
  - OpenAI: Could track API costs
  - Electron-diffusion: Could track `timeTaken`, VRAM usage
- **No cross-service tracking needed**: Users tracking overall costs/usage can aggregate from both services independently

**Current design is sufficient:**
```typescript
interface ImageUsage {
  cost?: number;             // USD or provider unit
  inputTokens?: number;      // For providers that bill tokens (rare for images)
  outputTokens?: number;     // For providers that bill tokens (rare for images)
  credits?: number;          // Diffusion credit systems
  // Providers can add custom fields in their adapter
}
```

**Future consideration:** If a unified billing/analytics system becomes necessary, it can be added as a separate optional utility package without changing the core service APIs.

**Implementation note:** Each adapter populates `usage` based on provider capabilities. genai-lite doesn't enforce or validate usage data - it's purely informational.

---

### ✅ 7. Default Export Path - RESOLVED

**Question:** Where should binary image data go by default? (Current plan returns Buffer; caller persists as needed.)

**Answer:** Return `Buffer` by default as specified in §4.3. The caller is responsible for persistence. This is the correct design.

**Rationale:**
- **Flexibility**: Callers can decide where/how to save (filesystem, database, cloud storage, etc.)
- **Memory efficient**: Image stays in memory only as long as needed
- **Consistent with providers**:
  - OpenAI returns URLs (we fetch and convert to Buffer)
  - Electron-diffusion returns base64 (we convert to Buffer)
- **Standard pattern**: Most Node.js image libraries work with Buffers
- **Simple API**: No filesystem operations in the service layer

**Typical usage patterns:**
```typescript
// Save to filesystem
const result = await imageService.generateImage({...});
await fs.writeFile('output.png', result.data[0].data);

// Upload to cloud storage
await uploadToS3(result.data[0].data);

// Convert to base64 for web display
const base64 = result.data[0].data.toString('base64');

// Use with image processing library
const sharp = require('sharp');
await sharp(result.data[0].data).resize(512, 512).toFile('thumbnail.png');
```

**Optional convenience fields:**
- `b64Json`: Included when `responseFormat: 'b64_json'` is requested
- `url`: Included for providers that host images (OpenAI)

**Implementation note:** Adapters should always populate `data: Buffer`. The `b64Json` and `url` fields are provider-specific conveniences.

---

### ✅ 8. Monorepo Packaging - RESOLVED

**Question:** Confirm whether `ImageService` should live in existing `src/services` folder alongside `LLMService` or new namespace.

**Answer:** `ImageService` should live in `src/services/` alongside `LLMService`. Use the same organizational structure as LLM features.

**Rationale:**
- **Parallel architecture**: Both are service classes following the same patterns
- **Shared infrastructure**: Both use `ApiKeyProvider`, presets, adapters, error handling
- **Discoverability**: Users importing from genai-lite expect services to be co-located
- **Consistency**: Matches the library's existing organization

**Proposed file structure:**
```
src/
├── services/
│   ├── llm-service.ts          # Existing
│   └── image-service.ts         # New
├── adapters/
│   ├── llm/                     # Existing LLM adapters
│   │   ├── openai.ts
│   │   ├── anthropic.ts
│   │   └── ...
│   └── image/                   # New image adapters
│       ├── openai-image.ts
│       └── electron-diffusion.ts
├── types/
│   ├── llm.ts                   # Existing
│   └── image.ts                 # New
├── config/
│   ├── llm-presets.json         # Renamed from presets.json
│   └── image-presets.json       # New
└── index.ts                     # Export both services
```

**Package exports:**
```typescript
// src/index.ts
export { LLMService } from './services/llm-service.js';
export { ImageService } from './services/image-service.js';

export type {
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageGenerationSettings,
  // ... all image types
} from './types/image.js';
```

**User imports:**
```typescript
import { LLMService, ImageService, fromEnvironment } from 'genai-lite';

const llm = new LLMService(fromEnvironment);
const image = new ImageService(fromEnvironment);
```

**Implementation note:** Follow the same class structure, method naming conventions, and error handling patterns as `LLMService` for consistency.

---

## 9. Implementation Roadmap (Suggested Tasks)
1. **Scaffold Types**
   - Add new type definitions under `src/types/image.ts`.
   - Export from package entrypoints.
2. **Create ImageService**
   - Mirror `LLMService` structure; accept `ApiKeyProvider` and options.
   - Implement preset resolution, settings merge hierarchy (default < preset < template < runtime).
   - Provide public methods & error envelopes.
3. **Register Default Adapters**
   - `OpenAIImageAdapter` (HTTP POST `/images/generations`).
   - `ElectronDiffusionAdapter` (HTTP POST `/v1/images/generations`).
4. **Integrate Presets**
   - Load `image-presets.json`.
   - Document how to extend/replace via `ImageServiceOptions`.
5. **Add Utilities**
   - Optional: `createPrompt` helper for templates.
   - Progress callback plumbing for diffusion adapter.
6. **Testing**
   - Unit tests for service routing, settings merge, error translation.
   - Integration tests using mocked HTTP clients.
   - Optional e2e tests gated behind environment variables (e.g., `E2E_OPENAI_API_KEY`).
7. **Documentation**
   - Update `GENAI-LITE-README.md` (new section for image service).
   - Provide usage examples (cloud + local).
   - Cross-link from genai-electron docs.

---

## 10. Developer Notes & References
- OpenAI reference: `POST /v1/images/generations`.
- genai-electron diffusion API (Phase 2):
  - Base URL: `http://localhost:8081` (override via `GENAI_ELECTRON_IMAGE_BASE_URL`).
  - Endpoints: `GET /health`, `POST /v1/images/generations`.
  - Request fields: `prompt`, `negativePrompt`, `width`, `height`, `steps`, `cfgScale`, `seed`, `sampler`, `count`.
  - Response includes: base64 images array, `timeTaken`, `seed` values (per image).
- Reuse existing HTTP utilities, logging, and error wrappers in genai-lite.
- Ensure new code follows existing coding standards (TypeScript strict mode, tests).

---

## 11. Next Steps

All open questions in §8 have been resolved. The specification is complete and ready for implementation.

**Immediate next steps:**
1. Review this document with maintainers for final approval
2. Begin implementation following the roadmap in §9
3. Coordinate genai-electron changes for Question 4 (batching support)

**Implementation order recommendation:**
1. Start with genai-electron batching support (Question 4) - independent work
2. Scaffold types and ImageService in genai-lite
3. Implement OpenAI adapter (no genai-electron dependency)
4. Implement Electron-diffusion adapter (requires genai-electron batching)
5. Add presets, documentation, and tests

**Cross-repo coordination needed:**
- genai-electron: Add `count` parameter to diffusion API (Question 4)
- genai-lite: Rename `presets.json` → `llm-presets.json` with backward compatibility (Question 2)

---

_End of document._
