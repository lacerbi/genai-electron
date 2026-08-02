/** Pure validation, candidate-policy, and scoring helpers for LLM calibration. */

import { createHash } from 'node:crypto';

import { LLAMA_CALIBRATION_DEFAULTS } from '../config/defaults.js';
import { ServerError } from '../errors/index.js';
import type {
  KVCacheType,
  LlamaAdaptiveCalibrationConfig,
  LlamaCalibrationCombo,
  LlamaCalibrationConfig,
  LlamaCalibrationProgress,
  LlamaCalibrationFixedConfig,
  LlamaCalibrationOverrides,
  LlamaCalibrationProfile,
  LlamaCalibrationRecommendation,
  LlamaCalibrationRun,
  LlamaCalibrationWorkload,
  LlamaCalibrationWorkloadSignature,
  ResolvedLlamaCalibrationConfig,
} from '../types/index.js';
import { KV_CACHE_BYTES_PER_ELEMENT } from './kv-cache-math.js';

const OVERRIDE_KEYS = [
  'gpuLayers',
  'swaFull',
  'cacheTypeK',
  'cacheTypeV',
  'flashAttention',
  'cpuMoe',
  'nCpuMoe',
  'overrideTensors',
  'threads',
  'batchSize',
  'cacheRam',
] as const satisfies readonly (keyof LlamaCalibrationOverrides)[];

const FIXED_KEYS = [
  ...OVERRIDE_KEYS,
  'continuousBatching',
  'useMmap',
  'useMlock',
] as const satisfies readonly (keyof LlamaCalibrationFixedConfig)[];

const KV_CACHE_TYPES = new Set<KVCacheType>([
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'q5_0',
  'q5_1',
  'iq4_nl',
]);

type NormalizedWorkload = LlamaCalibrationWorkload & { weight: number };

interface ValidatedLlamaCalibrationConfigBase {
  modelId: string;
  fixedConfig: LlamaCalibrationFixedConfig;
  workloads: readonly NormalizedWorkload[];
  kvPrecisionPreferencePct: number;
  samples: number;
  seed: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  onProgress?: (progress: LlamaCalibrationProgress) => void;
  signal?: AbortSignal;
}

export interface ValidatedLlamaAdaptiveCalibrationConfig
  extends ValidatedLlamaCalibrationConfigBase {
  strategy: 'adaptive';
  profiles: LlamaAdaptiveCalibrationConfig['profiles'];
  includeKvCacheComparison: boolean;
  contextPreferencePct: number;
  targetProbes?: number;
  maxProbes?: number;
  maxWallTimeMs?: number;
}

export interface ValidatedLlamaExactCalibrationConfig extends ValidatedLlamaCalibrationConfigBase {
  strategy: 'exact';
  profile: LlamaCalibrationProfile;
  combos: readonly [LlamaCalibrationCombo, ...LlamaCalibrationCombo[]];
}

export type ValidatedLlamaCalibrationConfig =
  | ValidatedLlamaAdaptiveCalibrationConfig
  | ValidatedLlamaExactCalibrationConfig;

export interface LlamaDefaultCandidateInput {
  baseline: ResolvedLlamaCalibrationConfig;
  fixedConfig: LlamaCalibrationFixedConfig;
  totalLayers: number;
  gpuAvailable: boolean;
  slidingWindow?: number;
  hasSharedPrefixWorkload: boolean;
  exactExpertWeightsBytes?: number;
  moeCounterfactualFeasible?: boolean;
  includeKvCacheComparison: boolean;
}

export interface LlamaCandidateSet {
  combos: readonly LlamaCalibrationCombo[];
  skippedCombos: readonly { combo: LlamaCalibrationCombo; reason: string }[];
}

function invalid(message: string, details: Record<string, unknown> = {}): ServerError {
  return new ServerError(message, { code: 'CALIBRATION_INVALID_CONFIG', ...details });
}

function requirePositiveSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalid(`${path} must be a positive safe integer`, { path, value });
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(`${path} contains unsupported fields: ${unknown.join(', ')}`, { path, unknown });
  }
}

