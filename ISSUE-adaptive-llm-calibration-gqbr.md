# ISSUE — Adaptive LLM calibration with Global Quantile Boundary Racing

- Created: 2026-08-01
- Status: PROPOSAL — read and confirm with the user before implementation
- Package: genai-electron
- Affected API: `LlamaServerManager.calibrate()`
- Proposed policy: Global Quantile Boundary Racing (GQBR)

Related:

- `docs/dev/issues/ISSUE-llm-runtime-calibration.md` — the resolved v0.18.0 calibration issue
- `docs/dev/issues/ISSUE-adaptive-calibration-search.md` — downstream boundary-search evidence
- `docs/dev/plans/PLAN-llm-runtime-calibration.md` — the v0.18.0 implementation plan
- `src/managers/LlamaServerManager.ts`
- `src/utils/llama-calibration.ts`
- `src/types/llm-calibration.ts`

## Executive summary

genai-electron v0.18.0 added real-workload LLM runtime calibration. Its generated sweep is
deliberately bounded: it tests an auto-configured baseline, nearby GPU-layer placements, full
offload, conditional SWA pairs, an optional MoE counterfactual, and an optional KV-cache
counterfactual. This is safe and auditable, but it is not an effective search for a sharp VRAM
boundary. The auto-configured baseline is conservative, so the generated anchors may leave a wide
unprobed interval containing the true optimum. A downstream adaptive prototype found a faster and
more reproducible configuration in about one third of the time taken by the generated v0.18 sweep.

The immediate improvement is cell-local boundary search: for fixed SWA mode, KV precision, context,
and slot count, healthy performance normally improves as more layers are offloaded, so the relevant
candidate is the largest reproducibly healthy `gpuLayers` value. However, independently bisecting
every cell repeats almost the same memory-boundary search. The larger opportunity is to exploit the
fact that every cell may share one launch-level memory threshold when expressed in GPU-footprint
space.

This issue proposes replacing the current generated sweep with an adaptive calibration algorithm
called **Global Quantile Boundary Racing (GQBR)**:

1. learn a conservative quantile of the fresh-launch degradation threshold in footprint space;
2. translate that scalar threshold into each cell's safe GPU-layer boundary using footprint
   arithmetic;
3. directly measure only the derived candidates that could plausibly win;
4. spend extra launches on threshold reproducibility, failed structural assumptions, or unresolved
   preference-tolerance decisions;
5. return the selected configuration, a validated lower-footprint fallback when one exists, the
   full probe trail, and model-based uncertainty diagnostics.

There are no known consumers whose compatibility requires preserving the v0.18.0 calibration
shape. The adaptive design may therefore replace `calibrate()` directly instead of being added as a
sibling API or hidden behind a legacy strategy. Report and policy versions must still be retained
for persisted-report parsing, cache invalidation, reproducibility, and future statistical changes.

The global reduction must **not** be implemented on faith. It depends on two empirical premises:

- candidate GPU footprint is predictable accurately enough to locate a boundary within about one
  layer;
- after accounting for footprint and chronological/session effects, degradation transfers across
  SWA, KV-precision, and context cells through one shared scalar threshold.

The first work is therefore instrumentation and a multi-session engineering validation campaign
across explicitly approved machine/model/runtime scopes. If
either premise fails, the algorithm must fall back to corrected, partially pooled, or cell-local
boundaries rather than forcing an invalid global model.

## 1. Current v0.18.0 behavior

`LlamaServerManager.calibrate()` currently:

- requires one exact total `contextSize` and one exact `parallelRequests` count;
- generates at most ten candidates, or resolves caller-provided `combos` in caller order over the
  shared fixed configuration and auto-configured baseline;
- starts a new isolated loopback-only llama-server process for every candidate;
- performs one warmup per workload and then `samples` timed repetitions per workload inside that
  one process;
- verifies effective context and slot capacity through `/props`;
- records per-request prompt, decode, wall-time, and cache-reuse diagnostics;
- classifies hard candidate failures such as OOM, crash, startup timeout, and request timeout;
- scores successful candidates with a normalized weighted sum of scenario median wall times;
- applies the KV precision preference, ordinary robustness window, simplicity preference, and
  stable candidate order;
- returns a start-ready recommendation but never applies or persists it;
- leaves the normal manager stopped and protects later lifecycle operations from an unconfirmed
  calibration-process orphan.

The generated GPU ladder is:

```text
baseline
baseline - max(2, ceil(totalLayers × 10%))
baseline + max(2, ceil(totalLayers × 10%))
full GPU offload
```

Values are clamped and duplicate resolved argument sets are removed. Relevant SWA pairs can turn
four GPU anchors into eight candidates. MoE and KV comparisons are appended subject to the
ten-candidate cap.

This policy is a bounded benchmark, not a boundary search. It measures each selected candidate
well, but it has no mechanism for choosing a new `gpuLayers` value after observing where the VRAM
cliff actually lies.

## 2. Observed problem and evidence

The downstream adaptive-search trace in
`docs/dev/issues/ISSUE-adaptive-calibration-search.md` used:

- Windows 11;
- an 8 GB CUDA GPU;
- Gemma 4 12B IQ4_XS;
- total context 12,288 and one slot;
- production-mirrored narration and shared-prefix workloads.

The generated ladder left the interval between a conservative mid-20s anchor and full 48-layer
offload effectively unexplored, while the useful boundaries were:

- windowed SWA: 48 layers, but with visible run-to-run instability;
- full SWA: 45 layers, reproducibly healthy;
- full-SWA f16 at 45 layers: request timeout, which failed to establish that point as operationally
  viable and motivates probing f16 at its own boundary; the timeout alone does not prove memory
  degradation.

The downstream search used ten server starts and about 18 minutes. It selected:

```text
gpuLayers: 45
swaFull: true
cacheTypeK: q8_0
cacheTypeV: q8_0
flashAttention: on
score: about 3.318 seconds
```

The generated ladder used nine candidates and about 51.6 minutes. Its selected configuration scored
about 3.742 seconds and was less stable. The adaptive prototype was therefore approximately three
times faster as a calibration process and found a result about 13% faster in production-shaped
work.

The prototype also exposed an important failure in a naive global classifier. A healthy full-SWA
cell can have substantially slower narration than a healthy windowed-SWA cell because it is trading
narration behavior for shared-prefix reuse. A global “narration slower than 1.5 times the best”
predicate incorrectly classified the eventual winner as degraded. Until shared-footprint transfer
has been validated, healthy envelopes and soft-degradation decisions must remain cell-local.

## 3. Goals

The adaptive calibration must:

1. find the best risk-adjusted GPU-layer boundary without exhaustively scanning every layer;
2. compare SWA, KV precision, and selected context/slot profiles at their **own** feasible
   boundaries;
3. distinguish fresh-launch memory risk from within-launch timing noise;
4. treat successful but partially thrashing runs as degraded or ambiguous rather than automatically
   healthy;
5. use observed prompt/decode/cache diagnostics instead of status alone;
6. stop when remaining uncertainty cannot materially change the decision;
7. expose every observation, inference, assumption check, and fallback in the report;
8. preserve the existing lifecycle isolation, cancellation, progress, capacity verification, and
   orphan-protection guarantees;
9. remain deterministic and testable for a fixed observation trace and random seed;
10. avoid claiming distribution-free safety from a small model-based sample.

## 4. Non-goals

This issue does not propose:

- automatically applying or persisting the recommendation;
- sharing a calibration result across different machines, models, binary variants, drivers, or
  materially different workloads;
- claiming a distribution-free 95% certificate of less than 10% degradation risk from roughly ten
  launches;
- trusting auto-configuration estimates as observed evidence;
- forcing a single-threshold model when residual checks reject it;
- introducing a heavyweight numerical runtime dependency without explicit discussion;
- weakening cleanup, abort, or lifecycle-neutrality guarantees.

Exclusive GPU resources are currently a documented calibration precondition, not a guarantee
enforced by v0.18.0. The existing strict occupancy check detects another llama-server on common
ports; callers must still stop managed diffusion work and unrelated GPU-heavy processes. The
adaptive implementation should add pre-probe resource checks and a declared warning/abort policy
for material baseline drift.

## 5. Search-space notation

Let:

- `g` be the number of GPU-offloaded layers, usually `0..L`;
- `s` be the SWA/cache mode, initially `swaFull = false | true`;
- `k` be KV-cache precision, initially paired K/V `q8_0 | f16`;
- `P = (C, n)` be an exact profile containing total context `C` and slot count `n`;
- `z = (s, k, P)` be a cell;
- `x = (g, z)` be one deployable server configuration;
- `v(x)` be its predicted or corrected GPU footprint;
- `β_i` be the effective memory threshold experienced by fresh launch `i`;
- `D_i` be the event that launch `i` degrades;
- `T_H(x)` be the production-workload score when `x` is healthy.

