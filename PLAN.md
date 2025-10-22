# Async Image Generation API - Implementation Plan

Based on: `docs/2025-10-22-genai-electron-changes.md`

## Overview

Replace blocking `/v1/images/generations` endpoint with async pattern:
- POST returns generation ID immediately
- GET polls for progress/results
- Support batch generation (count parameter)

---

## Phase 1: Core Infrastructure

### 1.1 Generation Registry
**New file:** `src/managers/GenerationRegistry.ts`

```typescript
interface GenerationState {
  id: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  createdAt: number;
  updatedAt: number;
  config: ImageGenerationConfig;
  progress?: {
    currentStep: number;
    totalSteps: number;
    stage: 'loading' | 'diffusion' | 'decoding';
    percentage?: number;
    currentImage?: number;  // NEW for batch
    totalImages?: number;   // NEW for batch
  };
  result?: { images: ImageGenerationResult[]; format: 'png'; timeTaken: number };
  error?: { message: string; code: string };
}

class GenerationRegistry {
  private generations = new Map<string, GenerationState>();

  create(config: ImageGenerationConfig): string
  get(id: string): GenerationState | null
  update(id: string, updates: Partial<GenerationState>): void
  delete(id: string): void
  cleanup(maxAgeMs: number): void  // Remove old complete/error states
}
```

**Features:**
- In-memory Map storage
- TTL: 5 minutes for completed generations
- Cleanup interval: 1 minute
- Environment config: `IMAGE_RESULT_TTL_MS`, `IMAGE_CLEANUP_INTERVAL_MS`

### 1.2 Generation ID
**New file:** `src/utils/generation-id.ts`

```typescript
export function generateId(): string {
  return `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
```

### 1.3 Type Updates
**Update:** `src/types/images.ts`

Add to `ImageGenerationConfig`:
```typescript
count?: number;  // Default: 1, max: 5
```

Add to `ImageGenerationProgress`:
```typescript
currentImage?: number;   // Which image (1-indexed)
totalImages?: number;    // Total in batch
```

New types:
```typescript
export type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface GenerationState {
  // ... (see above)
}
```

---

## Phase 2: Batch Generation

### 2.1 Update `DiffusionServerManager.executeImageGeneration()`

Current: generates single image
New: loop for `count > 1`

```typescript
async executeImageGeneration(config: ImageGenerationConfig): Promise<ImageGenerationResult[]> {
  const count = config.count || 1;
  const images: ImageGenerationResult[] = [];

  for (let i = 0; i < count; i++) {
    const singleConfig = {
      ...config,
      seed: config.seed !== undefined ? config.seed + i : undefined,
      onProgress: (current, total, stage, pct) => {
        // Wrap progress: calculate overall % across all images
        const overallPct = ((i + pct / 100) / count) * 100;
        config.onProgress?.(current, total, stage, overallPct);
      }
    };

    const result = await this.generateSingleImage(singleConfig);
    images.push(result);
  }

  return images;
}
```

**Progress calculation:**
```
overallPercentage = ((completedImages + currentImageProgress) / totalImages) * 100
```

**Seed handling:**
- Provided seed: use seed, seed+1, seed+2, ...
- No seed: random for each image

---

## Phase 3: HTTP Endpoints

### 3.1 POST /v1/images/generations

**Current:** Waits for generation, returns result
**New:** Returns ID immediately, starts async

```typescript
if (req.url === '/v1/images/generations' && req.method === 'POST') {
  // Parse and validate
  const config: ImageGenerationConfig = JSON.parse(body);

  // Validate count
  if (config.count && (config.count < 1 || config.count > 5)) {
    return res.status(400).json({ error: { message: 'count must be 1-5', code: 'INVALID_REQUEST' }});
  }

  // Check busy
  if (this.currentGeneration) {
    return res.status(503).json({ error: { message: 'Server busy', code: 'SERVER_BUSY' }});
  }

  // Create registry entry
  const id = this.registry.create(config);

  // Start generation (async, don't await)
  this.runGeneration(id, config).catch(err => {
    this.registry.update(id, {
      status: 'error',
      error: { message: err.message, code: this.mapErrorCode(err) }
    });
  });

  // Return immediately
  return res.status(201).json({ id, status: 'pending', createdAt: Date.now() });
}
```

### 3.2 GET /v1/images/generations/:id

**New endpoint:**

```typescript
if (req.url?.startsWith('/v1/images/generations/') && req.method === 'GET') {
  const id = req.url.split('/').pop();
  const state = this.registry.get(id);

  if (!state) {
    return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' }});
  }

  const response: any = {
    id: state.id,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };

  if (state.progress) response.progress = state.progress;
  if (state.result) response.result = state.result;
  if (state.error) response.error = state.error;

  return res.status(200).json(response);
}
```

### 3.3 Integration with Registry

Update `executeImageGeneration()` to update registry during generation:

```typescript
private async runGeneration(id: string, config: ImageGenerationConfig): Promise<void> {
  // Update to in_progress
  this.registry.update(id, { status: 'in_progress' });

  // Wrap onProgress to update registry
  const wrappedConfig = {
    ...config,
    onProgress: (current, total, stage, pct) => {
      this.registry.update(id, {
        progress: { currentStep: current, totalSteps: total, stage, percentage: pct }
      });
      config.onProgress?.(current, total, stage, pct);
    }
  };

  // Generate
  const results = await this.executeImageGeneration(wrappedConfig);

  // Update to complete
  this.registry.update(id, {
    status: 'complete',
    result: { images: results, format: 'png', timeTaken: Date.now() - state.createdAt }
  });
}
```

---

## Phase 4: Testing

### 4.1 Unit Tests
**New file:** `tests/unit/GenerationRegistry.test.ts`

Test cases:
- Create/get/update/delete operations
- Cleanup removes old entries (after TTL)
- Cleanup preserves recent entries
- Cleanup only affects complete/error states

### 4.2 Integration Tests
**Update:** `tests/unit/DiffusionServerManager.test.ts`

New test cases:
- POST returns 201 with ID immediately
- GET polling: pending → in_progress → complete flow
- GET returns 404 for invalid ID
- POST returns 503 when busy
- Batch generation: count=2 produces 2 images with seed+1
- Batch progress includes currentImage/totalImages
- Registry cleanup after TTL

---

## Phase 5: Documentation & Validation

### 5.1 Update PROGRESS.md
Add section:
```markdown
### Phase 2.5: Async Image Generation API ✅ (2025-10-22)