function isFlashAttentionOff(value: unknown): boolean {
  return value === false || value === 'off';
}

function validateOverrides(
  overrides: LlamaCalibrationOverrides,
  path: string,
  fixedConfig?: LlamaCalibrationFixedConfig
): void {
  validateKnownKeys(overrides as Record<string, unknown>, OVERRIDE_KEYS, path);

  if (fixedConfig) {
    const overlap = Object.keys(overrides).filter(
      (key) => fixedConfig[key as keyof LlamaCalibrationFixedConfig] !== undefined
    );
    if (overlap.length > 0) {
      throw invalid(`${path} overrides fixedConfig fields: ${overlap.join(', ')}`, {
        path,
        overlap,
      });
    }
  }

  for (const key of ['gpuLayers', 'nCpuMoe'] as const) {
    const value = overrides[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw invalid(`${path}.${key} must be a non-negative safe integer`, { path, key, value });
    }
  }
  for (const key of ['threads', 'batchSize'] as const) {
    const value = overrides[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw invalid(`${path}.${key} must be a positive safe integer`, { path, key, value });
    }
  }
  if (
    overrides.cacheRam !== undefined &&
    (!Number.isSafeInteger(overrides.cacheRam) || overrides.cacheRam < -1)
  ) {
    throw invalid(`${path}.cacheRam must be -1 or a non-negative safe integer`, {
      path,
      value: overrides.cacheRam,
    });
  }
  for (const key of ['swaFull', 'cpuMoe'] as const) {
    const value = overrides[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw invalid(`${path}.${key} must be boolean`, { path, key, value });
    }
  }
  for (const key of ['cacheTypeK', 'cacheTypeV'] as const) {
    const value = overrides[key];
    if (value !== undefined && !KV_CACHE_TYPES.has(value)) {
      throw invalid(`${path}.${key} is not a supported KV cache type`, { path, key, value });
    }
  }
  if (
    overrides.flashAttention !== undefined &&
    ![true, false, 'on', 'off', 'auto'].includes(overrides.flashAttention)
  ) {
    throw invalid(`${path}.flashAttention is invalid`, {
      path,
      value: overrides.flashAttention,
    });
  }
  if (
    overrides.overrideTensors !== undefined &&
    (typeof overrides.overrideTensors !== 'string' || overrides.overrideTensors.length === 0)
  ) {
    throw invalid(`${path}.overrideTensors must be a non-empty string`, { path });
  }

  const activeMoeAxes = [
    overrides.cpuMoe === true,
    (overrides.nCpuMoe ?? 0) > 0,
    overrides.overrideTensors !== undefined,
  ].filter(Boolean).length;
  if (activeMoeAxes > 1) {
    throw invalid(`${path} contains mutually contradictory MoE placement settings`, { path });
  }

  const quantizedV =
    overrides.cacheTypeV !== undefined &&
    overrides.cacheTypeV !== 'f16' &&
    overrides.cacheTypeV !== 'bf16';
  if (quantizedV && isFlashAttentionOff(overrides.flashAttention)) {
    throw invalid(`${path} disables flash attention with a quantized V cache`, { path });
  }
}

