# Token Truncation Issue: Responses Capped at contextSize/4

**Date:** 2025-10-24
**Status:** Open - Investigation in progress
**Severity:** High - Prevents long-form responses
**Affects:** All models when using genai-electron control panel test chat

---

## Issue Summary

Responses from llama-server are being truncated at approximately contextSize/4 tokens, regardless of the `max_tokens` parameter passed in API requests via genai-lite.

### Observed Pattern

| Model | contextSize | Expected max_tokens | Actual cap | Ratio |
|-------|-------------|---------------------|------------|-------|
| Qwen 3 4B Instruct | 1024 | 800-4096 | ~243-256 | 1024/4 |
| Qwen (smaller) | 2048 | 800-4096 | ~512 | 2048/4 |

**Key observation:** The cap appears to be exactly contextSize/4, suggesting an internal llama-server limit.

---

## Environment

- **genai-electron:** v0.3.0 (Phase 2.6)
- **genai-lite:** v0.5.1
- **llama-server:** Bundled with genai-electron (version unknown - need to check binary)
- **Platform:** Windows (WSL2)
- **Models:** Qwen 3 4B Instruct (Q6_K_XL), other Qwen models

---

## Detailed Behavior

### Test Case

**Setup:**
- Model: Qwen 3 4B Instruct (contextSize: 1024)
- Prompt: "write a long story" (~5 tokens)
- UI Setting: maxTokens = 800 (later tested with 4096)

**Expected:**
- Response of ~800 tokens

**Actual:**
- Response stops at exactly 243-244 tokens
- llama-server logs show: `eval time = 5653.19 ms / 244 tokens`
- Total context used: 256 tokens (13 prompt + 243 completion)

### Behavior with Different max_tokens Values

- **maxTokens: 50** → Generates exactly 50 tokens ✓
- **maxTokens: 100** → Generates exactly 100 tokens ✓
- **maxTokens: 250** → Generates ~243-244 tokens (capped) ✗
- **maxTokens: 800** → Generates ~243-244 tokens (capped) ✗
- **maxTokens: 4096** → Generates ~243-244 tokens (capped) ✗

**Conclusion:** Values ≤ contextSize/4 work correctly. Values > contextSize/4 are capped at contextSize/4.

---

## Investigation

### 1. genai-electron Code Review

**Checked:** `src/managers/LlamaServerManager.ts` - `buildCommandLineArgs()` method

**Findings:**
- No hardcoded token limits in code (no 256, 512, etc.)
- No `-n` (predict) flag was being passed to llama-server
- Context size is calculated conservatively based on available RAM

**Startup Configuration Used:**
```javascript
{
  "modelId": "qwen-3-4b-instruct-2507-q6kxl",
  "port": 8080,
  "threads": 18,
  "contextSize": 1024,
  "gpuLayers": 36,
  "parallelRequests": 8
}
```

**Corresponding llama-server flags:**
```
-m <model_path>
--jinja
--reasoning-format deepseek
--port 8080
--threads 18
-c 1024
-ngl 36
-np 8
```

### 2. genai-lite Debug Logs

**From console output:**

```javascript
// Settings passed to genai-lite
{
  temperature: 0.7,
  maxTokens: 800,  // Correctly set
  topP: 0.95,
  // ... other settings
}

// genai-lite's LlamaCppClientAdapter output
llama.cpp API parameters: {
  baseURL: 'http://localhost:8080',
  model: 'qwen-3-4b-instruct-2507-q6kxl',
  temperature: 0.7,
  max_tokens: 800,  // ✓ Correctly mapped to snake_case
  top_p: 0.95
}

// Response from llama-server
Response usage: {
  prompt_tokens: 13,
  completion_tokens: 243,
  total_tokens: 256  // ✗ Capped at 256 despite max_tokens: 800
}
Finish reason: length  // ✗ Hit limit, didn't finish naturally
Response length: 1066 chars
```