The initial motivating space has two SWA modes, two KV precisions, two contexts, and up to 49
GPU-layer values: roughly 392 configurations. The API should not hard-code those exact cardinalities,
but the first implementation should remain deliberately bounded to axes whose memory and performance
effects can be measured and validated.

GQBR v1 must require the same `parallelRequests` value in every compared profile. The current
workload runner verifies all slots exist but exercises one controlled slot serially; it does not
benchmark concurrency. Every workload must fit the effective per-slot capacity of every profile and
must be identical across profiles so scores remain comparable. Supporting different slot counts is
a later axis that requires explicit concurrent workloads and an explicit profile-ranking rule.

MoE placement materially changes GPU and host-memory pressure. GQBR v1 must therefore require one
normalized discriminated MoE strategy—for example `default-placement`, `all-experts-cpu`,
`n-expert-layers-cpu`, or `tensor-override`—for MoE models. Record every resolved effective field,
including absence, and keep that strategy invariant across probes. Do not require mutually
alternative `cpuMoe`, `nCpuMoe`, and `overrideTensors` values simultaneously, and do not silently
drop v0.18.0's generated MoE counterfactual. A later policy may add MoE placement as a validated
outer cell axis with both GPU- and RAM-footprint accounting. Threads, batch size, `cacheRam`,
mmap/mlock, continuous batching, and other non-searched launch fields are also fixed across the
search.

## 6. Decision rule

Define fresh-launch degradation risk at footprint `u`:

\[
p_D(u) = \Pr(\beta < u).
\]

For an operational maximum degradation probability `ε`, define the eligible set:

\[
\mathcal{S}_\epsilon = \{x : p_D(v(x)) \le \epsilon\}.
\]

This is the ideal rule when footprint and threshold parameters are known. In the implemented
Bayesian decision, corrected footprint is uncertain (`V_x`), and eligibility additionally requires
the configured posterior probability that `p_D(V_x) ≤ ε`. Joint threshold/footprint uncertainty is
propagated as specified in Section 7.

The default proposed `ε` is 0.10. This is independent of the performance preference tolerance even
if both initially default to 10%.

Define risk-adjusted score:

\[
J_\epsilon(x) =
\begin{cases}
T_H(x), & x \in \mathcal{S}_\epsilon, \\
+\infty, & x \notin \mathcal{S}_\epsilon.
\end{cases}
\]

A chance constraint is preferable to assigning an arbitrary expected penalty to degradation. The
observed degraded outcomes range from moderate slowdown through severe thrashing, timeout, and OOM;
the tail cost is not reliably estimated by capped or censored probes.

For a performance preference tolerance `ρ`, initially 0.10:

1. compute `J_min = min J_ε(x)`;
2. retain configurations with `J_ε(x) ≤ (1 + ρ) J_min`;
3. among retained configurations, prefer the largest total context (and therefore largest per-slot
   context because GQBR v1 fixes the slot count);
4. among those, prefer f16 KV precision when present;
5. among remaining configurations, choose the lowest `J_ε`;
6. break a true remaining tie by lower estimated degradation risk and then deterministic stable
   order.

These preferences must be represented explicitly in the request/report rather than hidden in
implementation folklore. A generic consumer may eventually need a different preference order.

### 6.1 Proposed GQBR-v1 policy defaults

These values are proposed starting points. They become normative only after the validation campaign
approves them, and every effective value, prior, and classifier rule must be serialized under
`policyVersion`.

| Setting | Proposed value |
| --- | ---: |
| Maximum degradation probability `ε` | 0.10 |
| Posterior risk probability | 0.95 |
| Performance preference tolerance `ρ` | 10% |
| Posterior winner probability | 0.90 |
| Performance-regret tolerance | 2% of best healthy score |
| KV local-equivalence margin | 5% |
| Target fresh launches | 10 |
| Hard maximum fresh launches | 15 |
| Launches reserved for selected/fallback validation | 2 |
| Threshold-probe timed samples | 1 |
| Finalist timed samples | 3 |
| Soft-degradation starting rule | >1.5× the prespecified cell-local healthy envelope |
| Early-stop starting rule | >2× the prespecified cell-local healthy envelope |
| Near-threshold rule | standardized margin <2 or conservative margin <1 local layer step |
| Footprint median absolute held-out error | <0.5 local layer-equivalent |
| Footprint held-out error target | at least 95% within 1 local layer-equivalent |
| Cell-correction equivalence interval | contained within ±1 local layer-equivalent |
| Logistic/probit boundary sensitivity | ≤1 layer |

Classifier false-healthy and false-degraded gates require simulation and labelled held-out data
before their values are frozen. They are policy inputs, not values to invent after viewing the live
validation outcomes.

## 7. Stochastic threshold model

GQBR v1 uses one explicitly Bayesian inference contract. Let `c_β` be the requested posterior safety
probability and `α_β = 1 - c_β`. It must serialize the prior families,
hyperparameters, likelihood, approximation algorithm, random seeds, and posterior draw count as
policy-defining methodology. In particular:

- `q_lower = Q_{α_β}(q_ε \mid \mathcal D)` is the `α_β` posterior quantile;
- winner probability is computed from joint posterior draws using the declared safety and
  lexicographic decision rule;
- a reported degradation-risk upper bound is the declared posterior upper quantile;
- frequentist confidence intervals, if added later, use different field names and stopping rules.

Do not interchange “posterior probability,” “confidence bound,” bootstrap coverage, or a Laplace
approximation without changing `policyVersion`. The same normalized request and probe trace must
produce the same report.

For a continuous posterior,
`Pr(q_ε ≥ q_lower \mid \mathcal D) = c_β`. With the proposed `c_β = 0.95`,
`q_lower` is the 5th percentile, not the 95th percentile.

### 7.1 Working model

A practical initial model is:

\[
p_D(u \mid \mu, \tau)
= \operatorname{logit}^{-1}\left(\frac{u-\mu}{\tau}\right),
\qquad \tau > 0.
\]

Equivalently, the launch threshold is logistic with median `μ` and transition scale `τ`. The
footprint quantile corresponding to degradation probability `ε` is:

\[
q_\epsilon = \mu + \tau \log\frac{\epsilon}{1-\epsilon}.
\]

Then:

\[
v(x) \le q_\epsilon
\quad\Longleftrightarrow\quad
p_D(v(x)) \le \epsilon.
\]

Fit a probit sensitivity model as well. If the conservative logistic and probit boundaries differ
by more than one layer-equivalent, spend another threshold probe or take the smaller boundary and
record a model-sensitivity warning.

Launch thresholds need not be identically distributed through time. Use:

\[
\beta_i = \beta_{\text{session}} + \eta_i
\]

for transient launch pressure, and add a slow chronological effect if a repeated reference
configuration or resource snapshots demonstrate drift. Probe order should be randomized or
interleaved enough to avoid confounding one cell with time.

If a chronological effect is retained, the relevant quantile becomes `q_ε(t)`. The policy must
either:

- evaluate its lower posterior bound at an explicit deployment reference time;
- take the minimum lower bound over a declared calibration-validity horizon; or
- reject durable global certification when observed drift cannot bound future thresholds.

A `driftDetected` flag alone is insufficient. Unbounded drift must yield a conservative cell-local
result or no certified recommendation. A recommendation inferred from one short calibration session
describes that declared operating-state distribution; it is not automatically valid under unrelated
future background GPU loads.

### 7.2 Conservative safe boundary

Let `V_x` be the posterior distribution of corrected footprint for candidate `x`, including shared
and cell-specific footprint-correction uncertainty. The point estimate `v(x)` is useful for ordering
and probe selection but is not exact at selection time.

For every cell:

\[
g_{\text{safe}}(z)
= \max\left\{g :
\Pr\left(q_\epsilon \ge V_{(g,z)} \mid
\mathcal D_{\text{threshold}},\mathcal D_{\text{footprint}}\right)
\ge c_\beta\right\}.
\]

Compute this probability from joint threshold/footprint posterior draws. A conservative
bound-based implementation may require an upper posterior footprint bound to lie below
`q_lower`, but it must allocate the two tail probabilities so the **combined** posterior safety
probability remains at least `c_β`.

If no `g` qualifies, that cell is presently uncertifiable. If healthy performance is monotone in
`g`, the best safe candidate in a cell is exactly:

\[
x_z = (g_{\text{safe}}(z), z).
\]

This is the central reduction: learn one scalar threshold distribution, propagate footprint
uncertainty through it, and compare at most one primary candidate per cell. Boundary draws and winner
probabilities must never treat corrected bytes as exact. The guarantee is conditional on the
footprint and shared-threshold models. It is not a distribution-free simultaneous certificate.

### 7.3 Partially pooled fallback

If equal-footprint behavior differs across cells, fit:

\[
p_D(x) =
F\left(v(x) + \Delta_{s,k,P}\right)
\]

with cell corrections strongly shrunk toward zero. A correction whose uncertainty exceeds roughly
one layer-equivalent requires direct cell-local boundary probes. If corrections are large or
unstable, abandon global transfer for the affected axis and use per-cell boundary racing.

The correction model needs an identifiability constraint such as `Δ_reference = 0` or
`Σ_z w_z Δ_z = 0` plus a hierarchical shrinkage prior on identifiable cell contrasts. Shared
transfer passes only when every decision-relevant correction's declared posterior interval is
contained within ±1 **local** layer-equivalent and held-out boundary predictions meet the declared
criterion.

### 7.4 Policy-freeze gate

This proposal deliberately does not invent numerical priors before the validation data exists.
Before `llama-gqbr-v1` can be enabled, one versioned policy artifact must normatively define:

- footprint normalization and the support/priors for `μ`, `τ`, drift, and identifiable cell
  corrections;
- the latent Bernoulli degradation state `D` and observation model
  `Pr(Y \mid D, \theta_{\text{classifier}})` for observed healthy/memory-degraded labels, propagating
  validated classifier sensitivity/specificity and their uncertainty;
- a validated ignorable-missingness test or an explicit observation model for ambiguous,
  unavailable, and right-censored outcomes;
- the launch-level healthy-performance likelihood and priors;
- posterior approximation, grid/draw counts, convergence/numerical checks, and both random seeds;
- the prior-sensitivity grid and conservative disagreement rule;
- the exact per-joint-draw decision calculation;
- all classifier and stopping constants.

For each joint posterior draw, apply that draw's degradation probabilities and healthy scores to the
exact safety and lexicographic rule. `winnerProbability` is the fraction of draws won by a candidate.
Separately, a selected candidate must satisfy:

\[
\Pr\left(p_D(V_x) \le \epsilon \mid
\mathcal D_{\text{threshold}},\mathcal D_{\text{footprint}}\right)
\ge 1-\alpha_\beta.
\]

Thus low performance regret or high winner probability cannot make a risk-ineligible candidate
selectable. Golden observation traces must pin exact posterior summaries, next-probe choices,
terminal status, selected candidate, and fallback. Any change to this artifact changes
`policyVersion`.

## 8. Footprint model

GQBR only works if `v(x)` is a sufficiently accurate scalar ordering of effective GPU memory
pressure. The existing resource estimates are not sufficient evidence by themselves.

GQBR v1 is limited to a validated single discrete GPU whose relevant candidate pressure can be
represented by one scalar footprint. Multi-GPU placement, asymmetric devices, unified-memory Metal,
and CPU-only operation require per-device/vector thresholds or separate host-memory models and must
use a conservative fallback until validated. A machine-readable validation-scope artifact, not a
free-form backend name, decides whether global transfer is enabled.

The footprint implementation should expose a component breakdown:

- GPU-resident model tensor bytes for the exact layer/tensor placement;
- exact or server-reported KV allocation for `C`, slots, `s`, and `k`;
- compute and graph buffers;
- backend/runtime overhead;
- known flash-attention or cache-layout workspaces;
- an empirical correction and its uncertainty where exact accounting is unavailable.

For every validation or calibration probe, record:

- pre-launch GPU memory baseline;
- post-load steady-state incremental GPU memory;
- peak incremental GPU memory during warmup and every timed workload leg;
- llama.cpp-reported model, KV, compute, and graph device buffers where available;
- the predicted footprint and component breakdown;
- whether the observed memory is uncensored, right/left-censored, or unavailable;
- the difference between predicted and observed footprint for uncensored healthy observations;
- the local layer-equivalent prediction error for held-out uncensored observations.

For a healthy probe whose allocations complete, the sampled incremental resident peak is a noisy
proxy:

\[
v_{\text{observed},i}
= \max_t(\text{GPU-used memory during probe } i)
- \operatorname{median}(\text{pre-launch GPU-used memory}).
\]

This device-wide delta can be contaminated by allocator reservations, sampling frequency, graphics
work, or another process allocating during the probe. It must be reconciled with attributable
llama.cpp allocation diagnostics and the pre-probe resource-drift policy.

For OOM, allocation failure, timeout, or visibly degraded probes, sampled used memory is capped by
available capacity and can understate latent required bytes. Treat it as a censored lower bound, not
as the true required footprint. Derive required bytes from validated tensor/KV/buffer diagnostics
where possible, keep censored observations separate, and never compute ordinary signed footprint
error from them.

Absolute byte equality is not necessary if the corrected footprint preserves ordering and predicts
every decision-relevant boundary accurately. A one-layer error is material.

## 9. Classifying healthy, degraded, and ambiguous probes

Current status alone is insufficient. An `ok` request can complete while partially thrashing.

Every probe carries separate operational, memory-evidence, and censoring fields:

- `operationalStatus`: whether the process/request completed correctly;
- `memoryEvidence`: `healthy`, `memory-degraded`, `ambiguous`, or `unavailable`.

Only `memoryEvidence` updates the shared threshold likelihood. Operational failures remain fully
reported but do not automatically imply `β < v(x)`.

Memory evidence is separate from measurement censoring:

- `footprintObservation`: `uncensored`, `lower-bound`, or `unavailable`;
- `timingObservation`: `complete`, `right-censored`, or `unavailable`.

### Direct memory-degraded evidence

- OOM or a validated GPU allocation failure;
- a crash, startup timeout, or request timeout whose diagnostics attribute it to memory pressure;
- a fatal runtime error matching a validated memory-allocation/degradation pattern.

Startup/request timeout, incomplete generation, generic crash, protocol error, CPU contention, and
cleanup failure are not inherently memory evidence. Without attribution, exclude them from the
healthy-performance model and retain them as right-censored timing observations and
ambiguous/unavailable memory evidence requiring repetition or investigation.

### Soft degraded

A successful probe whose relevant narration prefill and/or decode behavior has collapsed relative to
a **prespecified same-cell, layer-conditional** healthy envelope. The envelope cannot be a mutable
cell-wide “best so far”: healthy latency normally improves with `g`, so a later fast probe must not
retroactively relabel a lower-`g` healthy probe. Thresholds and the envelope construction must be
declared before the validation run. The downstream prototype used these starting heuristics:

- narration median greater than 1.5 times the cell's best healthy reference as degraded;
- request timeout around 2 times the cell's best narration as an early stop.

Those numbers are evidence-based starting points, not final universal constants. The implementation
must validate them on independently labelled held-out traces, freeze their false-healthy and
false-degraded gates under `policyVersion`, and report which rule fired.

### Expected cell behavior

Low prompt-cache reuse and slower shared-prefix reads can be expected when `swaFull = false`. If
narration remains on the cell's healthy envelope and observed cached tokens explain the read
slowdown, do not call the probe memory-degraded.

### Ambiguous

If performance is abnormal but the mechanism is unclear:

- retain the complete observation;
- do not update the healthy timing model with it;
- do not force it into hard binary threshold evidence;
- schedule an independent repeat or a nearby footprint probe.

Ambiguous/unavailable observations may be excluded from the threshold likelihood only when their
missingness is validated as ignorable relative to latent degradation. Otherwise repeat them, model
their observation probability, or conservatively prevent affected candidates from becoming
`selected`. An ambiguous outcome during direct selected-candidate validation remains unresolved
unless replaced by admissible independent evidence. The exact classifier-observation likelihood
and priors are policy-defining.

Once the shared-threshold model has been validated, the classifier may use partial pooling, but it
must retain cell effects so that legitimate SWA/cache performance differences are not mistaken for
thrashing.

## 10. Healthy-performance model

The operational objective remains the existing calibration score: a normalized weighted sum of
per-workload median complete-scenario wall times. The report should not call this an expected
latency unless the statistic is explicitly changed.

Use the individual request legs to share information and diagnose mechanisms:

- prompt wall time and tokens/second;
- prediction wall time and tokens/second;
- observed cached tokens;
- narration versus shared-prefix burst roles;
- cell-local fixed costs;
- context and KV direct effects.