function validateProfile(value: unknown, path: string): LlamaCalibrationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${path} is required`, { path });
  }
  const profile = value as Record<string, unknown>;
  validateKnownKeys(profile, ['contextSize', 'parallelRequests'], path);
  requirePositiveSafeInteger(profile.contextSize, `${path}.contextSize`);
  requirePositiveSafeInteger(profile.parallelRequests, `${path}.parallelRequests`);
  if (profile.parallelRequests > profile.contextSize) {
    throw invalid(`${path}.parallelRequests cannot exceed contextSize`, { path });
  }
  return {
    contextSize: profile.contextSize,
    parallelRequests: profile.parallelRequests,
  };
}

function normalizeWorkloads(value: unknown): readonly NormalizedWorkload[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('workloads must contain at least one production scenario', { path: 'workloads' });
  }
  const ids = new Set<string>();
  return value.map((raw, index): NormalizedWorkload => {
    const path = `workloads[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalid(`${path} must be an object`, { path });
    }
    const workload = raw as LlamaCalibrationWorkload;
    if (typeof workload.id !== 'string' || workload.id.trim().length === 0) {
      throw invalid(`${path}.id must be non-empty`, { path: `${path}.id` });
    }
    if (ids.has(workload.id)) {
      throw invalid(`workload IDs must be unique: ${workload.id}`, { path: `${path}.id` });
    }
    ids.add(workload.id);
    requirePositiveSafeInteger(workload.nPredict, `${path}.nPredict`);
    if (value.length > 1 && workload.weight === undefined) {
      throw invalid(`${path}.weight is required when multiple workloads are provided`, {
        path: `${path}.weight`,
      });
    }
    const weight = workload.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw invalid(`${path}.weight must be finite and positive`, {
        path: `${path}.weight`,
        value: weight,
      });
    }
    if (workload.kind === 'cold-prefill') {
      validateKnownKeys(
        raw as Record<string, unknown>,
        ['id', 'kind', 'prompt', 'nPredict', 'weight'],
        path
      );
      if (typeof workload.prompt !== 'string' || workload.prompt.length === 0) {
        throw invalid(`${path}.prompt must be non-empty`, { path: `${path}.prompt` });
      }
      return { ...workload, weight };
    }
    if (workload.kind === 'shared-prefix') {
      validateKnownKeys(
        raw as Record<string, unknown>,
        ['id', 'kind', 'sharedPrefix', 'suffixes', 'nPredict', 'weight'],
        path
      );
      if (typeof workload.sharedPrefix !== 'string' || workload.sharedPrefix.length === 0) {
        throw invalid(`${path}.sharedPrefix must be non-empty`, { path: `${path}.sharedPrefix` });
      }
      if (
        !Array.isArray(workload.suffixes) ||
        workload.suffixes.length < 2 ||
        workload.suffixes.some((suffix: unknown) => typeof suffix !== 'string')
      ) {
        throw invalid(`${path}.suffixes must contain at least two strings`, {
          path: `${path}.suffixes`,
        });
      }
      return { ...workload, suffixes: [...workload.suffixes], weight };
    }
    throw invalid(`${path}.kind is unsupported`, { path: `${path}.kind` });
  });
}