**Conclusion:** genai-lite is working correctly. It:
1. Receives `maxTokens: 800` from the UI
2. Correctly maps it to `max_tokens: 800` for the API request
3. Sends it to llama-server at `http://localhost:8080/v1/chat/completions`

### 3. llama-server Logs

**From server logs:**
```
2025-10-24T10:54:41.608Z
[INFO]
eval time = 5653.19 ms / 244 tokens ( 23.17 ms per token, 43.16 tokens per second)

2025-10-24T10:54:41.608Z
[INFO]
total time = 6032.22 ms / 245 tokens

2025-10-24T10:54:41.608Z
[INFO]
prompt eval time = 379.03 ms / 1 tokens ( 379.03 ms per token, 2.64 tokens per second)

2025-10-24T10:54:41.608Z
[INFO]
srv log_server_r: request: POST /v1/chat/completions 127.0.0.1 200
```

**Findings:**
- llama-server generated exactly 244 tokens
- No error messages
- Request completed successfully (200 OK)
- llama-server respected some limit, but not the `max_tokens: 800` from the request

---

## Attempted Fix #1: Add `-n -1` Flag

### Hypothesis

llama-server might have a default server-wide token limit when no `-n` (--predict) flag is provided. The `-n` flag controls the maximum number of tokens to predict.

According to llama.cpp documentation:
```
-n, --predict, --n-predict N    number of tokens to predict (default: -1, -1 = infinity)
```

### Implementation

**File:** `src/managers/LlamaServerManager.ts:389-391`

```typescript
// Max predict tokens (-1 = unlimited, respect per-request max_tokens from API)
// Without this flag, llama-server caps at contextSize/4 by default
args.push('-n', '-1');
```

**Commit:** 89acf16 - "fix: add -n -1 flag to llama-server to fix token truncation"

### Result

**Status:** ✗ Did not fix the issue

The cap at contextSize/4 persists even with `-n -1` flag added.

---

## Possible Root Causes

### 1. Batch Size Limits

llama-server has two batch-related flags that might be interfering:

```
-b,   --batch-size N      logical maximum batch size (default: 2048)
-ub,  --ubatch-size N     physical maximum batch size (default: 512)
```

**Current behavior:** We don't set these flags, so defaults are used.

**Hypothesis:** The `ubatch-size` default of 512 might be related to the 512-token cap on the larger model. However, this doesn't explain the 256-token cap on the 1024-context model.

**Status:** Unverified

### 2. Parallel Requests Interaction

**Current setting:** `parallelRequests: 8` (maps to `-np 8`)

