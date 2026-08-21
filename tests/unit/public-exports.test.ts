/**
 * Root export-surface guard
 *
 * `public-types.test.ts` deliberately never imports a VALUE from `src/index.ts`, so that it
 * can stay free of the Electron runtime. This suite covers the other half: with `electron`
 * mocked the way the diffusion suites mock it, the package root is really imported and the
 * named value exports the documentation promises are asserted to exist.
 *
 * A rename or a dropped re-export in `src/index.ts` fails here instead of in a host app.
 */

import { jest } from '@jest/globals';
import type {
  DiffusionBackendInfo,
  DiffusionBackendReleaseReason,
  DiffusionBackendState,
  DiffusionBackendStatusEvent,
  DiffusionUsageMode,
  LlamaPreStartHook,
} from '../../src/index.js';

// The root pulls in config/paths.ts, which reads app.getPath('userData') at import time.
jest.unstable_mockModule('electron', () => ({
  app: {
    getPath: jest.fn((name: string) => (name === 'userData' ? '/test/userData' : '/test')),
  },
}));

const rootExports = await import('../../src/index.js');

describe('package root value exports', () => {
  it('exports the diffusion backend and calibration defaults', () => {
    expect(rootExports.DIFFUSION_BACKEND_DEFAULTS).toBeDefined();
    expect(rootExports.DIFFUSION_BACKEND_DEFAULTS.idleTimeoutMs).toBe(300_000);
    expect(rootExports.DIFFUSION_BACKEND_DEFAULTS.jobRequestTimeoutMs).toBe(10_000);
    expect(rootExports.DIFFUSION_BACKEND_DEFAULTS.maxTransientPollFailures).toBe(3);

    expect(rootExports.DIFFUSION_CALIBRATION_DEFAULTS).toBeDefined();
    expect(rootExports.DIFFUSION_CALIBRATION_DEFAULTS.usageMode).toBe('single');
    expect(rootExports.DIFFUSION_CALIBRATION_DEFAULTS.policyVersion).toBe('diffusion-offload-v2');
  });

  it('exports the pre-instantiated managers and the orchestrator class', () => {
    expect(rootExports.diffusionServer).toBeDefined();
    expect(rootExports.llamaServer).toBeDefined();
    expect(typeof rootExports.ResourceOrchestrator).toBe('function');

    // The singletons are wired to each other, which is what makes the built-in
    // orchestration (deferred reloads, the LLM pre-start hook) work at all.
    expect(typeof rootExports.diffusionServer.releaseBackend).toBe('function');
    expect(typeof rootExports.diffusionServer.getBackendInfo).toBe('function');
    expect(typeof rootExports.llamaServer.registerPreStartHook).toBe('function');
  });
});

describe('package root type exports', () => {
  it('re-exports the diffusion residency and pre-start-hook types', () => {
    const state: DiffusionBackendState = 'stopping';
    const reason: DiffusionBackendReleaseReason = 'llm-start';
    const mode: DiffusionUsageMode = 'burst';
    const info: DiffusionBackendInfo = { state: 'ready', pid: 4242 };
    const event: DiffusionBackendStatusEvent = {
      state: 'absent',
      previous: 'ready',
      reason: 'idle-timeout',
    };
    const hook: LlamaPreStartHook = ({ config, reason: startReason }) => {
      void config.modelId;
      void startReason;
    };

    expect({ state, reason, mode, info, event, hook }).toBeDefined();
    expect(info.state).toBe('ready');
    expect(event.previous).toBe('ready');
    expect(typeof hook).toBe('function');
  });
});