function normalizeCombos(
  value: unknown,
  fixedConfig: LlamaCalibrationFixedConfig
): readonly [LlamaCalibrationCombo, ...LlamaCalibrationCombo[]] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('combos must be non-empty when supplied', { path: 'combos' });
  }
  const seen = new Set<string>();
  const combos = value.map((raw, index): LlamaCalibrationCombo => {
    const path = `combos[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalid(`${path} must be an object`, { path });
    }
    const combo = raw as LlamaCalibrationCombo;
    validateKnownKeys(raw as Record<string, unknown>, ['label', 'overrides'], path);
    if (!combo.overrides || typeof combo.overrides !== 'object' || Array.isArray(combo.overrides)) {
      throw invalid(`${path}.overrides is required`, { path });
    }
    if (combo.label !== undefined && (typeof combo.label !== 'string' || !combo.label.trim())) {
      throw invalid(`${path}.label must be non-empty when supplied`, { path: `${path}.label` });
    }
    validateOverrides(combo.overrides, `${path}.overrides`, fixedConfig);
    const key = canonical(combo.overrides);
    if (seen.has(key)) {
      throw invalid(`${path} duplicates an earlier normalized candidate`, { path });
    }
    seen.add(key);
    return { ...(combo.label ? { label: combo.label } : {}), overrides: { ...combo.overrides } };
  });
  return combos as unknown as readonly [LlamaCalibrationCombo, ...LlamaCalibrationCombo[]];
}

function requireFiniteNonNegative(value: unknown, path: string): asserts value is number {
  if (!Number.isFinite(value) || (value as number) < 0) {
    throw invalid(`${path} must be finite and non-negative`, { path, value });
  }
}

/** Validate and normalize a public calibration request before provisioning. */
export function validateLlamaCalibrationConfig(
  config: LlamaCalibrationConfig
): ValidatedLlamaCalibrationConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw invalid('Calibration config is required');
  }
  const raw = config as unknown as Record<string, unknown>;
  const hasProfile = Object.hasOwn(raw, 'profile');
  const hasProfiles = Object.hasOwn(raw, 'profiles');
  const hasCombos = Object.hasOwn(raw, 'combos');
  if (hasProfile && hasProfiles) {
    throw invalid('Use either profile or profiles, not both', {
      path: 'profile',
      suggestion:
        'Use profiles: [profile] for adaptive calibration or profile with combos for exact mode',
    });
  }
  if (hasProfiles && hasCombos) {
    throw invalid('Exact custom-combo mode requires singular profile, not profiles', {
      path: 'profiles',
      suggestion: 'Replace profiles with one singular profile when supplying combos',
    });
  }
  if (hasProfile && !hasCombos) {
    throw invalid('Adaptive calibration now requires profiles: [profile]', {
      path: 'profile',
      suggestion: 'Rename profile to profiles and wrap it in a one-element array',
    });
  }
  if (!hasProfile && !hasProfiles) {
    throw invalid('Adaptive mode requires profiles; exact mode requires profile and combos', {
      path: 'profiles',
    });
  }
  if (typeof raw.modelId !== 'string' || raw.modelId.trim().length === 0) {
    throw invalid('modelId must be a non-empty string', { path: 'modelId' });
  }

  const fixedConfig = { ...((raw.fixedConfig as LlamaCalibrationFixedConfig | undefined) ?? {}) };
  validateKnownKeys(fixedConfig as Record<string, unknown>, FIXED_KEYS, 'fixedConfig');
  validateOverrides(fixedConfig, 'fixedConfig');
  for (const key of ['continuousBatching', 'useMmap', 'useMlock'] as const) {
    const value = fixedConfig[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw invalid(`fixedConfig.${key} must be boolean`, { path: `fixedConfig.${key}` });
    }
  }
  const workloads = normalizeWorkloads(raw.workloads);
  const kvPrecisionPreferencePct =
    (raw.kvPrecisionPreferencePct as number | undefined) ??
    LLAMA_CALIBRATION_DEFAULTS.kvPrecisionPreferencePct;
  requireFiniteNonNegative(kvPrecisionPreferencePct, 'kvPrecisionPreferencePct');
  const samples = (raw.samples as number | undefined) ?? LLAMA_CALIBRATION_DEFAULTS.samples;
  requirePositiveSafeInteger(samples, 'samples');
  const seed = (raw.seed as number | undefined) ?? LLAMA_CALIBRATION_DEFAULTS.seed;
  if (!Number.isSafeInteger(seed)) {
    throw invalid('seed must be a safe integer', { path: 'seed', value: seed });
  }
  const startupTimeoutMs =
    (raw.startupTimeoutMs as number | undefined) ?? LLAMA_CALIBRATION_DEFAULTS.startupTimeoutMs;
  const requestTimeoutMs =
    (raw.requestTimeoutMs as number | undefined) ?? LLAMA_CALIBRATION_DEFAULTS.requestTimeoutMs;
  requirePositiveSafeInteger(startupTimeoutMs, 'startupTimeoutMs');
  requirePositiveSafeInteger(requestTimeoutMs, 'requestTimeoutMs');
  if (raw.onProgress !== undefined && typeof raw.onProgress !== 'function') {
    throw invalid('onProgress must be a function', { path: 'onProgress' });
  }

  const common = {
    modelId: raw.modelId,
    fixedConfig,
    workloads,
    kvPrecisionPreferencePct,
    samples,
    seed,
    startupTimeoutMs,
    requestTimeoutMs,
    onProgress: raw.onProgress as ((progress: LlamaCalibrationProgress) => void) | undefined,
    signal: raw.signal as AbortSignal | undefined,
  };

  if (hasProfile) {
    for (const field of [
      'includeKvCacheComparison',
      'contextPreferencePct',
      'targetProbes',
      'maxProbes',
      'maxWallTimeMs',
    ]) {
      if (raw[field] !== undefined) {
        throw invalid(`${field} is adaptive-only and cannot be used with exact combos`, {
          path: field,
        });
      }
    }
    const profile = validateProfile(raw.profile, 'profile');
    const combos = normalizeCombos(raw.combos, fixedConfig);
    return { strategy: 'exact', ...common, profile, combos };
  }

  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > 2) {
    throw invalid('profiles must contain one or two profiles', { path: 'profiles' });
  }
  const profiles = raw.profiles.map((profile, index) =>
    validateProfile(profile, `profiles[${index}]`)
  );
  if (new Set(profiles.map((profile) => profile.contextSize)).size !== profiles.length) {
    throw invalid('adaptive profile contextSize values must be unique', { path: 'profiles' });
  }
  if (new Set(profiles.map((profile) => profile.parallelRequests)).size !== 1) {
    throw invalid('adaptive profiles must use the same parallelRequests value', {
      path: 'profiles',
    });
  }
  const includeKvCacheComparison =
    (raw.includeKvCacheComparison as boolean | undefined) ??
    LLAMA_CALIBRATION_DEFAULTS.includeKvCacheComparison;
  if (typeof includeKvCacheComparison !== 'boolean') {
    throw invalid('includeKvCacheComparison must be boolean', { path: 'includeKvCacheComparison' });
  }
  if (
    includeKvCacheComparison &&
    (fixedConfig.cacheTypeK !== undefined ||
      fixedConfig.cacheTypeV !== undefined ||
      fixedConfig.flashAttention !== undefined)
  ) {
    throw invalid('includeKvCacheComparison cannot vary KV/FA fields pinned by fixedConfig', {
      path: 'includeKvCacheComparison',
    });
  }
  const contextPreferencePct =
    (raw.contextPreferencePct as number | undefined) ??
    (LLAMA_CALIBRATION_DEFAULTS as { contextPreferencePct?: number }).contextPreferencePct ??
    10;
  requireFiniteNonNegative(contextPreferencePct, 'contextPreferencePct');
  const targetProbes = raw.targetProbes as number | undefined;
  const maxProbes = raw.maxProbes as number | undefined;
  const maxWallTimeMs = raw.maxWallTimeMs as number | undefined;
  if (targetProbes !== undefined) requirePositiveSafeInteger(targetProbes, 'targetProbes');
  if (maxProbes !== undefined) requirePositiveSafeInteger(maxProbes, 'maxProbes');
  if (maxWallTimeMs !== undefined) requirePositiveSafeInteger(maxWallTimeMs, 'maxWallTimeMs');
  if (targetProbes !== undefined && maxProbes !== undefined && targetProbes > maxProbes) {
    throw invalid('targetProbes cannot exceed maxProbes', { path: 'targetProbes' });
  }
  if (maxProbes !== undefined && maxProbes <= 2) {
    throw invalid('maxProbes must leave room for the finalist reserve', { path: 'maxProbes' });
  }

  return {
    strategy: 'adaptive',
    ...common,
    profiles: profiles as unknown as LlamaAdaptiveCalibrationConfig['profiles'],
    includeKvCacheComparison,
    contextPreferencePct,
    targetProbes,
    maxProbes,
    maxWallTimeMs,
  };
}

/** Merge one exact profile, fixed config, and candidate into a start-ready fragment. */
export function resolveLlamaCalibrationConfig(
  profile: LlamaCalibrationProfile,
  fixedConfig: LlamaCalibrationFixedConfig,
  overrides: LlamaCalibrationOverrides
): ResolvedLlamaCalibrationConfig {
  return { ...profile, ...fixedConfig, ...overrides };
}

export function extractLlamaCalibrationOverrides(
  baseline: ResolvedLlamaCalibrationConfig,
  fixedConfig: LlamaCalibrationFixedConfig
): LlamaCalibrationOverrides {
  const result: LlamaCalibrationOverrides = {};
  for (const key of OVERRIDE_KEYS) {
    if (fixedConfig[key] === undefined && baseline[key] !== undefined) {
      (result as Record<string, unknown>)[key] = baseline[key];
    }
  }
  return result;
}

/** Build the bounded, non-Cartesian default candidate set. */
export function generateDefaultLlamaCalibrationCombos(
  input: LlamaDefaultCandidateInput
): LlamaCandidateSet {
  requirePositiveSafeInteger(input.totalLayers, 'totalLayers');
  const base = extractLlamaCalibrationOverrides(input.baseline, input.fixedConfig);
  const baselineLayers = input.gpuAvailable ? (input.baseline.gpuLayers ?? 0) : 0;
  const step = Math.max(2, Math.ceil(input.totalLayers * 0.1));
  const anchors =
    input.fixedConfig.gpuLayers !== undefined
      ? [input.fixedConfig.gpuLayers]
      : input.gpuAvailable
        ? [
            baselineLayers,
            Math.max(0, baselineLayers - step),
            Math.min(input.totalLayers, baselineLayers + step),
            input.totalLayers,
          ]
        : [0];
  const labels = ['baseline', 'headroom', 'aggressive', 'full-gpu'];
  const attempted: LlamaCalibrationCombo[] = [];
  const swaRelevant =
    input.fixedConfig.swaFull === undefined &&
    input.slidingWindow !== undefined &&
    input.hasSharedPrefixWorkload &&
    Math.floor(input.baseline.contextSize / input.baseline.parallelRequests) > input.slidingWindow;

  anchors.forEach((gpuLayers, index) => {
    const anchor = {
      ...base,
      ...(input.fixedConfig.gpuLayers === undefined ? { gpuLayers } : {}),
    };
    const label = input.fixedConfig.gpuLayers !== undefined ? 'baseline' : (labels[index] ?? 'gpu');
    if (swaRelevant) {
      attempted.push(
        { label: `${label}-swa-window`, overrides: { ...anchor, swaFull: false } },
        { label: `${label}-swa-full`, overrides: { ...anchor, swaFull: true } }
      );
    } else {
      attempted.push({ label, overrides: anchor });
    }
  });

  const moeAxisFixed = ['cpuMoe', 'nCpuMoe', 'overrideTensors'].some(
    (key) => input.fixedConfig[key as keyof LlamaCalibrationFixedConfig] !== undefined
  );
  const baselineHasAlternateMoeAxis =
    (input.baseline.nCpuMoe ?? 0) > 0 || input.baseline.overrideTensors !== undefined;
  if (
    input.exactExpertWeightsBytes !== undefined &&
    input.exactExpertWeightsBytes > 0 &&
    input.moeCounterfactualFeasible !== false &&
    !moeAxisFixed &&
    !baselineHasAlternateMoeAxis
  ) {
    attempted.push({
      label: input.baseline.cpuMoe === true ? 'moe-gpu' : 'moe-cpu',
      overrides: {
        ...base,
        ...(input.fixedConfig.gpuLayers === undefined ? { gpuLayers: baselineLayers } : {}),
        cpuMoe: input.baseline.cpuMoe !== true,
      },
    });
  }

  if (input.includeKvCacheComparison) {
    const baselineK = input.baseline.cacheTypeK ?? 'f16';
    const baselineV = input.baseline.cacheTypeV ?? 'f16';
    const baselineIsQ8 = baselineK === 'q8_0' && baselineV === 'q8_0';
    attempted.push({
      label: baselineIsQ8 ? 'kv-f16' : 'kv-q8',
      overrides: {
        ...base,
        ...(input.fixedConfig.gpuLayers === undefined ? { gpuLayers: baselineLayers } : {}),
        cacheTypeK: baselineIsQ8 ? 'f16' : 'q8_0',
        cacheTypeV: baselineIsQ8 ? 'f16' : 'q8_0',
        ...(baselineIsQ8 ? {} : { flashAttention: 'on' }),
      },
    });
  }

  const combos: LlamaCalibrationCombo[] = [];
  const skippedCombos: { combo: LlamaCalibrationCombo; reason: string }[] = [];
  const seen = new Set<string>();
  for (const combo of attempted) {
    const key = canonical(combo.overrides);
    if (seen.has(key)) {
      skippedCombos.push({ combo, reason: 'duplicate-resolved-config' });
      continue;
    }
    seen.add(key);
    if (combos.length >= LLAMA_CALIBRATION_DEFAULTS.maxCandidates) {
      skippedCombos.push({ combo, reason: 'candidate-cap' });
      continue;
    }
    combos.push(combo);
  }
  return { combos, skippedCombos };
}

/** Median of a non-empty finite numeric collection. */
export function median(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw invalid('median requires at least one finite value');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Weighted scenario score. Weights are normalized internally. */
export function weightedCalibrationScore(
  results: readonly { weight: number; medianWallTimeMs?: number }[]
): number | undefined {
  if (
    results.length === 0 ||
    results.some(
      (result) =>
        !Number.isFinite(result.weight) ||
        result.weight <= 0 ||
        result.medianWallTimeMs === undefined ||
        !Number.isFinite(result.medianWallTimeMs)
    )
  ) {
    return undefined;
  }
  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  return results.reduce(
    (sum, result) => sum + (result.weight / totalWeight) * result.medianWallTimeMs!,
    0
  );
}

function kvFootprint(config: ResolvedLlamaCalibrationConfig): number {
  const keyType = config.cacheTypeK ?? 'f16';
  const valueType = config.cacheTypeV ?? 'f16';
  return KV_CACHE_BYTES_PER_ELEMENT[keyType] + KV_CACHE_BYTES_PER_ELEMENT[valueType];
}

/** Apply precision preference, robustness tolerance, simplicity, then stable order. */
export function recommendLlamaCalibrationRun(
  runs: readonly LlamaCalibrationRun[],
  kvPrecisionPreferencePct: number,
  tieTolerancePct = LLAMA_CALIBRATION_DEFAULTS.tieTolerancePct
): LlamaCalibrationRecommendation | undefined {
  const eligible = runs
    .map((run, index) => ({ run, index }))
    .filter(
      (entry): entry is { run: LlamaCalibrationRun & { scoreMs: number }; index: number } =>
        entry.run.status === 'ok' &&
        entry.run.scoreMs !== undefined &&
        Number.isFinite(entry.run.scoreMs)
    );
  if (eligible.length === 0) {
    return undefined;
  }
  const fastest = Math.min(...eligible.map(({ run }) => run.scoreMs));
  const precisionWindow = fastest * (1 + kvPrecisionPreferencePct / 100);
  const precisionEligible = eligible.filter(({ run }) => run.scoreMs <= precisionWindow);
  const selectedFootprint = Math.max(
    ...precisionEligible.map(({ run }) => kvFootprint(run.resolvedConfig))
  );
  const samePrecision = precisionEligible.filter(
    ({ run }) => Math.abs(kvFootprint(run.resolvedConfig) - selectedFootprint) < 1e-12
  );
  const samePrecisionFastest = Math.min(...samePrecision.map(({ run }) => run.scoreMs));
  const robust = samePrecision.filter(
    ({ run }) => run.scoreMs <= samePrecisionFastest * (1 + tieTolerancePct / 100)
  );
  robust.sort((a, b) => {
    const explicitDifference =
      Object.keys(a.run.combo.overrides).length - Object.keys(b.run.combo.overrides).length;
    return explicitDifference || a.index - b.index;
  });
  const selected = robust[0]!.run;
  return {
    combo: selected.combo,
    startConfig: selected.resolvedConfig,
    scoreMs: selected.scoreMs,
  };
}

/** Hash workload content without retaining it in the report. */
export function workloadSignature(workload: NormalizedWorkload): LlamaCalibrationWorkloadSignature {
  const payload =
    workload.kind === 'cold-prefill'
      ? { kind: workload.kind, prompt: workload.prompt, nPredict: workload.nPredict }
      : {
          kind: workload.kind,
          sharedPrefix: workload.sharedPrefix,
          suffixes: workload.suffixes,
          nPredict: workload.nPredict,
        };
  return {
    id: workload.id,
    kind: workload.kind,
    weight: workload.weight,
    hash: createHash('sha256').update(canonical(payload)).digest('hex'),
    requestCount: workload.kind === 'cold-prefill' ? 1 : workload.suffixes.length,
    nPredict: workload.nPredict,
  };
}
