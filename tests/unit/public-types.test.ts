import { describe, expect, it } from '@jest/globals';
import type {
  ContextConstraintDetails,
  ContextConstraintError,
  ContextConstraintReason,
  ContextConstraintStage,
  InsufficientResourcesDetails,
  LlamaServerReadyState,
  LlamaCalibrationConfig,
  LlamaCalibrationReport,
  OptimalConfigHints,
  ServerEvent,
  ServerInfo,
} from '../../src/index.js';

describe('public context-capacity types', () => {
  it('are consumable through the package root', () => {
    const reason: ContextConstraintReason = 'runtime-below-minimum';
    const stage: ContextConstraintStage = 'runtime';
    const details: ContextConstraintDetails = {
      reason,
      stage,
      minimumContextSize: 4096,
      preferredContextSize: 6144,
      configuredContextSize: 8192,
      effectiveContextSize: 2048,
      parallelRequests: 2,
      effectiveParallelRequests: 2,
    };
    const hints: OptimalConfigHints = {
      minimumContextSize: 4096,
      preferredContextSize: 6144,
      maximumContextSize: 8192,
      parallelRequests: 2,
    };
    const info: Pick<ServerInfo, 'configuredContextSize' | 'effectiveContextSize'> = {
      configuredContextSize: 8192,
      effectiveContextSize: 4096,
    };
    const ready: LlamaServerReadyState = {
      serverGeneration: 1,
      modelId: 'test-model',
      port: 8080,
      configuredContextSize: 8192,
      effectiveContextSize: 4096,
      effectiveParallelRequests: 2,
      startedAt: '2026-07-29T12:00:00.000Z',
    };
    const readyEvent: ServerEvent = 'ready';
    const resources: InsufficientResourcesDetails = {
      required: '4096 tokens per slot',
      available: '2048 tokens per slot',
      minimumContextSize: 4096,
      preferredContextSize: 6144,
      maxFeasibleContextSize: 2048,
    };
    const errorTypeCheck = (error: ContextConstraintError): ContextConstraintDetails =>
      error.details;
    const calibration: LlamaCalibrationConfig = {
      modelId: 'test-model',
      profile: { contextSize: 12_288, parallelRequests: 2 },
      workloads: [{ id: 'chat', kind: 'cold-prefill', prompt: 'hello', nPredict: 32 }],
      fixedConfig: { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' },
    };
    const reportTypeCheck = (report: LlamaCalibrationReport) => report.recommended?.startConfig;

    expect({
      details,
      hints,
      info,
      ready,
      readyEvent,
      resources,
      errorTypeCheck,
      calibration,
      reportTypeCheck,
    }).toBeDefined();
  });
});