A target model represents individual samples and launch-level dependence:

\[
\log t_{ij\ell}
= \log t_\ell(x_i;\phi) + b_{i\ell} + e_{ij\ell},
\]

where `b_iℓ` is a launch-level effect and `e_ijℓ` is within-launch timing noise. Samples in one
process may be autocorrelated, and the variance of a median does not generally scale as `1/m`.
Uncertainty estimation must preserve this dependence or justify an effective sample size.

The GPU-layer effect should be monotone or shape-constrained, but the implementation should begin
with the simplest adequate model:

- local isotonic regression or monotone interpolation near derived boundaries;
- partial pooling only for effects supported by structural checks;
- direct measurement of every competitive finalist;
- no wide-range extrapolation from a handful of points.

If healthy performance is not locally monotone in `g`, begin by expanding the cell's candidate set
to:

\[
\{g_{\text{safe}}, g_{\text{safe}}-1, g_{\text{safe}}-2\}
\]

This is only the initial expansion. Retain every lower layer with material posterior probability of
being optimal or lying inside the preference band, and expand downward until the remaining points
are performance-dominated under a frozen posterior criterion. If the budget cannot resolve the
affected cell, mark it unresolved and do not emit `selected`.

## 11. Probe fidelity

The distinction between samples and launches is fundamental.

### Threshold-oriented probe

- one fresh server process;
- one warmup;
- `samples: 1`;
- aggressive but safe degraded-run timeout;
- purpose: one new realization of launch-level memory pressure.

More requests in the same process do not provide another draw of `β`.

### Performance-oriented probe

- one fresh server process;
- one warmup;
- at least two timed samples, normally the production default of three;
- purpose: estimate a finalist's healthy workload score or resolve a close preference decision.

### Stability replication

Repeat the exact configuration in another fresh process. For a near-boundary finalist, one
full-sample performance launch plus a separate one-sample stability launch is more informative than
adding another sample to the same process.

Two successful launches are a reproducibility check, not proof that degradation probability is
below 10%.

## 12. Sequential GQBR policy

### Phase A — establish a healthy reference

Choose a measured, comfortably feasible anchor useful for both threshold and performance modelling.
An auto-configuration prediction is prior information, not proof. GQBR v1 does not reuse probe
evidence across `calibrate()` calls or resume an aborted report. A probe already completed earlier
in the same still-active call retains its chronological place, but no external report counts toward
the current fresh-launch evidence or budget.

If a cell's reference fails, walk downward within that cell until a healthy point is found or `g=0`
is exhausted.

### Phase B — learn the global threshold region

Choose one-sample fresh-launch probes near footprints expected to split the plausible `q_ε` range.
An ideal policy maximizes information about `q_ε` and the vector of derived cell boundaries per
expected wall-clock cost. A simpler initial implementation may choose the untested footprint nearest
the posterior median boundary, tie-breaking toward:

1. an active cell lacking performance evidence;
2. an actual derived candidate boundary;
3. a lower expected capped probe cost.

Forced exploration must provide:

- at least one clear healthy observation;
- at least one clear degraded observation unless the maximum footprint remains repeatedly healthy;
- evidence at more than one footprint near the transition so `τ` is not determined entirely by its
  prior.

Continue until boundary uncertainty is within one layer for every non-dominated cell or remaining
uncertainty cannot change the final decision.

### Phase C — validate decision-relevant structure

#### SWA/cache mode

Require at least one healthy near-candidate full-workload observation for every surviving SWA mode.
Do not eliminate a mode solely from its reuse model.

#### KV precision

When f16 versus q8 can affect the decision, compare them at the largest common comfortably safe
`g`, or directly probe each at its own boundary. A local equivalence margin of approximately half
the preference tolerance (initially 5%) is reasonable.

Failure to establish equivalence does not mean f16 loses. It means KV precision remains an
unpooled axis and f16 requires its own candidate/boundary evidence.

#### Context

Only probe a matched context comparison when the larger context has a material probability of
falling within the preference band. If the larger-context boundary is close to the matched point,
probe its actual boundary instead of an arbitrary interior point.

#### Shared-threshold residual check

When global transfer is decision-critical, probe a cross-cell configuration whose predicted
footprint matches an existing observation. Compare memory-degradation outcomes and classifier
residuals after applying the prespecified cell-specific healthy envelopes. Legitimate differences
in raw healthy prompt/decode rates do not reject the shared-threshold model. If conditional
degradation residuals disagree beyond the declared tolerance, enable cell corrections or fall back
to local search.

### Phase D — race surviving cell candidates

For every active cell, derive `x_z = (g_safe(z), z)`. Use posterior/uncertainty samples of the
threshold and healthy-performance models to apply the exact risk and lexicographic preference rule.

The next performance probe should resolve the uncertainty most likely to change the winner:

- safety at a boundary;
- direct KV effect;
- direct context effect;
- cache-reuse mechanism;
- healthy performance extrapolation.

Use full performance samples when the comparison is close to the fastest score or the preference
tolerance.

### Phase E — validate the provisional winner

A winner is near the threshold when either:

\[
\frac{\operatorname{median}(q_\epsilon)-v(x)}
     {\operatorname{sd}(q_\epsilon)} < 2,
\]

`q_lower - v(x)` is less than one valid local layer step, or nearby outcomes conflict.

Require at least two fresh launches for such a finalist. At least one should use full performance
samples. If a finalist degrades:

1. update the threshold model;
2. recompute every derived boundary;
3. normally probe the same cell one layer lower;
4. do not discard the cell automatically.

### 12.1 Normative controller pseudocode

The implementation plan may refine names, but `policyVersion = llama-gqbr-v1` must freeze one exact
controller, likelihood, priors, and tie-breaking behavior. The following defines the required state
flow:

```text
validate request, identities, validation-scope artifact, and resource preconditions
reserve finalValidationProbes and their worst-case request/teardown allowance
initialize deterministic Bayesian threshold/performance state from serialized priors

if global footprint transfer is not validated for this exact scope:
    mode := CELL_LOCAL
else:
    mode := GLOBAL

while search budget remains:
    classify all observations into operationalStatus and memoryEvidence
    update threshold only from admissible memory evidence
    update healthy performance only from admissible healthy observations

    if drift cannot be bounded over the declared validity horizon:
        mode := CELL_LOCAL, or terminate with no certified candidate

    if mode == GLOBAL:
        compute q_epsilon posterior and q_lower
        derive boundary distribution for every active cell
        run matched-footprint residual checks when transfer is decision-critical
        if a check fails:
            use identifiable cell corrections when validated
            otherwise switch affected cells to CELL_LOCAL

    if mode == CELL_LOCAL:
        update each affected cell's local stochastic boundary interval

    construct conservative candidates and local non-monotone alternatives
    compute joint-posterior safety, healthy-score, and preference summaries

    if mandatory structural evidence is missing:
        choose that decision-relevant probe
    else if boundary uncertainty can change the decision:
        choose the highest threshold-information-per-cost probe
    else if preference or performance uncertainty can change the decision:
        choose the highest decision-value-per-cost probe
    else:
        break

    execute exactly one fresh-launch probe and append it chronologically

use the reserved budget to validate the provisional selected candidate
validate a lower-footprint fallback when one exists and budget permits
recompute the complete posterior and decision after validation

if every selection condition passes:
    status := complete; selected := certified candidate
else if no candidate satisfies the model-based risk rule:
    status := no-certified-candidate; selected := absent
else:
    status := budget-exhausted; selected := absent; provisional := diagnostic only

return schema-v2 report and confirm cleanup

on abort or fatal failure:
    confirm cleanup
    build partial report with status := aborted or failed
    reject with ServerError.details.report := partial report
```

### 12.2 Normative cell-local fallback

Cell-local mode is the correctness fallback, not an informal suggestion:

```text
for each affected cell:
    ceiling := highest g allowed by the search space and any already proven ordering
    reference := min(auto-configured g, ceiling)
    initialize a separate monotone posterior p_D(g | z)

    probe reference in a fresh launch
    update the posterior; never treat one outcome as a proven low/high boundary

    while no g is posterior-risk-eligible and lower untested g exists:
        choose a lower g by deterministic bracket expansion/information gain
        probe again
        update the posterior and classifier-observation model

    if no g becomes posterior-risk-eligible within the cell budget:
        mark cell uncertified and continue

    derive the posterior distribution of the largest risk-eligible g
    while that boundary uncertainty can change the decision and cell budget remains:
        choose the layer with maximum boundary information per expected cost
        # This will often resemble midpoint bisection, but does not certify from one outcome.
        probe in a fresh launch and update the posterior
        ambiguous/failure -> independently repeat when decision-relevant;
                             otherwise leave unresolved

    conservativeBoundary := largest g satisfying the posterior risk rule
    directly measure conservativeBoundary with finalist fidelity if the cell remains competitive
```