**Core Features:**
- Async polling pattern for image generation (POST returns ID, GET polls)
- Batch generation with count parameter (1-5 images per request)
- In-memory generation registry with TTL cleanup
- Progress tracking for batched operations

**Deliverables:**
- GenerationRegistry for state management
- Async HTTP endpoints (POST/GET)
- Sequential batch generation with seed incrementation
- Updated test suite (270+ tests)
```

### 5.2 Build Validation
```bash
npm run build     # 0 TypeScript errors
npm run lint      # Clean
npm run format    # Format all
npm test          # All pass
```

---

## Implementation Order

1. `src/utils/generation-id.ts` (5 min)
2. `src/types/images.ts` updates (10 min)
3. `src/managers/GenerationRegistry.ts` (45 min)
4. `tests/unit/GenerationRegistry.test.ts` (30 min)
5. Update `DiffusionServerManager` batch generation (1 hour)
6. Update `DiffusionServerManager` HTTP endpoints (1 hour)
7. Update `tests/unit/DiffusionServerManager.test.ts` (1 hour)
8. Update `PROGRESS.md` (15 min)
9. Validation and manual testing (30 min)

**Total: ~5-6 hours**

---

## Key Design Decisions

1. **Sequential batch generation**: Simple loop, seed+i for each image
2. **In-memory registry**: Map-based, TTL cleanup (5min default)
3. **Breaking change**: Replace blocking endpoint entirely (per spec §10.1)
4. **Progress wrapping**: onProgress updates registry + calls original callback
5. **Error mapping**: Consistent error codes (SERVER_BUSY, NOT_FOUND, etc.)

---

## Checkboxes (Track Progress)

- [x] generation-id.ts
- [x] types/images.ts updates
- [x] GenerationRegistry.ts
- [x] GenerationRegistry.test.ts
- [x] Batch generation in DiffusionServerManager
- [x] HTTP endpoints refactoring
- [x] DiffusionServerManager tests update (27 new tests added)
- [x] PROGRESS.md update
- [x] Build validation (all green: 0 errors, 273 tests passing, format complete)
