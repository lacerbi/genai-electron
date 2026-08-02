import {
  applyAdaptivePolicyObservation,
  createAdaptivePolicyState,
  nextAdaptivePolicyAction,
  type AdaptiveBoundaryDecision,
  type AdaptiveFidelity,
  type AdaptivePolicyAction,
  type AdaptivePolicyConfig,
  type AdaptivePolicyState,
  type AdaptiveProbeObservation,
  type AdaptiveProbePurpose,
  type AdaptiveTerminalAction,
} from '../../src/utils/llama-adaptive-calibration-policy.js';

export type AdaptiveTraceResult = 'ok' | 'confirmed-oom' | 'timeout' | 'crash' | 'cap';

/**
 * One readable chronological row:
 * `[cell, layers, purpose, fidelity, result, score-or-lower-bound, expected decision]`.
 */
export type AdaptiveTraceRow = readonly [
  cell: string,
  gpuLayers: number,
  purpose: AdaptiveProbePurpose,
  fidelity: AdaptiveFidelity,
  result: AdaptiveTraceResult,
  metric: number | undefined,
  decision: AdaptiveBoundaryDecision,
];

export interface AdaptiveTraceFixture {
  name: string;
  config: AdaptivePolicyConfig;
  rows: readonly AdaptiveTraceRow[];
}

export interface AdaptiveTraceExecution {
  state: AdaptivePolicyState;
  actions: readonly AdaptivePolicyAction[];
  terminal: AdaptiveTerminalAction;
}

export function defineAdaptiveTrace(
  name: string,
  config: AdaptivePolicyConfig,
  rows: readonly AdaptiveTraceRow[]
): AdaptiveTraceFixture {
  return { name, config, rows };
}

export function traceCell(contextSize: number, swa: 'window' | 'full', kv: 'q8_0' | 'f16'): string {
  return `${contextSize}/${swa}/${kv}`;
}

function actionCellLabel(state: AdaptivePolicyState, cellId: string): string {
  const cell = state.cells.find((item) => item.id === cellId);
  if (!cell) throw new Error(`trace action references unknown cell ${cellId}`);
  return traceCell(cell.contextSize, cell.swaFull ? 'full' : 'window', cell.kvPrecision);
}

function observationFromRow(
  action: Extract<AdaptivePolicyAction, { kind: 'probe' }>,
  row: AdaptiveTraceRow
): AdaptiveProbeObservation {
  const [, , , , result, metric] = row;
  const common = {
    cellId: action.cellId,
    gpuLayers: action.gpuLayers,
    purpose: action.purpose,
    fidelity: action.fidelity,
    durationMs: 1,
  } as const;
  switch (result) {
    case 'ok':
      return {
        ...common,
        operationalStatus: 'ok',
        memoryEvidence: 'none',
        scoreMs: metric,
      };
    case 'confirmed-oom':
      return { ...common, operationalStatus: 'oom', memoryEvidence: 'confirmed' };
    case 'timeout':
      return { ...common, operationalStatus: 'request-timeout', memoryEvidence: 'unknown' };
    case 'crash':
      return { ...common, operationalStatus: 'crashed', memoryEvidence: 'unknown' };
    case 'cap':
      return {
        ...common,
        operationalStatus: 'request-timeout',
        memoryEvidence: 'none',
        terminatedAtAdaptiveCap: true,
        aggregateLowerBoundMs: metric,
      };
  }
}

export function executeAdaptiveTrace(fixture: AdaptiveTraceFixture): AdaptiveTraceExecution {
  let state = createAdaptivePolicyState(fixture.config);
  const actions: AdaptivePolicyAction[] = [];
  for (let index = 0; index < fixture.rows.length; index++) {
    const row = fixture.rows[index]!;
    const action = nextAdaptivePolicyAction(state);
    actions.push(action);
    if (action.kind !== 'probe') {
      throw new Error(`${fixture.name} row ${index} expected a probe but reached ${action.status}`);
    }
    const actualCell = actionCellLabel(state, action.cellId);
    const [cell, gpuLayers, purpose, fidelity, , , expectedDecision] = row;
    if (
      actualCell !== cell ||
      action.gpuLayers !== gpuLayers ||
      action.purpose !== purpose ||
      action.fidelity !== fidelity
    ) {
      throw new Error(
        `${fixture.name} row ${index}: expected ${cell}@${gpuLayers}:${purpose}:${fidelity}, got ${actualCell}@${action.gpuLayers}:${action.purpose}:${action.fidelity}`
      );
    }
    state = applyAdaptivePolicyObservation(state, observationFromRow(action, row));
    const evidence = state.evidence.at(-1)!;
    if (evidence.boundaryDecision !== expectedDecision) {
      throw new Error(
        `${fixture.name} row ${index}: expected ${expectedDecision}, got ${evidence.boundaryDecision} (${evidence.decisionReason})`
      );
    }
  }
  const terminal = nextAdaptivePolicyAction(state);
  actions.push(terminal);
  if (terminal.kind !== 'terminal') {
    throw new Error(
      `${fixture.name} ended before action ${actionCellLabel(state, terminal.cellId)}@${terminal.gpuLayers}:${terminal.purpose}`
    );
  }
  return { state, actions, terminal };
}
