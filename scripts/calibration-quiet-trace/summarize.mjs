/** Pure schema-v4 summary helpers shared by the Electron harness and Node-only checks. */

function summarizeRecommendation(recommendation) {
  if (!recommendation) return undefined;
  return {
    profileIndex: recommendation.profileIndex,
    cellId: recommendation.cellId,
    scoreMs: recommendation.scoreMs,
    gpuLayers: recommendation.startConfig?.gpuLayers,
    contextSize: recommendation.startConfig?.contextSize,
    evidence: recommendation.evidence,
  };
}

export function summarizeReport(report) {
  if (!report) return undefined;
  return {
    resultKind: report.resultKind,
    schemaVersion: report.schemaVersion,
    policyVersion: report.policyVersion,
    strategy: report.strategy,
    status: report.status,
    terminalReason: report.terminalReason,
    createdAt: report.createdAt,
    probeCount: report.probes.length,
    warnings: report.warnings,
    // Ordinary schema-v4 reports retain the run's one fixed baseline per metric. The preparation
    // limit intentionally has no monitoring record because that baseline did not exist yet.
    resourceMonitoring: report.resourceMonitoring,
    searchCompleteness: report.searchCompleteness,
    budget: report.budget,
    selected: summarizeRecommendation(report.selected),
    fallback: summarizeRecommendation(report.fallback),
    selectionEvidence: report.selectionEvidence,
    ...(report.resultKind === 'report' && report.strategy === 'exact'
      ? { confidence: report.confidence }
      : {}),
    probes: report.probes.map((probe) => ({
      probeIndex: probe.probeIndex,
      purpose: probe.purpose,
      fidelity: probe.fidelity,
      cellId: probe.cellId,
      profileIndex: probe.profileIndex,
      gpuLayers: probe.resolvedConfig?.gpuLayers,
      contextSize: probe.resolvedConfig?.contextSize,
      operationalStatus: probe.operationalStatus,
      boundaryDecision: probe.boundaryDecision,
      memoryEvidence: probe.memoryEvidence,
      scoreMs: probe.scoreMs,
      durationMs: probe.durationMs,
      resourceValidity: probe.resourceValidity,
      cleanupConfirmed: probe.cleanup?.confirmed,
      resourceBoundaries: probe.resourceBoundaries,
      diagnostics: probe.diagnostics
        ? {
            kvBytesEstimate: probe.diagnostics.kvBytesEstimate,
            warnings: probe.diagnostics.warnings,
          }
        : undefined,
    })),
  };
}

export function summarizePartialReport(partial) {
  if (!partial || typeof partial !== 'object') return undefined;
  return {
    schemaVersion: partial.schemaVersion,
    strategy: partial.strategy,
    status: partial.status,
    probeCount: Array.isArray(partial.probes) ? partial.probes.length : undefined,
    warnings: partial.warnings,
    cleanupConfirmed: partial.cleanupConfirmed,
    resourceMonitoring: partial.resourceMonitoring,
    resourceFailure: partial.resourceFailure,
    budget: partial.budget,
    searchCompleteness: partial.searchCompleteness,
    bestKnown: partial.bestKnown
      ? {
          recommendation: summarizeRecommendation(partial.bestKnown.recommendation),
          evidence: partial.bestKnown.evidence,
          sourceProbeIndexes: partial.bestKnown.sourceProbeIndexes,
        }
      : undefined,
    probes: (partial.probes ?? []).map((probe) => ({
      probeIndex: probe.probeIndex,
      purpose: probe.purpose,
      gpuLayers: probe.resolvedConfig?.gpuLayers,
      operationalStatus: probe.operationalStatus,
      boundaryDecision: probe.boundaryDecision,
      resourceValidity: probe.resourceValidity,
      terminationReason: probe.terminationReason,
      cleanupConfirmed: probe.cleanup?.confirmed,
    })),
  };
}