Cell-local soft degradation uses the prespecified layer-conditional envelope. The controller must
reserve enough global budget for the likely winner's independent validation; it may stop low-value
cells unresolved rather than consume the finalist reserve.

To satisfy the `p_D ≤ ε` contract, cell-local mode uses the latent degradation/classifier
observation model with a separate monotone Bayesian `p_D(g \mid z)` for each affected cell.
Deterministic `healthy → low` / `degraded → high` bracketing may still produce a useful
`heuristic-boundary` diagnostic, but it cannot populate `selected` under the model-based risk
contract.

## 13. Stopping rule and probe budget

Treat ten probes as a soft target at which value-of-information requirements become stricter, not a
guaranteed stop. A proposed default budget is:

- target: 10 fresh launches;
- hard maximum: 15;
- reserve: 2 launches for selected/fallback validation;
- threshold probes: one timed sample;
- finalist probes: full samples.

Stop when:

1. the selected candidate is model-based safety-eligible at the requested posterior probability;
2. posterior winner probability exceeds the requested decision threshold, initially 90%, **or**
   posterior **performance** regret is below approximately 2% of the best score;
3. larger-context and f16 alternatives are either selected or resolved relative to the preference
   band—low performance regret alone cannot satisfy stopping while a lexicographic preference is
   unresolved;
4. surviving SWA modes have direct observations;
5. the shared-threshold, KV-neutrality, context-effect, and monotone-layer assumptions are either
   supported or explicitly disabled;
6. a near-boundary winner has independent fresh-start evidence;
7. cleanup and resource state are confirmed.

After the soft target, another probe is valuable when:

- the provisional winner is not safety-eligible;
- one restart can decide whether to retain the boundary layer or step down;
- a preferred context/precision candidate has roughly 20–80% probability of lying within the
  tolerance band;
- expected deployment savings exceed probe cost.

If `H` production turns are expected before recalibration, a decision-theoretic continuation rule
is:

\[
H \times \operatorname{EVSI}_{\text{seconds saved per turn}}
> \operatorname{expected probe seconds}.
\]

When deployment horizon is unknown, use the target/hard budget, performance-regret threshold, and
separate preference-resolution requirements.

The controller produces exactly one terminal report status:

- `complete` — all selection conditions pass and `selected` is present;
- `budget-exhausted` — uncertainty remains; `selected` is absent and any provisional candidate is
  diagnostic only;
- `no-certified-candidate` — no candidate satisfies the model-based risk rule; `selected` is absent;
- `aborted` — caller cancellation with partial probes;
- `failed` — preparation, invariant, or cleanup failure.

`calibrate()` resolves reports only for `complete`, `budget-exhausted`, and
`no-certified-candidate`. Abort and failure preserve v0.18 rejection semantics: they reject with a
`ServerError` carrying the schema-v2 partial report in `details.report`. The `aborted`/`failed`
variants exist so that partial report is typed and serializable; they are not normal resolved
results.

Never return an uncertified provisional winner as `selected`. A directly observed candidate that is
risk-eligible but preference-unresolved remains provisional under `budget-exhausted`. The caller may
request a larger explicit `maxProbes`/`maxWallTimeMs` before starting.

`maxWallTimeMs` is the deadline for starting or continuing calibration work, not a promise to skip
or truncate mandatory teardown. Before starting a probe, reserve its worst-case configured request
time plus normal teardown allowance; do not start it if the remaining search budget is insufficient.
At the deadline, abort in-flight requests and begin cleanup. No new probe or inference work starts
after the deadline, but orphan-safe process termination and confirmation may overrun it. Report
search elapsed time and cleanup overrun separately.

## 14. Required engineering validation before global transfer

The approximately ten-probe user calibration cannot simultaneously establish the structural model
from scratch. Validate the structure with a larger multi-session, multi-scope engineering campaign
before making GQBR the production policy.

### 14.1 Footprint-arithmetic validation

For each relevant cell, test approximately:

- predicted boundary minus one layer;
- predicted boundary;
- predicted boundary plus one layer;
- three to five independent starts at each point;
- randomized/interleaved order;
- a repeated reference configuration every block.

For two SWA modes, two KV precisions, and two contexts:

```text
8 cells × 3 boundary positions × 3 launches = 72 launches
8 cells × 3 boundary positions × 5 launches = 120 launches
```

These 72–120 launches are an initial design estimate for footprint instrumentation, not proof that
three to five launches per point identify a 10% stochastic risk boundary. Before live validation,
run simulation-based power/coverage analysis under plausible transition widths, drift, cell
corrections, censoring, and classifier error. Increase independent restarts until the prespecified
held-out boundary interval is at most one layer wide or mark the cell unresolved.

For an uncensored held-out healthy probe, define a valid local byte step:

\[
\Delta_v(g,z) =
\begin{cases}
v(g+1,z)-v(g,z), & g < L \text{ and the increment is positive},\\
v(g,z)-v(g-1,z), & g = L \text{ and the increment is positive}.
\end{cases}
\]

Heterogeneous/MoE layers can have zero or nonuniform increments. In that case use the nearest valid
positive local increment only as a diagnostic. The primary acceptance metric is discrete held-out
boundary-index error in `g`, which is defined at full offload.

For eligible uncensored observations, compute diagnostic layer-equivalent footprint error:

\[
e_i =
\frac{v_{\text{observed},i} - v_{\text{predicted},i}}
     {\Delta_v(g,z)}.
\]

Initial acceptance gates:

- estimate empirical corrections on training configurations and evaluate every gate on held-out
  configurations/launches or nested cross-validation;
- median absolute uncensored held-out error below 0.5 local layer-equivalent;
- at least 95% of uncensored decision-relevant held-out errors below one local layer-equivalent;
- held-out predicted boundary-index interval no more than one layer from the directly estimated
  interval;
- correct footprint ordering across `g` and across matched cells;
- no systematic residual associated with `s`, `k`, or `C` after correction;
- the 95th percentile of uncensored launch-to-launch footprint variation below one valid local
  layer-equivalent;
- censored observations excluded from ordinary signed-error gates and reported separately.

If this fails, improve the footprint model or use empirical/cell-corrected footprints. Do not hide
the failure with a wider posterior.

### 14.2 Shared-threshold validation

Choose equal or nearly equal corrected-footprint configurations from different cells near the
transition. Interleave fresh launches so cells experience comparable chronological conditions.

Compare:

```text
M0 shared:
    logit P(degraded) = a + b × footprint + session/time effect

M1 cell-corrected:
    logit P(degraded) =
        a + b × (footprint + Δ[s,k,P]) + session/time effect
```

Use leave-one-cell-out validation:

1. fit the threshold model using all but one cell;
2. predict the held-out cell's boundary;
3. estimate the held-out cell's boundary interval using the prespecified independent procedure;
4. repeat for every cell.

Initial acceptance gates:

- every held-out posterior boundary interval is within one layer of the direct held-out interval;
- every relevant identifiable cell-correction posterior interval is contained within ±1 local
  layer-equivalent;
- logistic and probit conservative boundaries differ by no more than one layer;
- equal-footprint residuals show no systematic SWA, KV, or context effect;
- drift either stays within the declared validity-horizon model or disables global certification;
- the selected candidate is unchanged across the prespecified prior-sensitivity grid, or the more
  conservative result is used with a warning.

Leave-one-cell-out prediction is the decisive test. A good in-sample global fit is insufficient.

### 14.3 Degradation-classifier validation

Define hard, soft, expected-cell, and ambiguous classifications before inspecting validation
outcomes. Build labelled traces across:

- comfortably healthy configurations;
- known partial-thrash points;
- hard OOM/validated allocation failures plus separately labelled memory-attributed and
  non-memory timeout controls;
- windowed-SWA cache-reuse loss;
- full-SWA healthy-but-slower narration;
- multiple backends where supported.

Use independent labels that are not derived solely from the classifier's own timing threshold.
Proposed initial gates are:

- one-sided 95% upper bound on false-healthy rate ≤5%;
- one-sided 95% upper bound on false-memory-degraded rate ≤10%;
- ambiguity and non-memory operational-failure rates reported separately;
- any failed gate disables soft-degradation evidence for global threshold fitting.

Power analysis determines the required labelled count; do not declare success from a small point
estimate. A false-healthy boundary classification is the more serious error.

