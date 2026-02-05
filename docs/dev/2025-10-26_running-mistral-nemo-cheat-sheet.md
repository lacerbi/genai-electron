# Running **Mistral-NeMo-12B** (Q4 GGUF) on **8 GB** with **llama.cpp** — Context & KV-cache Cheat-Sheet

## TL;DR

* With a ~**6.74 GiB** 4-bit model already in VRAM, you can comfortably hit **~4k prompt + ~1k output** on **8 GB** using **quantized KV cache** (Q8 or Q4).
* Rough KV cost for NeMo-12B (40L, head_dim=128, **8 KV heads/GQA**):
  **FP16/BF16:** ~**156.25 MiB / 1k tokens** → **~160 KiB/token**.
  **Q8:** ~**78.1 MiB / 1k**. **Q4:** ~**39.1 MiB / 1k**. ([NVIDIA Developer][1])
* On 8 GB with ~**1.26 GiB** free after weights, leaving ~**0.5 GiB** headroom for workspaces:
  **≈5k tokens (FP16)**, **≈10k (Q8)**, **≈19–20k (Q4)**. (All figures are total prompt+generated.) ([NVIDIA Developer][1])

---

## Model facts (what we’re sizing)

* **Mistral-NeMo-12B** architecture: **40 layers**, **32 attn heads**, **8 KV heads (GQA)**, **head_dim=128**. These directly drive KV-cache size. ([Hugging Face][2])

---

## KV-cache math (why the numbers look “small”)

**Per-token KV bytes** (general):
`2 (K&V) × num_layers × (heads × head_dim) × bytes/elt`
For **GQA**, replace `(heads)` with **`num_key_value_heads`** (KV heads ≪ Q heads → smaller cache). ([NVIDIA Developer][1])

For **NeMo-12B** with GQA (40L, **8 KV heads**, 128 dim):
`2 × 40 × 8 × 128 × bytes/elt` →

* **FP16/BF16 (2 B)** → **163,840 B/token ≈ 160 KiB/token** → **156.25 MiB / 1k**
* **Q8 (1 B)** → **~78.1 MiB / 1k**
* **Q4 (~0.5 B)** → **~39.1 MiB / 1k**. ([NVIDIA Developer][1])

---

## llama.cpp settings that matter (and why)

* **KV quantization (huge VRAM saver)**
  Use **both** sides:
  `-ctk q8_0 -ctv q8_0`  (or `q4_0` for more headroom).
  Allowed values include `f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1`. ([Debian Manpages][3])

* **Context length**
  `-c <tokens>` sets the maximum context (KV is allocated roughly proportionally). ([Debian Manpages][3])

* **Micro-batching (VRAM during prefill / multi-req decode)**
  `-ub, --ubatch-size` controls the **physical** micro-batch; smaller lowers peak VRAM (does **not** change max context/KV size). Default is **512**. ([Debian Manpages][3])

* **FlashAttention**
  `-fa, --flash-attn` reduces transient memory/time, especially on long prompts. ([Debian Manpages][3])

* **KV offload (fallback when VRAM is tight)**
  `--no-kv-offload` keeps KV **on CPU** (more context, slower). ([Debian Manpages][3])

* **Unified KV buffer (helps fragmentation in multi-sequence modes)**
  `--kv-unified` / `-kvu` uses a single KV buffer across sequences. ([Debian Manpages][4])

---

## Suggested launch lines (8 GB GPU, Q4 model ~6.74 GiB)

**Balanced quality / safe headroom (Q8 KV):**

```bash
./server -m /path/model.gguf -ngl all \
  -ctk q8_0 -ctv q8_0 \
  -c 6144 -n 1024 -ub 256 -fa
```

**Max context on 8 GB (Q4 KV):**

```bash
./server -m /path/model.gguf -ngl all \
  -ctk q4_0 -ctv q4_0 \
  -c 8192 -n 1024 -ub 192 -fa
```

(Flags and defaults from the current `llama-server` manpage; adjust `-c` upward until you approach VRAM limits.) ([Debian Manpages][3])

---

## Practical guidance & gotchas

* **Your 4k + ~1k target** is well within reach on 8 GB with **Q8 KV** (≈0.39 GiB for 5k tokens) and trivial with **Q4 KV** (≈0.20 GiB). Keep **`-ub` ~192–256** to avoid prefill OOM on long prompts. ([Debian Manpages][3])
* **Concurrency increases KV linearly** per live sequence; cap with `--parallel` or ensure headroom. ([Debian Manpages][3])
* If you still OOM during prefill, **lower `-ub`** or **drop a few GPU layers** (`-ngl`) to free ~tens of MiB per layer for KV; throughput will dip. ([Debian Manpages][3])

---

## Sources

* **NeMo-12B model card** (40L, 32 heads, **8 KV heads**, head_dim=128). ([Hugging Face][2])
* **KV-cache size formula** and memory contributors (weights + KV). ([NVIDIA Developer][1])
* **GQA / `num_key_value_heads`** (why KV heads < attn heads). ([Hugging Face][5])
* **llama.cpp flags & defaults**: `-c`, `-b`, `-ub`, `-fa`, `-ctk/-ctv`, `--no-kv-offload`, `--parallel`. ([Debian Manpages][3])
* **Unified KV buffer option**. ([Debian Manpages][4])

---

[1]: https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/ "Mastering LLM Techniques: Inference Optimization | NVIDIA Technical Blog"
[2]: https://huggingface.co/nvidia/Mistral-NeMo-12B-Base?utm_source=chatgpt.com "nvidia/Mistral-NeMo-12B-Base"
[3]: https://manpages.debian.org/experimental/llama.cpp-tools/llama-server.1.en.html "llama-server(1) — llama.cpp-tools — Debian experimental — Debian Manpages"
[4]: https://manpages.debian.org/unstable/llama.cpp-tools/llama-server.1.en.html?utm_source=chatgpt.com "llama-server(1) — llama.cpp-tools — Debian unstable"
[5]: https://huggingface.co/docs/transformers/en/model_doc/llama?utm_source=chatgpt.com "Llama"
