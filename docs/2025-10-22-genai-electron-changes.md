# genai-electron Changes for Async Image Generation API

**Document Version:** 1.0
**Date:** 2025-10-22
**Target Audience:** genai-electron developers
**Context:** Supporting genai-lite Phase 5 image generation with progress polling

---

## Table of Contents

1. [Overview & Motivation](#overview--motivation)
2. [Current Architecture](#current-architecture)
3. [Proposed Architecture](#proposed-architecture)
4. [API Specification](#api-specification)
5. [Implementation Guide](#implementation-guide)
6. [State Management](#state-management)
7. [Integration with DiffusionServerManager](#integration-with-diffusionservermanager)
8. [Error Handling](#error-handling)
9. [Testing Recommendations](#testing-recommendations)
10. [Migration & Backward Compatibility](#migration--backward-compatibility)
11. [Example Client Usage](#example-client-usage)
12. [Open Questions & Configuration](#open-questions--configuration)

---

## 1. Overview & Motivation

### Why This Change?

The current `/v1/images/generations` endpoint is **synchronous/blocking**:
- Client sends POST request
- Server generates image (20-120 seconds)
- Server returns final result
- Client cannot get progress updates over HTTP

This prevents HTTP clients (like genai-lite) from showing progress to users during long-running image generation.

### What We're Building

An **asynchronous image generation API** that:
1. Returns immediately with a generation ID
2. Allows clients to poll for progress
3. Provides real-time progress updates (stage, steps, percentage)
4. Returns final result when complete
5. Supports cancellation (future Phase 3)

### Benefits

- **Better UX:** Clients can show progress bars during generation
- **Non-blocking:** Clients aren't stuck waiting for HTTP timeout
- **RESTful:** Standard async job pattern
- **Scalable:** Foundation for future features (batch generation, queuing)

---

## 2. Current Architecture

### Existing HTTP Endpoint

**Endpoint:** `POST /v1/images/generations`

**Behavior:**
```typescript
// Current implementation (blocking)
app.post('/v1/images/generations', async (req, res) => {
  const config = parseRequest(req.body);

  // This blocks for 20-120 seconds
  const result = await diffusionServer.generateImage(config);

  // Response sent only after completion
  res.json({
    images: [{ image: base64, seed, width, height }],
    format: 'png',
    timeTaken: 5823
  });
});
```

**Limitations:**
- No progress updates over HTTP
- Long connection time (client timeout risk)
- No way to check status or cancel

### Existing Progress Mechanism

Progress callbacks work **only in-process**:

```typescript
// Works in Electron main process
diffusionServer.generateImage({
  prompt: "...",
  onProgress: (currentStep, totalSteps, stage, percentage) => {
    // Called multiple times during generation
    console.log(`${stage}: ${currentStep}/${totalSteps} (${percentage}%)`);
  }
});
```

**This callback mechanism is NOT available to HTTP clients** because the connection is synchronous.

---

## 3. Proposed Architecture

### Async Job Pattern

```
Client                          genai-electron
  │                                  │
  ├─ POST /v1/images/generations ──>│
  │                                  ├─ Generate ID
  │                                  ├─ Start generation (async)
  │<─ Return ID immediately ─────────┤
  │                                  │
  ├─ GET /v1/images/generations/:id ─>│ (poll #1)
  │<─ Status: in_progress, 10% ──────┤
  │                                  │
  ├─ GET /v1/images/generations/:id ─>│ (poll #2)
  │<─ Status: in_progress, 45% ──────┤
  │                                  │
  ├─ GET /v1/images/generations/:id ─>│ (poll #3)
  │<─ Status: complete, images[] ────┤
  │                                  │
```

### State Management

genai-electron maintains a **generation registry**:

```typescript
// In-memory state
const generations = new Map<string, GenerationState>();

interface GenerationState {
  id: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  createdAt: number;
  updatedAt: number;

  // Request parameters
  config: ImageGenerationConfig;

  // Progress tracking (updated by onProgress callback)
  progress?: {
    currentStep: number;
    totalSteps: number;
    stage: 'loading' | 'diffusion' | 'decoding';
    percentage?: number;
  };

  // Final result (when status === 'complete')
  result?: {
    images: Array<{
      image: string;  // base64
      seed: number;
      width: number;
      height: number;
    }>;
    format: 'png';
    timeTaken: number;
  };

  // Error details (when status === 'error')
  error?: {
    message: string;
    code: string;
  };
}
```

### Lifecycle

```
pending ──> in_progress ──> complete
              │
              └──> error
```

- **pending:** Job created, not yet started
- **in_progress:** Generation running, progress available
- **complete:** Image ready, result available
- **error:** Generation failed, error details available

---

## 4. API Specification

### 4.1 Start Generation (POST)

**Endpoint:** `POST /v1/images/generations`

**Request Body:**
```json
{
  "prompt": "A serene mountain lake at sunrise",      // Required
  "negativePrompt": "blurry, low quality",            // Optional
  "width": 1024,                                      // Optional, default: 512
  "height": 1024,                                     // Optional, default: 512
  "steps": 30,                                        // Optional, default: 20
  "cfgScale": 7.5,                                    // Optional, default: 7.5
  "seed": 42,                                         // Optional, random if not provided
  "sampler": "dpm++2m",                               // Optional, default: "euler_a"
  "count": 1                                          // Optional, default: 1, max: 5 (see §4.2.1)
}
```

**Request Body Parameters:**
- `prompt` **(required)**: Text description of the image to generate
- `negativePrompt` (optional): Text to avoid in generation
- `width` (optional): Image width in pixels (default: 512)
- `height` (optional): Image height in pixels (default: 512)
- `steps` (optional): Number of diffusion steps (default: 20, range: 10-50)
- `cfgScale` (optional): Classifier-free guidance scale (default: 7.5, range: 1-20)
- `seed` (optional): Random seed for reproducibility (default: random)
- `sampler` (optional): Sampling algorithm (default: "euler_a", options: "euler_a", "dpm++2m", etc.)
- `count` (optional): Number of images to generate (default: 1, max: 5, see §4.2.1 for details)

**Response:** `201 Created`
```json
{
  "id": "gen_abc123xyz",
  "status": "pending",
  "createdAt": 1729612345678
}
```

**Status Codes:**
- `201 Created` - Generation started successfully
- `400 Bad Request` - Invalid parameters
- `503 Service Unavailable` - Server busy (only 1 generation at a time)

**Error Response (503):**
```json
{
  "error": {
    "message": "Server is busy generating another image",
    "code": "SERVER_BUSY",
    "suggestion": "Wait for current generation to complete and try again"
  }
}
```

---

### 4.2 Get Generation Status/Result (GET)

**Endpoint:** `GET /v1/images/generations/:id`

**Response (pending):** `200 OK`
```json
{
  "id": "gen_abc123xyz",
  "status": "pending",
  "createdAt": 1729612345678,
  "updatedAt": 1729612345678
}
```

**Response (in_progress):** `200 OK`
```json
{
  "id": "gen_abc123xyz",
  "status": "in_progress",
  "createdAt": 1729612345678,
  "updatedAt": 1729612346123,
  "progress": {
    "currentStep": 15,
    "totalSteps": 30,
    "stage": "diffusion",
    "percentage": 52.5
  }
}
```

**Response (complete):** `200 OK`
```json
{
  "id": "gen_abc123xyz",
  "status": "complete",
  "createdAt": 1729612345678,
  "updatedAt": 1729612351501,
  "result": {
    "images": [
      {
        "image": "<base64_encoded_png>",
        "seed": 42,
        "width": 1024,
        "height": 1024
      }
    ],
    "format": "png",
    "timeTaken": 5823
  }
}
```

**Response (error):** `200 OK`
```json
{
  "id": "gen_abc123xyz",
  "status": "error",
  "createdAt": 1729612345678,
  "updatedAt": 1729612346789,
  "error": {
    "message": "Failed to spawn stable-diffusion.cpp: binary not found",
    "code": "BACKEND_ERROR"
  }
}
```

**Status Codes:**
- `200 OK` - Generation found (check `status` field for state)
- `404 Not Found` - Generation ID doesn't exist

**Error Response (404):**
```json
{
  "error": {
    "message": "Generation not found",
    "code": "NOT_FOUND"
  }
}
```

---

### 4.2.1 Batch Generation (count Parameter)

**Purpose:** Generate multiple images in a single request using the `count` parameter.

**Parameter:**
- `count?: number` - Number of images to generate (default: 1, recommended max: 5)
- Optional field in POST request body
- Must be >= 1
- Server should enforce maximum limit (recommended: 5 images per request)

**Implementation Phases:**

**Phase 1 - Sequential Generation (Initial Implementation):**
- Generate images one at a time in a simple loop
- Easy to implement, predictable resource usage
- Progress tracking works naturally (current image / total images)
- Pseudocode:
  ```typescript
  const images = [];
  for (let i = 0; i < count; i++) {
    const image = await generateSingleImage({
      ...config,
      seed: config.seed ? config.seed + i : undefined,
      onProgress: (progress) => {
        // Report progress for current image + completed images
        const overallPercentage = ((i + progress.percentage / 100) / count) * 100;
        callback({ ...progress, currentImage: i + 1, totalImages: count, percentage: overallPercentage });
      }
    });
    images.push(image);
  }
  ```

**Phase 2 - True Batching (Future Optimization):**
- Use stable-diffusion.cpp's `-b` batch flag for parallel generation
- More efficient but more complex
- Requires stable-diffusion.cpp 1.x+ with batch support
- Can be implemented later without API changes

**Seed Handling:**
- If `seed` provided: Generate images with seed, seed+1, seed+2, ..., seed+(count-1)
- If `seed` not provided: Use random seed for each image
- Return actual seed used in each image's metadata

**Progress Tracking for Batched Images:**

When generating multiple images, progress updates should include:
```json
{
  "currentStep": 15,
  "totalSteps": 20,
  "stage": "diffusion",
  "percentage": 52.5,      // Overall: (completed + current progress) / total
  "currentImage": 2,       // NEW: Which image we're generating (1-indexed)
  "totalImages": 3         // NEW: Total images requested
}
```

**Percentage Calculation:**
```
percentage = ((completedImages + currentImageProgress) / totalImages) * 100
```

Example: Generating 3 images, on image #2 at 50% progress:
```
percentage = ((1 + 0.5) / 3) * 100 = 50%
```

**Request Example (count=3):**
```json
{
  "prompt": "A mountain lake",
  "width": 1024,
  "height": 1024,
  "steps": 30,
  "cfgScale": 7.5,
  "seed": 42,
  "sampler": "dpm++2m",
  "count": 3
}
```

**Response Example (in_progress with batch):**
```json
{
  "id": "gen_abc123xyz",
  "status": "in_progress",
  "progress": {
    "currentStep": 15,
    "totalSteps": 30,
    "stage": "diffusion",
    "percentage": 52.5,
    "currentImage": 2,
    "totalImages": 3
  }
}
```

**Response Example (complete with 3 images):**
```json
{
  "id": "gen_abc123xyz",
  "status": "complete",
  "result": {
    "images": [
      {
        "image": "<base64_encoded_png>",
        "seed": 42,
        "width": 1024,
        "height": 1024
      },
      {
        "image": "<base64_encoded_png>",
        "seed": 43,
        "width": 1024,
        "height": 1024
      },
      {
        "image": "<base64_encoded_png>",
        "seed": 44,
        "width": 1024,
        "height": 1024
      }
    ],
    "format": "png",
    "timeTaken": 18500  // Total time for all 3 images
  }
}
```

**Error Handling:**
- If generation fails partway through (e.g., on image 2/3), mark entire request as error
- Include context about which image failed: `"Gener ation failed on image 2 of 3"`
- Don't return partial results - fail the entire batch for consistency

**Validation:**
```typescript
if (count < 1) {
  return error("count must be >= 1");
}
if (count > MAX_BATCH_SIZE) {  // e.g., 5
  return error(`count must be <= ${MAX_BATCH_SIZE}`);
}
```

**Testing Recommendations:**
- Test with count=1 (default behavior)
- Test with count=2, count=3, count=5
- Test with provided seed (verify incremental seeds)
- Test with random seed (verify different seeds)
- Test error handling (what if generation fails on image 3/5)
- Test progress tracking accuracy

---

### 4.3 Cancel Generation (DELETE) - Future Phase 3

**Endpoint:** `DELETE /v1/images/generations/:id`

**Response:** `200 OK`
```json
{
  "id": "gen_abc123xyz",
  "status": "cancelled",
  "message": "Generation cancelled successfully"
}
```

**Note:** Cancellation is planned for Phase 3. For now, return `501 Not Implemented`.

---

### 4.4 List Generations (GET) - Optional

**Endpoint:** `GET /v1/images/generations`

**Response:** `200 OK`
```json
{
  "generations": [
    {
      "id": "gen_abc123xyz",
      "status": "in_progress",
      "createdAt": 1729612345678
    },
    {
      "id": "gen_def456uvw",
      "status": "complete",
      "createdAt": 1729612340123
    }
  ]
}
```

**Note:** This is optional and can be omitted if not needed.

---

## 5. Implementation Guide

### 5.1 Generation ID System

**Requirements:**
- Unique IDs for each generation
- Easy to identify in logs
- URL-safe

**Recommended Format:**
```typescript
function generateId(): string {
  return `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
// Example: "gen_1729612345678_x7k2p9q4m"
```

**Alternative:** Use UUID v4 if preferred.

---

### 5.2 State Storage

**Implementation Options:**

#### Option A: In-Memory Map (Simplest)

```typescript
class GenerationRegistry {
  private generations = new Map<string, GenerationState>();

  create(config: ImageGenerationConfig): string {
    const id = generateId();
    this.generations.set(id, {
      id,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config,
    });
    return id;
  }

  get(id: string): GenerationState | null {
    return this.generations.get(id) || null;
  }

  update(id: string, updates: Partial<GenerationState>): void {
    const state = this.generations.get(id);
    if (state) {
      Object.assign(state, updates);
      state.updatedAt = Date.now();
    }
  }

  delete(id: string): void {
    this.generations.delete(id);
  }

  cleanup(maxAgeMs: number): void {
    const now = Date.now();
    for (const [id, state] of this.generations.entries()) {
      if (state.status === 'complete' || state.status === 'error') {
        if (now - state.updatedAt > maxAgeMs) {
          this.generations.delete(id);
        }
      }
    }
  }
}
```

**Pros:** Simple, fast, no dependencies
**Cons:** Lost on server restart (acceptable for Phase 5)

#### Option B: Persistent Storage (Future Enhancement)

Use SQLite or file-based storage if you need persistence across restarts. Not required for Phase 5.

---

### 5.3 Wiring Up Progress Updates

**Key Insight:** The existing `onProgress` callback from `DiffusionServerManager` should update the registry.

```typescript
class ImageGenerationController {
  private registry: GenerationRegistry;
  private diffusionServer: DiffusionServerManager;

  async startGeneration(config: ImageGenerationConfig): Promise<string> {
    // Create registry entry
    const id = this.registry.create(config);

    // Start generation (don't await - run in background)
    this.runGeneration(id, config).catch((error) => {
      // Update registry with error
      this.registry.update(id, {
        status: 'error',
        error: {
          message: error.message,
          code: this.mapErrorCode(error),
        },
      });
    });

    return id;
  }

  private async runGeneration(id: string, config: ImageGenerationConfig): Promise<void> {
    try {
      // Update status to in_progress
      this.registry.update(id, { status: 'in_progress' });

      // Generate image with progress callback
      const result = await this.diffusionServer.generateImage({
        ...config,
        onProgress: (currentStep, totalSteps, stage, percentage) => {
          // Update registry with progress
          this.registry.update(id, {
            progress: {
              currentStep,
              totalSteps,
              stage,
              percentage,
            },
          });
        },
      });

      // Update registry with result
      this.registry.update(id, {
        status: 'complete',
        result: {
          images: [result],
          format: 'png',
          timeTaken: result.timeTaken,
        },
      });
    } catch (error) {
      // Error handling in outer catch block
      throw error;
    }
  }
}
```

---

### 5.4 HTTP Route Handlers

**POST /v1/images/generations:**

```typescript
app.post('/v1/images/generations', async (req, res) => {
  try {
    // Validate request
    const config = validateImageGenerationConfig(req.body);

    // Check if server is busy
    if (controller.isBusy()) {
      return res.status(503).json({
        error: {
          message: 'Server is busy generating another image',
          code: 'SERVER_BUSY',
          suggestion: 'Wait for current generation to complete and try again',
        },
      });
    }

    // Start generation (returns immediately)
    const id = await controller.startGeneration(config);

    // Return generation ID
    res.status(201).json({
      id,
      status: 'pending',
      createdAt: Date.now(),
    });
  } catch (error) {
    res.status(400).json({
      error: {
        message: error.message,
        code: 'INVALID_REQUEST',
      },
    });
  }
});
```

**GET /v1/images/generations/:id:**

```typescript
app.get('/v1/images/generations/:id', (req, res) => {
  const { id } = req.params;

  // Get state from registry
  const state = registry.get(id);

  if (!state) {
    return res.status(404).json({
      error: {
        message: 'Generation not found',
        code: 'NOT_FOUND',
      },
    });
  }

  // Build response based on status
  const response: any = {
    id: state.id,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };

  if (state.status === 'in_progress' && state.progress) {
    response.progress = state.progress;
  }

  if (state.status === 'complete' && state.result) {
    response.result = state.result;
  }

  if (state.status === 'error' && state.error) {
    response.error = state.error;
  }

  res.json(response);
});
```

---

## 6. State Management

### 6.1 Memory Management

**Problem:** Completed generations stay in memory indefinitely.

**Solution:** Periodic cleanup of old entries.

```typescript
class GenerationRegistry {
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private maxResultAgeMs = 5 * 60 * 1000,  // 5 minutes
    private cleanupIntervalMs = 60 * 1000     // 1 minute
  ) {
    // Start cleanup timer
    this.cleanupInterval = setInterval(() => {
      this.cleanup(this.maxResultAgeMs);
    }, this.cleanupIntervalMs);
  }

  cleanup(maxAgeMs: number): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, state] of this.generations.entries()) {
      // Only clean up terminal states (complete/error)
      if (state.status === 'complete' || state.status === 'error') {
        if (now - state.updatedAt > maxAgeMs) {
          this.generations.delete(id);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} old generation(s)`);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
```

**Configuration:**
- **Default:** Keep results for 5 minutes after completion
- **Configurable:** Via environment variable `IMAGE_RESULT_TTL_MS`

---

### 6.2 Concurrent Generation Handling

**Current Limitation:** Only 1 generation at a time (enforced by `DiffusionServerManager`).

**Implementation:**

```typescript
class ImageGenerationController {
  private currentGenerationId: string | null = null;

  isBusy(): boolean {
    if (!this.currentGenerationId) return false;

    const state = this.registry.get(this.currentGenerationId);
    return state?.status === 'in_progress';
  }

  async startGeneration(config: ImageGenerationConfig): Promise<string> {
    if (this.isBusy()) {
      throw new Error('Server is busy generating another image');
    }

    const id = this.registry.create(config);
    this.currentGenerationId = id;

    this.runGeneration(id, config)
      .finally(() => {
        // Clear current generation when done
        if (this.currentGenerationId === id) {
          this.currentGenerationId = null;
        }
      });

    return id;
  }
}
```

---

## 7. Integration with DiffusionServerManager

### 7.1 No Changes to DiffusionServerManager

**Good news:** The existing `DiffusionServerManager` doesn't need modifications.

The async API is built **on top** of the existing interface:

```typescript
// Existing interface (unchanged)
interface DiffusionServerManager {
  generateImage(config: ImageGenerationConfig): Promise<ImageGenerationResult>;
}

// Your onProgress callback updates the registry
const result = await diffusionServer.generateImage({
  prompt: "...",
  onProgress: (current, total, stage, percentage) => {
    registry.update(generationId, { progress: { ... } });
  },
});
```

### 7.2 Type Updates for ImageGenerationConfig

The `ImageGenerationConfig` type needs to be updated to include the `count` parameter:

```typescript
// Updated interface
interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;           // default: 512
  height?: number;          // default: 512
  steps?: number;           // default: 20
  cfgScale?: number;        // default: 7.5
  seed?: number;            // default: random
  sampler?: string;         // default: "euler_a"
  count?: number;           // NEW: default: 1, max: 5 (see §4.2.1)

  // Progress callback (unchanged)
  onProgress?: (
    currentStep: number,
    totalSteps: number,
    stage: ImageGenerationStage,
    percentage?: number
  ) => void;
}

type ImageGenerationStage = 'loading' | 'diffusion' | 'decoding';

interface ImageGenerationResult {
  image: Buffer;            // PNG bytes
  format: 'png';
  timeTaken: number;        // ms
  seed: number;
  width: number;
  height: number;
}
```

**Note:** When `count` > 1, the `generateImage` method should be called multiple times (sequential loop) and return an array of `ImageGenerationResult` objects (or update the response contract to accommodate multiple images).

### 7.3 Error Mapping

Map `DiffusionServerManager` errors to HTTP error codes:

```typescript
function mapErrorCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes('server is busy')) return 'SERVER_BUSY';
  if (message.includes('not running')) return 'SERVER_NOT_RUNNING';
  if (message.includes('failed to spawn')) return 'BACKEND_ERROR';
  if (message.includes('exited with code')) return 'BACKEND_ERROR';
  if (message.includes('failed to read')) return 'IO_ERROR';

  return 'UNKNOWN_ERROR';
}
```

---

## 8. Error Handling

### 8.1 Error States

Errors can occur at different stages:

1. **Validation errors** (before generation starts) → `400 Bad Request`
2. **Server busy** (concurrent generation attempt) → `503 Service Unavailable`
3. **Generation errors** (during diffusion) → Store in state as `status: 'error'`

### 8.2 Error Response Format

**Consistent format across all endpoints:**

```typescript
interface ErrorResponse {
  error: {
    message: string;
    code: string;
    suggestion?: string;
    details?: any;
  };
}
```

### 8.3 Error Codes

| Code | Meaning | HTTP Status |
|------|---------|-------------|
| `INVALID_REQUEST` | Bad parameters | 400 |
| `NOT_FOUND` | Generation ID not found | 404 |
| `SERVER_BUSY` | Already generating | 503 |
| `SERVER_NOT_RUNNING` | Diffusion server down | 503 |
| `BACKEND_ERROR` | stable-diffusion.cpp failed | Stored in state |
| `IO_ERROR` | File read/write error | Stored in state |
| `TIMEOUT_ERROR` | Generation timeout | Stored in state |
| `UNKNOWN_ERROR` | Unexpected error | Stored in state |

---

## 9. Testing Recommendations

### 9.1 Unit Tests

**Test Coverage:**

1. **GenerationRegistry**
   - Create/get/update/delete operations
   - Cleanup logic (time-based)
   - Memory limits

2. **Generation ID**
   - Uniqueness
   - Format validation

3. **Error mapping**
   - All error types correctly mapped

### 9.2 Integration Tests

**Scenarios:**

1. **Happy path:**
   - POST → 201 with ID
   - GET → 200 with "in_progress" + progress updates
   - GET → 200 with "complete" + result

2. **Server busy:**
   - Start generation
   - Try to start another → 503

3. **Not found:**
   - GET with invalid ID → 404

4. **Generation failure:**
   - Trigger diffusion error
   - GET → 200 with "error" status

5. **Cleanup:**
   - Generate image
   - Wait > TTL
   - GET → 404

### 9.3 Manual Testing

**Polling client:**

```bash
# Start generation
ID=$(curl -X POST http://localhost:8081/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test","width":512,"height":512}' \
  | jq -r '.id')

# Poll for progress
while true; do
  STATUS=$(curl -s http://localhost:8081/v1/images/generations/$ID | jq -r '.status')
  echo "Status: $STATUS"

  if [ "$STATUS" = "complete" ] || [ "$STATUS" = "error" ]; then
    break
  fi

  sleep 1
done

# Get final result
curl -s http://localhost:8081/v1/images/generations/$ID | jq .
```

---

## 10. Migration & Backward Compatibility

### 10.1 Replace Old Endpoint

Replace endpoint entirely. It's a breaking change, but it's fine as we haven't 
released this yet, the only thing to change is the example app, which will have
to migrate to async polling pattern.

---

### 10.2 Client Migration

**Old client code:**
```typescript
const response = await fetch('/v1/images/generations', {
  method: 'POST',
  body: JSON.stringify(config),
});
const result = await response.json();
// result.images available immediately
```

**New client code:**
```typescript
// Start generation
const { id } = await fetch('/v1/images/generations', {
  method: 'POST',
  body: JSON.stringify(config),
}).then(r => r.json());

// Poll until complete
while (true) {
  const state = await fetch(`/v1/images/generations/${id}`).then(r => r.json());

  if (state.status === 'complete') {
    return state.result.images;
  }

  if (state.status === 'error') {
    throw new Error(state.error.message);
  }

  // Show progress
  if (state.progress) {
    console.log(`${state.progress.percentage}%`);
  }

  await sleep(500);
}
```

---

## 11. Example Client Usage

### 11.1 TypeScript Client (genai-lite)

```typescript
class GenaiElectronImageAdapter {
  async generate(config: GenerateConfig): Promise<ImageResult> {
    // Start generation
    const startResponse = await fetch(`${this.baseURL}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config.request),
    });

    if (!startResponse.ok) {
      throw new Error(`Failed to start generation: ${startResponse.statusText}`);
    }

    const { id } = await startResponse.json();

    // Poll for completion
    return await this.pollForResult(id, config.settings.diffusion?.onProgress);
  }

  private async pollForResult(
    id: string,
    onProgress?: ProgressCallback
  ): Promise<ImageResult> {
    const pollInterval = 500; // ms

    while (true) {
      const response = await fetch(`${this.baseURL}/v1/images/generations/${id}`);

      if (!response.ok) {
        throw new Error(`Failed to get generation status: ${response.statusText}`);
      }

      const state = await response.json();

      // Handle progress
      if (state.status === 'in_progress' && state.progress && onProgress) {
        onProgress({
          currentStep: state.progress.currentStep,
          totalSteps: state.progress.totalSteps,
          stage: state.progress.stage,
          percentage: state.progress.percentage,
        });
      }

      // Handle completion
      if (state.status === 'complete') {
        return this.convertToImageResult(state.result);
      }

      // Handle error
      if (state.status === 'error') {
        throw new Error(`Generation failed: ${state.error.message} (${state.error.code})`);
      }

      // Wait before next poll
      await this.sleep(pollInterval);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 11.2 Simple JavaScript Client

```javascript
async function generateImage(prompt) {
  // Start generation
  const startRes = await fetch('http://localhost:8081/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width: 512, height: 512, steps: 20 }),
  });

  const { id } = await startRes.json();
  console.log(`Generation started: ${id}`);

  // Poll for result
  while (true) {
    const statusRes = await fetch(`http://localhost:8081/v1/images/generations/${id}`);
    const state = await statusRes.json();

    console.log(`Status: ${state.status}`);

    if (state.progress) {
      console.log(`Progress: ${state.progress.stage} ${state.progress.percentage}%`);
    }

    if (state.status === 'complete') {
      console.log('Image generated!');
      return state.result.images[0].image; // base64
    }

    if (state.status === 'error') {
      throw new Error(state.error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
```

---

## 12. Open Questions & Configuration

### 12.1 Configuration Options

**Environment Variables:**

```bash
# Result retention time (default: 5 minutes)
IMAGE_RESULT_TTL_MS=300000

# Cleanup interval (default: 1 minute)
IMAGE_CLEANUP_INTERVAL_MS=60000

# Maximum concurrent generations (default: 1, future: support > 1)
IMAGE_MAX_CONCURRENT=1

# Poll interval recommendation for clients (default: 500ms)
IMAGE_POLL_INTERVAL_MS=500
```

### 12.2 Open Questions for genai-electron Team

**Q1:** Should we keep the old blocking endpoint for backward compatibility?
- **Recommendation:** No

**Q2:** What should be the default TTL for completed generations?
- **Recommendation:** 5 minutes (enough for clients to poll, not too wasteful)

**Q3:** Should we add a `/v1/images/generations` GET endpoint to list all?
- **Recommendation:** Not needed for Phase 5, add if requested

**Q4:** Should we expose cleanup configuration?
- **Recommendation:** Yes, via environment variables

**Q5:** How should we handle server restart? (All in-progress jobs lost)
- **Recommendation:** Document as known limitation, persist in Phase 6 if needed

### 12.3 Future Enhancements (Post-Phase 5)

1. **Cancellation (Phase 3):**
   - `DELETE /v1/images/generations/:id`
   - Kill stable-diffusion.cpp process
   - Clean up resources

2. **WebSocket/SSE streaming:**
   - Push progress instead of polling
   - More efficient for long generations

3. **Persistent storage:**
   - Survive server restarts
   - SQLite or Redis backend

4. **Batch generation:**
   - Queue multiple requests
   - Process sequentially or with concurrency > 1

5. **Priority queue:**
   - High-priority generations jump queue

---

## 13. Implementation Checklist

### Phase 5 (Required)

- [ ] Create `GenerationRegistry` class
- [ ] Implement `generateId()` function
- [ ] Add `POST /v1/images/generations` (returns ID immediately)
- [ ] Add `GET /v1/images/generations/:id` (returns status/progress/result)
- [ ] Wire up `onProgress` callback to update registry
- [ ] Implement error mapping
- [ ] **Batch Generation Support (§4.2.1):**
  - [ ] Add `count` parameter to `ImageGenerationConfig` type
  - [ ] Implement sequential generation loop for count > 1
  - [ ] Handle seed generation for multiple images (seed + i)
  - [ ] Update progress tracking for batch generation
  - [ ] Add `currentImage` and `totalImages` fields to progress
  - [ ] Calculate overall percentage for batched images
  - [ ] Add validation for count parameter (>= 1, <= 5)
  - [ ] Test with count=1, count=2, count=3, count=5
  - [ ] Test error handling (failure on image 2/3)
  - [ ] Return array of images in result
- [ ] Add cleanup logic (TTL-based)
- [ ] Handle "server busy" (503) for concurrent requests
- [ ] Update error responses with new codes
- [ ] Write unit tests for registry
- [ ] Write integration tests for endpoints
- [ ] Update API documentation
- [ ] Test with genai-lite polling client

### Phase 3 (Future)

- [ ] Add `DELETE /v1/images/generations/:id` (cancellation)
- [ ] Implement process cleanup on cancel
- [ ] Return `501 Not Implemented` for now

### Optional Enhancements

- [ ] Add `GET /v1/images/generations` (list all)
- [ ] Persist state to disk/database
- [ ] Add WebSocket/SSE streaming
- [ ] Support concurrent generation (queue)

---

## 14. Summary

This document specifies the changes needed in genai-electron to support async image generation with progress polling.

**Key Changes:**
1. New endpoints: POST (start), GET (poll)
2. Generation registry for state tracking
3. Progress updates via existing callback mechanism
4. **Batch generation support:** count parameter for multiple images (§4.2.1)
5. Clean error handling and codes
6. Memory management (TTL cleanup)

**Effort Estimate:**
- Core async API implementation: 4-6 hours
- Batch generation support: 2-3 hours
- Testing: 2-3 hours
- Documentation: 1 hour
- **Total:** 9-13 hours for experienced developer

**Next Steps:**
1. Review this spec with genai-electron team
2. Implement `GenerationRegistry` class
3. Add new endpoints
4. Test with genai-lite client
5. Document API changes in genai-electron README

---

**Document End**