**Hypothesis:** With 8 parallel slots and contextSize 1024, llama-server might be allocating:
- 1024 / 8 = 128 tokens per slot? (Doesn't match observed 256)
- Or some other per-slot budget calculation

**Status:** Speculative, doesn't match the math

### 3. llama-server Version Bug

**Issue:** We don't know the exact llama-server version being used.

**Hypothesis:** Older versions of llama-server might have a bug where they don't respect the `max_tokens` parameter from API requests, or apply an undocumented limit.

**Next step:** Check llama-server version in startup logs or binary metadata.

### 4. KV Cache Limit

**Theory:** llama-server might be reserving space in the KV cache and limiting completion length accordingly.

**Calculation (speculative):**
- Total context: 1024 tokens
- Reserve for prompt: up to 256 tokens (dynamic)
- Reserve for completion: 256 tokens (fixed?)
- Reserve for multi-turn: 512 tokens (overhead?)

**Status:** Pure speculation, doesn't explain the exact /4 ratio

### 5. Slot Configuration

**From llama.cpp source knowledge:** Each slot gets a portion of the context window when using multiple parallel requests.

**Hypothesis:**
- contextSize 1024 with 8 slots might allocate 128 tokens per slot
- But we observe 256-token cap, which is 2× the per-slot allocation
- Doesn't add up cleanly

**Status:** Math doesn't work out

### 6. Request-Specific Context Limit

**From HTTP API perspective:** llama-server's `/v1/chat/completions` endpoint might be applying a different limit than the server-wide `-n` flag.

**Hypothesis:** The API might have its own max_tokens cap that's separate from the `-n` flag, possibly hardcoded or calculated from context size.

**Status:** Most likely, but mechanism unknown

---

## What We Know For Certain

1. ✓ **genai-electron** correctly starts llama-server with appropriate flags
2. ✓ **genai-lite** correctly receives `maxTokens` from UI
3. ✓ **genai-lite** correctly maps to `max_tokens` in API request
4. ✓ **genai-lite** correctly sends HTTP request to llama-server
5. ✗ **llama-server** ignores `max_tokens` and applies contextSize/4 cap
6. ✗ Adding `-n -1` flag did not fix the issue

---

## Next Steps

### Immediate Testing

1. **Check llama-server version**
   - Look in startup logs for version number
   - Or check binary with `llama-server --version`

2. **Test batch size flags**
   - Add `-b 4096 -ub 4096` to startup args
   - See if this affects the cap

3. **Test with fewer parallel slots**
   - Try `-np 1` (single slot)
   - See if cap changes

4. **Direct curl test**
   - Bypass genai-lite entirely
   - Send raw HTTP request to llama-server:
     ```bash
     curl http://localhost:8080/v1/chat/completions \
       -H "Content-Type: application/json" \
       -d '{
         "messages": [{"role": "user", "content": "write a long story"}],
         "max_tokens": 2000,
         "temperature": 0.7
       }'
     ```
   - This isolates whether the issue is llama-server or genai-lite

5. **Check llama-server /props endpoint**
   - Query `http://localhost:8080/props`
   - See what limits llama-server reports

### Code Investigation

1. **Add startup command logging**
   - Log the exact command used to start llama-server
   - Verify all flags are correct

2. **Check genai-lite source**
   - Review LlamaCppClientAdapter implementation
   - Verify HTTP request format matches llama.cpp API spec

3. **Compare with working llama-server**
   - Test same model with standalone llama-server (not via genai-electron)
   - See if issue persists

### Community Research

1. **Check llama.cpp issues**
   - Search for similar reports: "max_tokens ignored", "contextSize/4", etc.
   - Check recent releases for bug fixes

2. **Test with updated llama-server binary**
   - Download latest llama.cpp release
   - See if newer version fixes the issue

---

## Workarounds

### For Users (Current)

**None available.** The cap is hardcoded at the llama-server level.

Increasing `contextSize` increases the cap proportionally, but:
- Uses more RAM
- Doesn't solve root cause
- Still caps at contextSize/4

### For Development

**Option 1:** Increase contextSize in auto-configuration
- Multiply recommended contextSize by 4
- E.g., if we recommend 1024, use 4096 instead
- Downside: Wastes 3/4 of context window

**Option 2:** Bypass llama-server for long responses
- Use streaming mode
- Make multiple requests
- Concatenate responses
- Downside: Complex, breaks conversation context

**Option 3:** Switch to different inference backend
- Use llama.cpp's main binary directly
- Use llama-cpp-python
- Downside: Major architecture change

---

## Related Files

- `src/managers/LlamaServerManager.ts` - Server startup and configuration
- `examples/electron-control-panel/main/ipc-handlers.ts` - Test chat implementation
- `src/system/SystemInfo.ts` - contextSize calculation
- `docs/dev/2025-10-24_port-conflict-genai-electron-chat-demo.md` - Related debugging session

---

## References

- llama.cpp server arguments: https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md
- llama.cpp API spec: https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md#api-endpoints
- genai-lite LlamaCppClientAdapter: (source location TBD)

---

## Update Log

- **2025-10-24 (Initial):** Issue discovered and documented
- **2025-10-24 (Attempted Fix):** Added `-n -1` flag - did not resolve issue
