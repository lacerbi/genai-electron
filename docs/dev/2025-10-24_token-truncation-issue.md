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

---

## `llama-server` Controls

```
> llama-server.exe -h

ggml_cuda_init: GGML_CUDA_FORCE_MMQ:    no
ggml_cuda_init: GGML_CUDA_FORCE_CUBLAS: no
ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA GeForce RTX 4060 Laptop GPU, compute capability 8.9, VMM: yes
load_backend: loaded CUDA backend from C:\Users\luigi\AppData\Roaming\electron-control-panel\binaries\llama\ggml-cuda.dll
load_backend: loaded RPC backend from C:\Users\luigi\AppData\Roaming\electron-control-panel\binaries\llama\ggml-rpc.dll
load_backend: loaded CPU backend from C:\Users\luigi\AppData\Roaming\electron-control-panel\binaries\llama\ggml-cpu-alderlake.dll
----- common params -----

-h,    --help, --usage                  print usage and exit
--version                               show version and build info
--completion-bash                       print source-able bash completion script for llama.cpp
--verbose-prompt                        print a verbose prompt before generation (default: false)
-t,    --threads N                      number of CPU threads to use during generation (default: -1)
                                        (env: LLAMA_ARG_THREADS)
-tb,   --threads-batch N                number of threads to use during batch and prompt processing (default:
                                        same as --threads)
-C,    --cpu-mask M                     CPU affinity mask: arbitrarily long hex. Complements cpu-range
                                        (default: "")
-Cr,   --cpu-range lo-hi                range of CPUs for affinity. Complements --cpu-mask
--cpu-strict <0|1>                      use strict CPU placement (default: 0)
--prio N                                set process/thread priority : low(-1), normal(0), medium(1), high(2),
                                        realtime(3) (default: 0)
--poll <0...100>                        use polling level to wait for work (0 - no polling, default: 50)
-Cb,   --cpu-mask-batch M               CPU affinity mask: arbitrarily long hex. Complements cpu-range-batch
                                        (default: same as --cpu-mask)
-Crb,  --cpu-range-batch lo-hi          ranges of CPUs for affinity. Complements --cpu-mask-batch
--cpu-strict-batch <0|1>                use strict CPU placement (default: same as --cpu-strict)
--prio-batch N                          set process/thread priority : 0-normal, 1-medium, 2-high, 3-realtime
                                        (default: 0)
--poll-batch <0|1>                      use polling to wait for work (default: same as --poll)
-c,    --ctx-size N                     size of the prompt context (default: 4096, 0 = loaded from model)
                                        (env: LLAMA_ARG_CTX_SIZE)
-n,    --predict, --n-predict N         number of tokens to predict (default: -1, -1 = infinity)
                                        (env: LLAMA_ARG_N_PREDICT)
-b,    --batch-size N                   logical maximum batch size (default: 2048)
                                        (env: LLAMA_ARG_BATCH)
-ub,   --ubatch-size N                  physical maximum batch size (default: 512)
                                        (env: LLAMA_ARG_UBATCH)
--keep N                                number of tokens to keep from the initial prompt (default: 0, -1 =
                                        all)
--swa-full                              use full-size SWA cache (default: false)
                                        [(more
                                        info)](https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055)
                                        (env: LLAMA_ARG_SWA_FULL)
--kv-unified, -kvu                      use single unified KV buffer for the KV cache of all sequences
                                        (default: false)
                                        [(more info)](https://github.com/ggml-org/llama.cpp/pull/14363)
                                        (env: LLAMA_ARG_KV_SPLIT)
-fa,   --flash-attn [on|off|auto]       set Flash Attention use ('on', 'off', or 'auto', default: 'auto')
                                        (env: LLAMA_ARG_FLASH_ATTN)
--no-perf                               disable internal libllama performance timings (default: false)
                                        (env: LLAMA_ARG_NO_PERF)
-e,    --escape                         process escapes sequences (\n, \r, \t, \', \", \\) (default: true)
--no-escape                             do not process escape sequences
--rope-scaling {none,linear,yarn}       RoPE frequency scaling method, defaults to linear unless specified by
                                        the model
                                        (env: LLAMA_ARG_ROPE_SCALING_TYPE)
--rope-scale N                          RoPE context scaling factor, expands context by a factor of N
                                        (env: LLAMA_ARG_ROPE_SCALE)
--rope-freq-base N                      RoPE base frequency, used by NTK-aware scaling (default: loaded from
                                        model)
                                        (env: LLAMA_ARG_ROPE_FREQ_BASE)
--rope-freq-scale N                     RoPE frequency scaling factor, expands context by a factor of 1/N
                                        (env: LLAMA_ARG_ROPE_FREQ_SCALE)
--yarn-orig-ctx N                       YaRN: original context size of model (default: 0 = model training
                                        context size)
                                        (env: LLAMA_ARG_YARN_ORIG_CTX)
--yarn-ext-factor N                     YaRN: extrapolation mix factor (default: -1.0, 0.0 = full
                                        interpolation)
                                        (env: LLAMA_ARG_YARN_EXT_FACTOR)
--yarn-attn-factor N                    YaRN: scale sqrt(t) or attention magnitude (default: -1.0)
                                        (env: LLAMA_ARG_YARN_ATTN_FACTOR)
--yarn-beta-slow N                      YaRN: high correction dim or alpha (default: -1.0)
                                        (env: LLAMA_ARG_YARN_BETA_SLOW)
--yarn-beta-fast N                      YaRN: low correction dim or beta (default: -1.0)
                                        (env: LLAMA_ARG_YARN_BETA_FAST)
-nkvo, --no-kv-offload                  disable KV offload
                                        (env: LLAMA_ARG_NO_KV_OFFLOAD)
-nr,   --no-repack                      disable weight repacking
                                        (env: LLAMA_ARG_NO_REPACK)
--no-host                               bypass host buffer allowing extra buffers to be used
                                        (env: LLAMA_ARG_NO_HOST)
-ctk,  --cache-type-k TYPE              KV cache data type for K
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_K)
-ctv,  --cache-type-v TYPE              KV cache data type for V
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_V)
-dt,   --defrag-thold N                 KV cache defragmentation threshold (DEPRECATED)
                                        (env: LLAMA_ARG_DEFRAG_THOLD)
-np,   --parallel N                     number of parallel sequences to decode (default: 1)
                                        (env: LLAMA_ARG_N_PARALLEL)
--rpc SERVERS                           comma separated list of RPC servers
                                        (env: LLAMA_ARG_RPC)
--mlock                                 force system to keep model in RAM rather than swapping or compressing
                                        (env: LLAMA_ARG_MLOCK)
--no-mmap                               do not memory-map model (slower load but may reduce pageouts if not
                                        using mlock)
                                        (env: LLAMA_ARG_NO_MMAP)
--numa TYPE                             attempt optimizations that help on some NUMA systems
                                        - distribute: spread execution evenly over all nodes
                                        - isolate: only spawn threads on CPUs on the node that execution
                                        started on
                                        - numactl: use the CPU map provided by numactl
                                        if run without this previously, it is recommended to drop the system
                                        page cache before using this
                                        see https://github.com/ggml-org/llama.cpp/issues/1437
                                        (env: LLAMA_ARG_NUMA)
-dev,  --device <dev1,dev2,..>          comma-separated list of devices to use for offloading (none = don't
                                        offload)
                                        use --list-devices to see a list of available devices
                                        (env: LLAMA_ARG_DEVICE)
--list-devices                          print list of available devices and exit
--override-tensor, -ot <tensor name pattern>=<buffer type>,...
                                        override tensor buffer type
--cpu-moe, -cmoe                        keep all Mixture of Experts (MoE) weights in the CPU
                                        (env: LLAMA_ARG_CPU_MOE)
--n-cpu-moe, -ncmoe N                   keep the Mixture of Experts (MoE) weights of the first N layers in the
                                        CPU
                                        (env: LLAMA_ARG_N_CPU_MOE)
-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM (default: -1)
                                        (env: LLAMA_ARG_N_GPU_LAYERS)
-sm,   --split-mode {none,layer,row}    how to split the model across multiple GPUs, one of:
                                        - none: use one GPU only
                                        - layer (default): split layers and KV across GPUs
                                        - row: split rows across GPUs
                                        (env: LLAMA_ARG_SPLIT_MODE)
-ts,   --tensor-split N0,N1,N2,...      fraction of the model to offload to each GPU, comma-separated list of
                                        proportions, e.g. 3,1
                                        (env: LLAMA_ARG_TENSOR_SPLIT)
-mg,   --main-gpu INDEX                 the GPU to use for the model (with split-mode = none), or for
                                        intermediate results and KV (with split-mode = row) (default: 0)
                                        (env: LLAMA_ARG_MAIN_GPU)
--check-tensors                         check model tensor data for invalid values (default: false)
--override-kv KEY=TYPE:VALUE            advanced option to override model metadata by key. may be specified
                                        multiple times.
                                        types: int, float, bool, str. example: --override-kv
                                        tokenizer.ggml.add_bos_token=bool:false
--no-op-offload                         disable offloading host tensor operations to device (default: false)
--lora FNAME                            path to LoRA adapter (can be repeated to use multiple adapters)
--lora-scaled FNAME SCALE               path to LoRA adapter with user defined scaling (can be repeated to use
                                        multiple adapters)
--control-vector FNAME                  add a control vector
                                        note: this argument can be repeated to add multiple control vectors
--control-vector-scaled FNAME SCALE     add a control vector with user defined scaling SCALE
                                        note: this argument can be repeated to add multiple scaled control
                                        vectors
--control-vector-layer-range START END
                                        layer range to apply the control vector(s) to, start and end inclusive
-m,    --model FNAME                    model path (default: `models/$filename` with filename from `--hf-file`
                                        or `--model-url` if set, otherwise models/7B/ggml-model-f16.gguf)
                                        (env: LLAMA_ARG_MODEL)
-mu,   --model-url MODEL_URL            model download url (default: unused)
                                        (env: LLAMA_ARG_MODEL_URL)
-dr,   --docker-repo [<repo>/]<model>[:quant]
                                        Docker Hub model repository. repo is optional, default to ai/. quant
                                        is optional, default to :latest.
                                        example: gemma3
                                        (default: unused)
                                        (env: LLAMA_ARG_DOCKER_REPO)
-hf,   -hfr, --hf-repo <user>/<model>[:quant]
                                        Hugging Face model repository; quant is optional, case-insensitive,
                                        default to Q4_K_M, or falls back to the first file in the repo if
                                        Q4_K_M doesn't exist.
                                        mmproj is also downloaded automatically if available. to disable, add
                                        --no-mmproj
                                        example: unsloth/phi-4-GGUF:q4_k_m
                                        (default: unused)
                                        (env: LLAMA_ARG_HF_REPO)
-hfd,  -hfrd, --hf-repo-draft <user>/<model>[:quant]
                                        Same as --hf-repo, but for the draft model (default: unused)
                                        (env: LLAMA_ARG_HFD_REPO)
-hff,  --hf-file FILE                   Hugging Face model file. If specified, it will override the quant in
                                        --hf-repo (default: unused)
                                        (env: LLAMA_ARG_HF_FILE)
-hfv,  -hfrv, --hf-repo-v <user>/<model>[:quant]
                                        Hugging Face model repository for the vocoder model (default: unused)
                                        (env: LLAMA_ARG_HF_REPO_V)
-hffv, --hf-file-v FILE                 Hugging Face model file for the vocoder model (default: unused)
                                        (env: LLAMA_ARG_HF_FILE_V)
-hft,  --hf-token TOKEN                 Hugging Face access token (default: value from HF_TOKEN environment
                                        variable)
                                        (env: HF_TOKEN)
--log-disable                           Log disable
--log-file FNAME                        Log to file
--log-colors [on|off|auto]              Set colored logging ('on', 'off', or 'auto', default: 'auto')
                                        'auto' enables colors when output is to a terminal
                                        (env: LLAMA_LOG_COLORS)
-v,    --verbose, --log-verbose         Set verbosity level to infinity (i.e. log all messages, useful for
                                        debugging)
--offline                               Offline mode: forces use of cache, prevents network access
                                        (env: LLAMA_OFFLINE)
-lv,   --verbosity, --log-verbosity N   Set the verbosity threshold. Messages with a higher verbosity will be
                                        ignored.
                                        (env: LLAMA_LOG_VERBOSITY)
--log-prefix                            Enable prefix in log messages
                                        (env: LLAMA_LOG_PREFIX)
--log-timestamps                        Enable timestamps in log messages
                                        (env: LLAMA_LOG_TIMESTAMPS)
-ctkd, --cache-type-k-draft TYPE        KV cache data type for K for the draft model
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_K_DRAFT)
-ctvd, --cache-type-v-draft TYPE        KV cache data type for V for the draft model
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_V_DRAFT)


----- sampling params -----

--samplers SAMPLERS                     samplers that will be used for generation in the order, separated by
                                        ';'
                                        (default:
                                        penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature)
-s,    --seed SEED                      RNG seed (default: -1, use random seed for -1)
--sampling-seq, --sampler-seq SEQUENCE
                                        simplified sequence for samplers that will be used (default:
                                        edskypmxt)
--ignore-eos                            ignore end of stream token and continue generating (implies
                                        --logit-bias EOS-inf)
--temp N                                temperature (default: 0.8)
--top-k N                               top-k sampling (default: 40, 0 = disabled)
--top-p N                               top-p sampling (default: 0.9, 1.0 = disabled)
--min-p N                               min-p sampling (default: 0.1, 0.0 = disabled)
--top-nsigma N                          top-n-sigma sampling (default: -1.0, -1.0 = disabled)
--xtc-probability N                     xtc probability (default: 0.0, 0.0 = disabled)
--xtc-threshold N                       xtc threshold (default: 0.1, 1.0 = disabled)
--typical N                             locally typical sampling, parameter p (default: 1.0, 1.0 = disabled)
--repeat-last-n N                       last n tokens to consider for penalize (default: 64, 0 = disabled, -1
                                        = ctx_size)
--repeat-penalty N                      penalize repeat sequence of tokens (default: 1.0, 1.0 = disabled)
--presence-penalty N                    repeat alpha presence penalty (default: 0.0, 0.0 = disabled)
--frequency-penalty N                   repeat alpha frequency penalty (default: 0.0, 0.0 = disabled)
--dry-multiplier N                      set DRY sampling multiplier (default: 0.0, 0.0 = disabled)
--dry-base N                            set DRY sampling base value (default: 1.75)
--dry-allowed-length N                  set allowed length for DRY sampling (default: 2)
--dry-penalty-last-n N                  set DRY penalty for the last n tokens (default: -1, 0 = disable, -1 =
                                        context size)
--dry-sequence-breaker STRING           add sequence breaker for DRY sampling, clearing out default breakers
                                        ('\n', ':', '"', '*') in the process; use "none" to not use any
                                        sequence breakers
--dynatemp-range N                      dynamic temperature range (default: 0.0, 0.0 = disabled)
--dynatemp-exp N                        dynamic temperature exponent (default: 1.0)
--mirostat N                            use Mirostat sampling.
                                        Top K, Nucleus and Locally Typical samplers are ignored if used.
                                        (default: 0, 0 = disabled, 1 = Mirostat, 2 = Mirostat 2.0)
--mirostat-lr N                         Mirostat learning rate, parameter eta (default: 0.1)
--mirostat-ent N                        Mirostat target entropy, parameter tau (default: 5.0)
-l,    --logit-bias TOKEN_ID(+/-)BIAS   modifies the likelihood of token appearing in the completion,
                                        i.e. `--logit-bias 15043+1` to increase likelihood of token ' Hello',
                                        or `--logit-bias 15043-1` to decrease likelihood of token ' Hello'
--grammar GRAMMAR                       BNF-like grammar to constrain generations (see samples in grammars/
                                        dir) (default: '')
--grammar-file FNAME                    file to read grammar from
-j,    --json-schema SCHEMA             JSON schema to constrain generations (https://json-schema.org/), e.g.
                                        `{}` for any JSON object
                                        For schemas w/ external $refs, use --grammar +
                                        example/json_schema_to_grammar.py instead
-jf,   --json-schema-file FILE          File containing a JSON schema to constrain generations
                                        (https://json-schema.org/), e.g. `{}` for any JSON object
                                        For schemas w/ external $refs, use --grammar +
                                        example/json_schema_to_grammar.py instead


----- example-specific params -----

--ctx-checkpoints, --swa-checkpoints N
                                        max number of context checkpoints to create per slot (default: 8)
                                        [(more info)](https://github.com/ggml-org/llama.cpp/pull/15293)
                                        (env: LLAMA_ARG_CTX_CHECKPOINTS)
--cache-ram, -cram N                    set the maximum cache size in MiB (default: 8192, -1 - no limit, 0 -
                                        disable)
                                        [(more info)](https://github.com/ggml-org/llama.cpp/pull/16391)
                                        (env: LLAMA_ARG_CACHE_RAM)
--no-context-shift                      disables context shift on infinite text generation (default: enabled)
                                        (env: LLAMA_ARG_NO_CONTEXT_SHIFT)
--context-shift                         enables context shift on infinite text generation (default: disabled)
                                        (env: LLAMA_ARG_CONTEXT_SHIFT)
-r,    --reverse-prompt PROMPT          halt generation at PROMPT, return control in interactive mode
-sp,   --special                        special tokens output enabled (default: false)
--no-warmup                             skip warming up the model with an empty run
--spm-infill                            use Suffix/Prefix/Middle pattern for infill (instead of
                                        Prefix/Suffix/Middle) as some models prefer this. (default: disabled)
--pooling {none,mean,cls,last,rank}     pooling type for embeddings, use model default if unspecified
                                        (env: LLAMA_ARG_POOLING)
-cb,   --cont-batching                  enable continuous batching (a.k.a dynamic batching) (default: enabled)
                                        (env: LLAMA_ARG_CONT_BATCHING)
-nocb, --no-cont-batching               disable continuous batching
                                        (env: LLAMA_ARG_NO_CONT_BATCHING)
--mmproj FILE                           path to a multimodal projector file. see tools/mtmd/README.md
                                        note: if -hf is used, this argument can be omitted
                                        (env: LLAMA_ARG_MMPROJ)
--mmproj-url URL                        URL to a multimodal projector file. see tools/mtmd/README.md
                                        (env: LLAMA_ARG_MMPROJ_URL)
--no-mmproj                             explicitly disable multimodal projector, useful when using -hf
                                        (env: LLAMA_ARG_NO_MMPROJ)
--no-mmproj-offload                     do not offload multimodal projector to GPU
                                        (env: LLAMA_ARG_NO_MMPROJ_OFFLOAD)
--override-tensor-draft, -otd <tensor name pattern>=<buffer type>,...
                                        override tensor buffer type for draft model
--cpu-moe-draft, -cmoed                 keep all Mixture of Experts (MoE) weights in the CPU for the draft
                                        model
                                        (env: LLAMA_ARG_CPU_MOE_DRAFT)
--n-cpu-moe-draft, -ncmoed N            keep the Mixture of Experts (MoE) weights of the first N layers in the
                                        CPU for the draft model
                                        (env: LLAMA_ARG_N_CPU_MOE_DRAFT)
-a,    --alias STRING                   set alias for model name (to be used by REST API)
                                        (env: LLAMA_ARG_ALIAS)
--host HOST                             ip address to listen, or bind to an UNIX socket if the address ends
                                        with .sock (default: 127.0.0.1)
                                        (env: LLAMA_ARG_HOST)
--port PORT                             port to listen (default: 8080)
                                        (env: LLAMA_ARG_PORT)
--path PATH                             path to serve static files from (default: )
                                        (env: LLAMA_ARG_STATIC_PATH)
--api-prefix PREFIX                     prefix path the server serves from, without the trailing slash
                                        (default: )
                                        (env: LLAMA_ARG_API_PREFIX)
--no-webui                              Disable the Web UI (default: enabled)
                                        (env: LLAMA_ARG_NO_WEBUI)
--embedding, --embeddings               restrict to only support embedding use case; use only with dedicated
                                        embedding models (default: disabled)
                                        (env: LLAMA_ARG_EMBEDDINGS)
--reranking, --rerank                   enable reranking endpoint on server (default: disabled)
                                        (env: LLAMA_ARG_RERANKING)
--api-key KEY                           API key to use for authentication (default: none)
                                        (env: LLAMA_API_KEY)
--api-key-file FNAME                    path to file containing API keys (default: none)
--ssl-key-file FNAME                    path to file a PEM-encoded SSL private key
                                        (env: LLAMA_ARG_SSL_KEY_FILE)
--ssl-cert-file FNAME                   path to file a PEM-encoded SSL certificate
                                        (env: LLAMA_ARG_SSL_CERT_FILE)
--chat-template-kwargs STRING           sets additional params for the json template parser
                                        (env: LLAMA_CHAT_TEMPLATE_KWARGS)
-to,   --timeout N                      server read/write timeout in seconds (default: 600)
                                        (env: LLAMA_ARG_TIMEOUT)
--threads-http N                        number of threads used to process HTTP requests (default: -1)
                                        (env: LLAMA_ARG_THREADS_HTTP)
--cache-reuse N                         min chunk size to attempt reusing from the cache via KV shifting
                                        (default: 0)
                                        [(card)](https://ggml.ai/f0.png)
                                        (env: LLAMA_ARG_CACHE_REUSE)
--metrics                               enable prometheus compatible metrics endpoint (default: disabled)
                                        (env: LLAMA_ARG_ENDPOINT_METRICS)
--props                                 enable changing global properties via POST /props (default: disabled)
                                        (env: LLAMA_ARG_ENDPOINT_PROPS)
--slots                                 enable slots monitoring endpoint (default: enabled)
                                        (env: LLAMA_ARG_ENDPOINT_SLOTS)
--no-slots                              disables slots monitoring endpoint
                                        (env: LLAMA_ARG_NO_ENDPOINT_SLOTS)
--slot-save-path PATH                   path to save slot kv cache (default: disabled)
--jinja                                 use jinja template for chat (default: disabled)
                                        (env: LLAMA_ARG_JINJA)
--reasoning-format FORMAT               controls whether thought tags are allowed and/or extracted from the
                                        response, and in which format they're returned; one of:
                                        - none: leaves thoughts unparsed in `message.content`
                                        - deepseek: puts thoughts in `message.reasoning_content`
                                        - deepseek-legacy: keeps `<think>` tags in `message.content` while
                                        also populating `message.reasoning_content`
                                        (default: auto)
                                        (env: LLAMA_ARG_THINK)
--reasoning-budget N                    controls the amount of thinking allowed; currently only one of: -1 for
                                        unrestricted thinking budget, or 0 to disable thinking (default: -1)
                                        (env: LLAMA_ARG_THINK_BUDGET)
--chat-template JINJA_TEMPLATE          set custom jinja chat template (default: template taken from model's
                                        metadata)
                                        if suffix/prefix are specified, template will be disabled
                                        only commonly used templates are accepted (unless --jinja is set
                                        before this flag):
                                        list of built-in templates:
                                        bailing, chatglm3, chatglm4, chatml, command-r, deepseek, deepseek2,
                                        deepseek3, exaone3, exaone4, falcon3, gemma, gigachat, glmedge,
                                        gpt-oss, granite, grok-2, hunyuan-dense, hunyuan-moe, kimi-k2, llama2,
                                        llama2-sys, llama2-sys-bos, llama2-sys-strip, llama3, llama4, megrez,
                                        minicpm, mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7,
                                        mistral-v7-tekken, monarch, openchat, orion, phi3, phi4, rwkv-world,
                                        seed_oss, smolvlm, vicuna, vicuna-orca, yandex, zephyr
                                        (env: LLAMA_ARG_CHAT_TEMPLATE)
--chat-template-file JINJA_TEMPLATE_FILE
                                        set custom jinja chat template file (default: template taken from
                                        model's metadata)
                                        if suffix/prefix are specified, template will be disabled
                                        only commonly used templates are accepted (unless --jinja is set
                                        before this flag):
                                        list of built-in templates:
                                        bailing, chatglm3, chatglm4, chatml, command-r, deepseek, deepseek2,
                                        deepseek3, exaone3, exaone4, falcon3, gemma, gigachat, glmedge,
                                        gpt-oss, granite, grok-2, hunyuan-dense, hunyuan-moe, kimi-k2, llama2,
                                        llama2-sys, llama2-sys-bos, llama2-sys-strip, llama3, llama4, megrez,
                                        minicpm, mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7,
                                        mistral-v7-tekken, monarch, openchat, orion, phi3, phi4, rwkv-world,
                                        seed_oss, smolvlm, vicuna, vicuna-orca, yandex, zephyr
                                        (env: LLAMA_ARG_CHAT_TEMPLATE_FILE)
--no-prefill-assistant                  whether to prefill the assistant's response if the last message is an
                                        assistant message (default: prefill enabled)
                                        when this flag is set, if the last message is an assistant message
                                        then it will be treated as a full message and not prefilled

                                        (env: LLAMA_ARG_NO_PREFILL_ASSISTANT)
-sps,  --slot-prompt-similarity SIMILARITY
                                        how much the prompt of a request must match the prompt of a slot in
                                        order to use that slot (default: 0.10, 0.0 = disabled)
--lora-init-without-apply               load LoRA adapters without applying them (apply later via POST
                                        /lora-adapters) (default: disabled)
-td,   --threads-draft N                number of threads to use during generation (default: same as
                                        --threads)
-tbd,  --threads-batch-draft N          number of threads to use during batch and prompt processing (default:
                                        same as --threads-draft)
--draft-max, --draft, --draft-n N       number of tokens to draft for speculative decoding (default: 16)
                                        (env: LLAMA_ARG_DRAFT_MAX)
--draft-min, --draft-n-min N            minimum number of draft tokens to use for speculative decoding
                                        (default: 0)
                                        (env: LLAMA_ARG_DRAFT_MIN)
--draft-p-min P                         minimum speculative decoding probability (greedy) (default: 0.8)
                                        (env: LLAMA_ARG_DRAFT_P_MIN)
-cd,   --ctx-size-draft N               size of the prompt context for the draft model (default: 0, 0 = loaded
                                        from model)
                                        (env: LLAMA_ARG_CTX_SIZE_DRAFT)
-devd, --device-draft <dev1,dev2,..>    comma-separated list of devices to use for offloading the draft model
                                        (none = don't offload)
                                        use --list-devices to see a list of available devices
-ngld, --gpu-layers-draft, --n-gpu-layers-draft N
                                        number of layers to store in VRAM for the draft model
                                        (env: LLAMA_ARG_N_GPU_LAYERS_DRAFT)
-md,   --model-draft FNAME              draft model for speculative decoding (default: unused)
                                        (env: LLAMA_ARG_MODEL_DRAFT)
--spec-replace TARGET DRAFT             translate the string in TARGET into DRAFT if the draft model and main
                                        model are not compatible
-mv,   --model-vocoder FNAME            vocoder model for audio generation (default: unused)
--tts-use-guide-tokens                  Use guide tokens to improve TTS word recall
--embd-gemma-default                    use default EmbeddingGemma model (note: can download weights from the
                                        internet)
--fim-qwen-1.5b-default                 use default Qwen 2.5 Coder 1.5B (note: can download weights from the
                                        internet)
--fim-qwen-3b-default                   use default Qwen 2.5 Coder 3B (note: can download weights from the
                                        internet)
--fim-qwen-7b-default                   use default Qwen 2.5 Coder 7B (note: can download weights from the
                                        internet)
--fim-qwen-7b-spec                      use Qwen 2.5 Coder 7B + 0.5B draft for speculative decoding (note: can
                                        download weights from the internet)
--fim-qwen-14b-spec                     use Qwen 2.5 Coder 14B + 0.5B draft for speculative decoding (note:
                                        can download weights from the internet)
--fim-qwen-30b-default                  use default Qwen 3 Coder 30B A3B Instruct (note: can download weights
                                        from the internet)
--gpt-oss-20b-default                   use gpt-oss-20b (note: can download weights from the internet)
--gpt-oss-120b-default                  use gpt-oss-120b (note: can download weights from the internet)
--vision-gemma-4b-default               use Gemma 3 4B QAT (note: can download weights from the internet)
--vision-gemma-12b-default              use Gemma 3 12B QAT (note: can download weights from the internet)
```

---

## References

- llama.cpp server arguments: https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md
- llama.cpp API spec: https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md#api-endpoints
- genai-lite LlamaCppClientAdapter: (source location TBD)

---

## Update Log

- **2025-10-24 (Initial):** Issue discovered and documented
- **2025-10-24 (Attempted Fix):** Added `-n -1` flag - did not resolve issue