### 14.4 Backend scope

Validate one backend at a time. Passing on Windows CUDA does not establish correctness for Vulkan,
Metal, or CPU-only operation. The report must identify the binary variant, and unsupported/unvalidated
variants should use a conservative local-search fallback.

Approval is represented by a versioned, machine-readable validation-scope artifact keyed at least by:

- binary backend/version and footprint-model version;
- single-/multi-device topology and device memory class;
- model architecture, dense/MoE class, quantization/metadata class, and sharding characteristics;
- relevant fixed runtime flags;
- driver/runtime identity when discoverable;
- validation datasets, sessions, ambient-memory conditions, policy defaults, and expected golden
  reports.

One Windows CUDA/Gemma session does not approve every CUDA model. Validate across multiple sessions
and representative approved model classes. If driver/runtime identity cannot be discovered, preserve
`best-effort` cacheability and prohibit automatic persisted-report reuse.

## 15. Confidence limitation

The report must state prominently that threshold confidence is model-based.

For a prespecified fixed configuration under independent, identically distributed Bernoulli launches
and a stable operating state, the exact one-sided 95% Clopper–Pearson upper bound after zero failures
is:

\[
1 - 0.05^{1/n}.
\]

Under those assumptions, demonstrating less than 10% degradation probability at 95% nonparametric
confidence requires 29 independent zero-failure launches. At 90% confidence it still requires 22.
This is nonparametric with respect to the threshold distribution, not assumption-free: dependence,
drift, or changing operating state invalidates the calculation. Adaptive finalist selection also
requires a fresh prespecified validation set or an anytime-valid procedure. Within-process samples
do not count as independent threshold observations.

GQBR can make a useful decision with fewer launches by sharing a validated footprint/threshold
model, but it must never present that result as distribution-free.

## 16. Proposed public API

Because there are no compatibility-sensitive v0.18.0 calibration consumers, redesign
`calibrate()` directly. Names remain flexible, but the shape must make profiles, axes, risk,
preferences, and budget explicit.

GQBR v1 validates that all profiles share one `parallelRequests` value and that every workload fits
every profile's verified per-slot capacity. For MoE models, placement fields are required in
one normalized invariant MoE strategy until a MoE search axis is validated.

```typescript
const report = await llamaServer.calibrate({
  modelId: 'gemma-4-12b',

  profiles: [
    { contextSize: 12_288, parallelRequests: 1 },
    { contextSize: 16_384, parallelRequests: 1 },
  ],

  fixedConfig: {
    threads: 8,
    flashAttention: 'on',
    moePlacement: { mode: 'default-placement' }, // required normalized strategy for MoE
  },

  search: {
    gpuLayers: { min: 0, max: 'all' },
    swaFull: [false, true],
    kvCache: [
      { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' },
      { cacheTypeK: 'f16', cacheTypeV: 'f16' },
    ],
  },

  workloads: productionWorkloads,
  generationSeed: 42,
  policySeed: 42,
  startupTimeoutMs: 120_000,
  requestTimeoutMs: 120_000,

  risk: {
    maxDegradationProbability: 0.10,
    posteriorProbability: 0.95,
  },

  preference: {
    tolerancePct: 10,
    order: ['larger-context', 'f16'],
  },

  decision: {
    winnerProbability: 0.90,
    performanceRegretPct: 2,
  },

  budget: {
    targetProbes: 10,
    maxProbes: 15,
    reserveFinalValidationProbes: 2,
    finalistSamples: 3,
    maxWallTimeMs: 30 * 60_000,
    expectedProductionTurns: 10_000,
  },

  onProgress: progress => {
    sendToRenderer('llm-calibration-progress', progress);
  },

  signal: abortController.signal,
});
```

`expectedProductionTurns` may be omitted, in which case EVSI does not use deployment economics.
The API must also retain a typed diagnostic exact-probe mode for validation, reproduction, and
debugging. It need not preserve the old generated-sweep semantics, but exact probes, repetitions,
ordering/randomization, fidelity, and timeout settings must all be explicit.

## 17. Proposed report

The report needs a new schema because the old schema cannot distinguish observations from derived
boundaries or express threshold uncertainty.

```typescript
interface AdaptiveLlamaCalibrationReport {
  schemaVersion: 2;
  policyVersion: 'llama-gqbr-v1';
  createdAt: string;
  status:
    | 'complete'
    | 'budget-exhausted'
    | 'no-certified-candidate'
    | 'aborted'
    | 'failed';
  statusReason: string;

  model: LlamaCalibrationModelIdentity;
  binary: LlamaCalibrationBinaryIdentity;
  machine: LlamaCalibrationMachineIdentity;
  cacheability: {
    level: 'stable' | 'best-effort';
    reasons: readonly string[];
  };

  request: ResolvedAdaptiveLlamaCalibrationConfig;

  confidenceType: 'bayesian-model-based';

  methodology: {
    generationSeed: number;
    policySeed: number;
    warmupsPerWorkload: 1;
    thresholdSamples: number;
    finalistSamples: number;
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    resourceCooldownMs: number;
    scoreUnit: 'scenario-median-wall-ms';
    priors: AdaptiveLlamaCalibrationPriors;
    likelihoodVersion: string;
    posteriorApproximation: AdaptiveLlamaPosteriorApproximation;
    posteriorDraws: number;
    classifier: AdaptiveLlamaDegradationPolicy;
    decision: AdaptiveLlamaDecisionPolicy;
  };

  footprintModel: {
    version: string;
    components: readonly string[];
    validationArtifactId?: string;
    validationScope: AdaptiveLlamaValidationScope;
    scopeMatched: boolean;
    uncertaintyModelVersion: string;
    warnings: readonly string[];
  };

  threshold: {
    model: 'logistic' | 'probit' | 'cell-corrected' | 'cell-local';
    epsilon: number;
    posteriorMedianSafeFootprintBytes?: number;
    posteriorLowerSafeFootprintBytes?: number;
    posteriorIntervalBytes?: readonly [number, number];
    posteriorProbability: number;
    driftDetected: boolean;
    validityHorizon?: { startedAt: string; endsAt?: string };
    sensitivityWarnings: readonly string[];
  };

  probes: readonly AdaptiveLlamaCalibrationProbe[];
  cells: readonly AdaptiveLlamaCalibrationCellResult[];

  selected?: {
    startConfig: ResolvedLlamaCalibrationConfig;
    observedDirectly: boolean;
    independentLaunchCount: number;
    posteriorFootprintIntervalBytes?: readonly [number, number];
    estimatedHealthyScoreMs: number;
    posteriorScoreIntervalMs?: readonly [number, number];
    posteriorDegradationProbability?: number;
    posteriorDegradationProbabilityUpperQuantile?: number;
    posteriorWinnerProbability?: number;
    performanceRegretMs?: number;
    largerContextWithinToleranceProbability?: number;
    f16WithinToleranceProbability?: number;
    rationale: readonly string[];
  };

  provisional?: AdaptiveLlamaProvisionalDecision;

  lowerFootprintFallback:
    | {
        available: true;
        startConfig: ResolvedLlamaCalibrationConfig;
        riskEligible: boolean;
        observedDirectly: boolean;
        independentLaunchCount: number;
        posteriorDegradationProbabilityUpperQuantile?: number;
        footprintMarginBytes?: number;
        estimatedPerformanceLossPct?: number;
        reason: string;
      }
    | { available: false; reason: string };

  structuralChecks: readonly AdaptiveLlamaStructuralCheck[];

  stopping: {
    reason: string;
    probeCount: number;
    targetProbes: number;
    maxProbes: number;
    reservedValidationProbes: number;
    searchElapsedMs: number;
    cleanupElapsedMs: number;
    cleanupOverrunMs: number;
    maxWallTimeMs: number;
  };
}
```

`selected` is present only for `status: 'complete'`. Under `budget-exhausted`, a provisional
decision may be reported for diagnosis but is never represented as the recommendation.
`lowerFootprintFallback` may be called “safer” only when `riskEligible` is true; otherwise it is
merely a lower-footprint option. It is explicitly unavailable at `g=0` or when validation budget was
insufficient.

Every cell result should include:

- derived safe-boundary range;
- directly probed configurations;
- whether its boundary was observed, globally inferred, cell-corrected, or cell-local;
- healthy-performance estimate and uncertainty;
- degradation observations and ambiguity;
- reasons for dominance/elimination;
- exact start-ready candidate.

Every probe should include:

- chronological index and timestamps;
- fresh-launch identity;
- exact resolved configuration and command-relevant arguments;
- predicted footprint and component breakdown;
- observed baseline, steady, and peak memory plus censoring/attribution where available;
- warmup/sample fidelity;
- per-request diagnostics;
- separate operational status, memory evidence, footprint/timing censoring, classifier rule, and
  reason;
- cleanup outcome.

Raw prompt content remains hashed and omitted.

## 18. Progress and cancellation

Adaptive progress cannot truthfully expose a fixed candidate count at the beginning. Replace
candidate-index progress assumptions with phase, probe budget, and current decision state:

- `preparing`;
- `measuring-reference`;
- `learning-threshold`;
- `checking-structure`;
- `racing-finalists`;
- `validating-winner`;
- `stopping`;
- `done`.

Progress should include:

- completed probes;
- soft target and hard maximum;
- current cell/candidate;
- why the probe was selected;
- current provisional winner;
- whether boundary, structural, or performance uncertainty is being resolved;
- monotonic overall percent based on the hard budget plus phase completion.

Abort rejects with `ServerError.details.code === 'CALIBRATION_ABORTED'` and a schema-v2 partial
report whose `status` is `aborted` and whose probe trail contains every completed probe, mirroring
v0.18's completed-run diagnostics. Provisioning abort limitations must be documented. Cleanup
failure and orphan protection remain fatal and block later lifecycle operations until the process
is confirmed dead.

## 19. Edge regimes and fallbacks

### No GPU

Disable the GPU-footprint threshold model. Use a bounded cell-local performance/feasibility race, or
a separately validated host-memory pressure model. Do not transfer CUDA/GPU `q_ε` semantics to CPU
RAM. If no candidate is certified within the budget, return `no-certified-candidate` rather than
inventing a GPU-style threshold.

### Only g=0 is feasible

Once `g=0` is healthy and every `g=1` footprint is above the conservative boundary, reduce the
problem to a small SWA/KV/context performance race.

### Cell infeasible at g=0

Discard or mark the cell uncertifiable. Lexicographic preference cannot rescue a configuration that
fails the risk constraint.

### Every candidate appears healthy

Probe the globally largest corrected footprint relevant to surviving cells, which is not
necessarily full offload in every cell. The threshold is right-censored above the tested space.
Derive `g=L` for a cell only when the posterior lower safe quantile actually exceeds that cell's
`v(L,z)`; otherwise return the best certifiable lower point or no certified selection. Directly
probe the likely winner and report that tail risk is model-dependent and tested only through the
largest observed footprint.

### Every candidate appears degraded

Repeat the globally minimum-footprint relevant configuration to distinguish an infeasible search
space from one bad observation. Return “no configuration certified within the budget” unless
repeated memory-attributed diagnostics establish infeasibility; one stochastic or non-memory
failure does not prove that no configuration can work. Suggest a smaller model/context or a cleaner
runtime state in diagnostics.

### Larger context exceeds the tolerance

Larger context is preferred only within the declared performance band. Eliminate it when evidence
shows every larger-context candidate is more than `1+ρ` slower than a credible smaller-context
candidate.

### KV precision is not speed-neutral

Keep separate precision-specific performance models and probe each competitive precision at its own
safe boundary. Prefer f16 only if it lies within the declared band.

### Healthy score is not monotone in gpuLayers

Start with the three-point expansion below the safe boundary, then continue downward while any
unmeasured/lower layer has material posterior probability of being optimal or inside the preference
band. Record the monotonicity warning. If the declared dominance criterion is not met within budget,
return the cell unresolved and do not emit `selected`.

### Shared threshold fails

Use cell corrections if small and validated. Otherwise revert to cell-local boundary search for the
affected axes. Correctness takes priority over the global efficiency claim.

### Footprint measurement unavailable

Use the normative cell-local controller in Section 12.2, preserving the operational lessons from
`docs/dev/issues/ISSUE-adaptive-calibration-search.md`. A separately specified stochastic model in
layer-index space may provide model-based cell-local risk. If only deterministic
healthy/degraded bracketing is available, label the result `heuristic-boundary` and do not expose it
as satisfying the `p_D ≤ ε` contract.

## 20. Implementation plan

### Phase 1 — preserve and isolate a probe primitive

Refactor the existing candidate runner into an internal fresh-launch probe API that:

- provisions once where safe but starts a new isolated process per threshold realization;
- accepts one exact resolved configuration and fidelity;
- verifies `/health`, `/props`, slot count, and context capacity;
- runs production workloads with controlled slot state;
- records all request diagnostics;
- enforces per-cell early-stop timeouts;
- stops and confirms process death;
- returns an immutable probe observation.

Do not weaken the existing normal-manager lifecycle isolation.

### Phase 2 — footprint instrumentation

Add pure footprint component arithmetic and observed-memory adapters:

- exact GGUF tensor/layer accounting where metadata permits;
- KV allocation accounting for context, slots, precision, and SWA behavior;
- parsing of stable llama.cpp buffer-size diagnostics where defensible;
- backend-specific total/available/used GPU sampling;
- peak tracking during startup and workloads;
- normalized driver/runtime identity where discoverable;
- explicit uncertainty/warnings when measurement is unavailable.

Keep platform/backend adapters separate from the statistical policy.

### Phase 3 — engineering validation harness

Implement a non-default diagnostic harness capable of:

- executing an exact factorial configuration list;
- repeating the same configuration in independent processes;
- randomizing/interleaving probe order;
- inserting a repeated reference probe;
- exporting machine-readable observations;
- running the initial raw footprint/classifier campaign without making recommendation claims.

Do not make GQBR the recommendation policy until validation gates are reviewed.

### Phase 4 — pure policy and statistics utilities

Implement deterministic pure functions for:

- validation and normalization of adaptive config;
- footprint table construction and cell enumeration;
- hard/soft/ambiguous classification;
- the normative Bayesian threshold posterior;
- logistic/probit sensitivity;
- cell-correction residual checks;
- translating threshold samples into boundary samples;
- local monotone performance fitting;
- lexicographic decision calculation;
- performance-regret, preference-uncertainty, and winner-probability summaries;
- next-probe selection;
- stopping and fallback selection.

Use fixed generation/policy seeds and serialize all policy-defining defaults, priors, likelihoods,
and approximation details. Select one deterministic posterior approximation through simulation and
golden-trace validation; grid, Laplace, and bootstrap implementations are not interchangeable under
one `policyVersion`. If posterior work is expensive, move it off Electron's main thread.

### Phase 5 — inference validation and policy freeze

With the harness, raw data, and candidate inference implementations available:

1. run simulation-based power/coverage and prior-sensitivity comparisons;
2. choose one inference contract and freeze all policy-defining values;
3. size and run the stochastic threshold/classifier campaign;
4. evaluate held-out and leave-one-cell-out gates;
5. repeat across the proposed machine/model/runtime scopes and sessions;
6. produce the versioned validation-scope artifact and exact golden reports;
7. reject or narrow any scope that fails.

This resolves the dependency deliberately: raw evidence precedes candidate models, and the
validation artifact/golden posterior outputs are produced only after the normative inference
implementation exists.

### Phase 6 — public and internal types

Add the adaptive request, normalized methodology, progress, probe, memory-evidence, cell, threshold,
decision, validation-scope, fallback, terminal-status, and report types. Update
`src/types/index.ts` and `src/index.ts`. Retain `schemaVersion` and `policyVersion`.

### Phase 7 — adaptive manager orchestration behind an internal gate

Implement the sequential controller without switching the public default:

1. prepare identities/resources;
2. establish references;
3. select one next probe;
4. execute and record it;
5. update models and structural checks;
6. emit progress;
7. repeat until stopping;
8. directly validate the selected finalist;
9. build the schema-v2 report;
10. confirm cleanup and leave the manager stopped.

Keep the validated cell-local controller/current bounded policy available as an internal rollback.
Global transfer is enabled only when the normalized machine/model/runtime identity matches an
approved validation-scope artifact.

### Phase 8 — automated tests

Add focused tests for:

- footprint arithmetic and layer-equivalent errors;
- config validation and bounded search spaces;
- deterministic posterior/sensitivity results with golden trace outputs;
- shared versus corrected versus local threshold modes;
- equal-footprint residual checks;
- cell-local degradation envelopes;
- cached-token interpretation;
- adaptive probe choice from fixed traces;
- soft target, hard budget, and stopping rules;
- wall-time budget, finalist reserve, and every terminal status;
- preference decisions exactly around the tolerance boundary;
- direct-versus-inferred report labelling;
- winner failure followed by one-layer step-down;
- all edge regimes in this issue;
- progress monotonicity and callback/event parity;
- cancellation with partial probes;
- teardown failure and orphan blocking;
- absence of normal lifecycle events during calibration;
- later normal `start()` using the selected configuration.

Use trace-driven tests heavily so statistical policy can be verified without real model launches.

### Phase 9 — integrated live validation and sign-off

On the reference Windows CUDA/Gemma 4 12B machine:

- reproduce the archived ten-start adaptive trace;
- run the larger footprint/shared-threshold validation matrix;
- verify derived boundaries against direct held-out probes;
- verify the selected candidate and a lower-footprint fallback when one exists;
- compare calibration wall time and production score with the v0.18 bounded sweep;
- confirm no healthy server or orphan remains;
- confirm a subsequent normal start preserves the exact selected flags/profile.

Then validate conservative fallback behavior on Vulkan, Metal, CPU-only, multi-GPU, and other
available regimes. Enable scalar global transfer only for single-discrete-GPU scopes that pass
their own validation artifact; CPU-only operation never inherits the GPU threshold model.

This is the explicit sign-off gate. Review the power analysis, held-out footprint/boundary results,
classifier error bounds, prior sensitivity, validation-scope artifact, golden reports, lifecycle
evidence, and rollback behavior. Only after the user approves that evidence should `calibrate()`
select GQBR by default and remove the obsolete generated-sweep contract. A failed gate leaves the
cell-local/current policy in place; do not “fix” failed validation by widening the posterior.

### Phase 10 — documentation and release record

Update:

- README feature summary;
- `genai-electron-docs/llm-server.md`;
- `genai-electron-docs/typescript-reference.md`;
- `genai-electron-docs/troubleshooting.md`;
- migration notes;
- `PROGRESS.md`.

Document confidence as model-based, report invalidation rules, probe cost, competing GPU-work
requirements, and the meaning of independent launches.

Per the repository release workflow, implement unreleased and do not version, tag, publish, or open
a release PR until the user explicitly requests a release.

## 21. Acceptance criteria

### Structural validation

- [ ] Predicted/corrected footprint meets the held-out uncensored accuracy and boundary-index gates
      in Section 14 for every approved validation scope.
- [ ] Equal-footprint, leave-one-cell-out posterior boundary intervals are within one layer of the
      direct held-out intervals for every validated cell.
- [ ] Logistic/probit sensitivity stays within one layer or triggers a conservative warning/fallback.
- [ ] Identifiable cell-correction intervals and chronological drift satisfy the declared gates or
      disable global certification.
- [ ] Classifier false-healthy/false-memory-degraded bounds satisfy the frozen held-out gates.
- [ ] A machine-readable validation-scope artifact and golden reports decide global-policy gating.
- [ ] Unsupported backends automatically use a conservative local-search policy.

### Search correctness

- [ ] `selected` appears only with `status: 'complete'` and satisfies the requested Bayesian
      model-based risk rule.
- [ ] Every candidate with at least 5% posterior winner probability, or capable of changing an
      unresolved lexicographic preference, is directly measured at its own boundary before
      selection.
- [ ] A near-boundary winner has independent fresh-launch evidence.
- [ ] Failure of the winner causes boundary recomputation and a local step-down, not arbitrary cell
      elimination.
- [ ] Larger-context and f16 preferences are applied only within the declared tolerance.
- [ ] Non-monotone cells expand to a local race.
- [ ] If no candidate is certified, return `status: 'no-certified-candidate'` with `selected` absent.
- [ ] Budget exhaustion never exposes an uncertified provisional candidate as `selected`.

### Reporting

- [ ] Schema-v2 report distinguishes observed, globally inferred, cell-corrected, and cell-local
      evidence.
- [ ] Report contains the complete chronological probe trail and cleanup outcomes.
- [ ] Report represents the lower-footprint fallback as available/unavailable and includes its
      direct-evidence and risk-eligibility status.
- [ ] Report exposes priors/methodology, threshold sensitivity, posterior risk, winner uncertainty,
      performance regret, preference uncertainty, and per-cell structural checks.
- [ ] Report states `confidenceType: 'bayesian-model-based'` and does not imply distribution-free
      confidence.
- [ ] Report includes generation/policy seeds, timeouts, classifier rules, score unit, validation
      artifact identity, and every effective default.
- [ ] Raw prompt content remains hashed and omitted.

### Lifecycle and operations

- [ ] Calibration enforces the declared occupancy/resource preconditions, detects baseline drift
      according to policy, and leaves the normal manager stopped.
- [ ] No normal `ready`/`started`/`stopped` lifecycle events leak from probe processes.
- [ ] Abort rejects with a schema-v2 `status: 'aborted'` partial report containing completed probes.
- [ ] Every process is confirmed dead before the next probe.
- [ ] Unconfirmed cleanup blocks later lifecycle operations exactly as v0.18 does.
- [ ] Progress remains monotonic despite an adaptive probe count.
- [ ] A subsequent normal start applies the selected start configuration exactly.

### Efficiency

- [ ] Fixed golden traces that are decision-resolved by ten probes stop at or before the ten-probe
      target.
- [ ] The reference live case starts no more than `maxProbes: 15` and starts/continues no search
      work after `maxWallTimeMs: 1_800_000`, or returns `budget-exhausted` without `selected`.
- [ ] No new probe starts after either budget is exhausted; any wall-time overrun contains only
      mandatory abort/cleanup and is reported separately.
- [ ] Threshold probes use one timed sample and finalists use full samples.
- [ ] Memory-attributed degraded probes terminate with the frozen layer-conditional cap.
- [ ] On the archived reference trace, the selected configuration matches the known
      `ngl45/swaFull/q8` result; live timing differences are reported rather than used as an
      unspecified pass/fail margin.

### Quality gates

- [ ] TypeScript build passes with zero errors.
- [ ] ESLint passes with zero errors.
- [ ] Formatting and `git diff --check` pass.
- [ ] Full Jest suite passes without open handles.
- [ ] Live smoke and cleanup evidence are recorded in the implementation plan/progress log.

## 22. Risks and required cautions

1. **Model-shaped certainty:** a small Bayesian model can report precise-looking probabilities driven
   mainly by priors. Always expose sensitivity and confidence type.
2. **Footprint misspecification:** a one-layer-equivalent error can invalidate every translated
   boundary simultaneously.
3. **Censored memory:** observed used VRAM during OOM/thrash is not latent required footprint and
   must not enter ordinary residual fitting.
4. **Cell-specific workspaces:** equal estimated bytes need not imply equal degradation risk.
5. **Classifier circularity:** using timing to classify health and then fit performance can bias the
   healthy model. Ambiguous runs must remain explicit.
6. **Failure attribution:** timeouts and crashes are operational failures unless diagnostics support
   memory-threshold evidence.
7. **Adaptive overconfidence:** information-driven probing can neglect a misspecified region.
   Mandatory SWA/KV/context checks and direct finalists are safety rails.
8. **Preference-boundary noise:** distinguishing 9.9% from 10.1% slowdown may require more probes
   than the soft budget. Performance regret cannot substitute for resolving a lexicographic
   preference.
9. **Main-process load:** statistical fitting must not make Electron unresponsive.
10. **Probe cost:** intentionally degraded launches need safe timeout caps and must not leave GPU or
   process state behind.
11. **Scalar-footprint scope:** multi-GPU, unified-memory, and CPU-only regimes require separately
    validated models.
12. **Backend portability:** validate per backend/model class; never infer one CUDA/Gemma session
    applies universally.
13. **Report invalidation:** model, shards/revision, binary/backend/checksum, hardware, driver,
    runtime, profiles, workloads, policy, or footprint-model changes invalidate persisted results.

## 23. Final recommendation

Replace the current bounded generated sweep with GQBR only after footprint, classifier, inference,
and shared-threshold validation passes for the exact machine-readable scope and the user approves
the sign-off evidence. Preserve the best operational lessons from the existing downstream boundary
search:

- cell-local references and soft-degradation envelopes;
- one-sample boundary probes;
- full-sample finalists;
- direct own-boundary KV/context comparisons;
- independent fresh-start validation;
- a directly characterized lower-footprint fallback when one exists.

The intended final behavior is:

> Learn a conservative launch-level threshold in validated footprint space, derive every cell's safe
> boundary, directly race only decision-relevant finalists, and spend extra probes only on
> reproducibility or unresolved preference decisions.

If the shared-threshold premise fails, retain the adaptive controller but fall back gracefully to
cell-corrected or cell-local boundary racing. The value of adaptive search does not depend on forcing
the strongest global assumption.
