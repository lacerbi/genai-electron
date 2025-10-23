import React, { useState } from 'react';
import './DebugPanel.css';

/**
 * Debug Panel Component
 *
 * Provides buttons to display diagnostic information in the UI.
 * Useful for debugging resource orchestration and config issues.
 */
export function DebugPanel() {
  const [loading, setLoading] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');

  const formatLLMConfig = (data: any): string => {
    const { config, info } = data;
    let result = '=== LLM Server Config ===\n';
    result += `Status: ${info.status}\n`;
    if (config) {
      result += `Model ID: ${config.modelId}\n`;
      result += `Port: ${config.port}\n`;
      result += `GPU Layers: ${config.gpuLayers}\n`;
      result += `Threads: ${config.threads}\n`;
      result += `Context Size: ${config.contextSize}\n`;
      result += `Parallel Requests: ${config.parallelRequests}\n`;
      result += `Flash Attention: ${config.flashAttention}\n`;
    } else {
      result += 'No config (server not started)\n';
    }
    result += '=========================';
    return result;
  };

  const formatSystemCapabilities = (capabilities: any): string => {
    let result = '=== System Capabilities ===\n';
    result += `CPU Cores: ${capabilities.cpu.cores}\n`;
    result += `CPU Model: ${capabilities.cpu.model}\n`;
    result += `Architecture: ${capabilities.cpu.architecture}\n`;
    result += `Total RAM: ${(capabilities.memory.total / 1024 ** 3).toFixed(2)} GB\n`;
    result += `Available RAM: ${(capabilities.memory.available / 1024 ** 3).toFixed(2)} GB\n`;
    result += `GPU Available: ${capabilities.gpu.available}\n`;
    if (capabilities.gpu.available) {
      result += `GPU Type: ${capabilities.gpu.type}\n`;
      result += `GPU Name: ${capabilities.gpu.name}\n`;
      if (capabilities.gpu.vram) {
        result += `VRAM: ${(capabilities.gpu.vram / 1024 ** 3).toFixed(2)} GB\n`;
      }
      result += `CUDA: ${capabilities.gpu.cuda || false}\n`;
      result += `Metal: ${capabilities.gpu.metal || false}\n`;
      result += `Vulkan: ${capabilities.gpu.vulkan || false}\n`;
    }
    result += '===========================';
    return result;
  };

  const formatOptimalConfig = (data: any): string => {
    const { modelInfo, optimalConfig } = data;
    let result = `=== Optimal Config for ${modelInfo.name} ===\n`;
    result += `Model Size: ${(modelInfo.size / 1024 ** 3).toFixed(2)} GB\n`;
    result += `Recommended Threads: ${optimalConfig.threads}\n`;
    result += `Recommended GPU Layers: ${optimalConfig.gpuLayers}\n`;
    result += `Recommended Context Size: ${optimalConfig.contextSize}\n`;
    result += `Recommended Parallel Requests: ${optimalConfig.parallelRequests}\n`;
    result += `Flash Attention: ${optimalConfig.flashAttention}\n`;
    result += '===============================';
    return result;
  };

  const formatResourceEstimates = (data: any): string => {
    return (
      '=== Resource Estimates ===\n' +
      'See terminal console for detailed output\n' +
      '(Too complex to format in UI)\n' +
      '=========================='
    );
  };

  const handlePrintLLMConfig = async () => {
    setLoading('llm');
    try {
      const data = await window.api.debug.getLLMConfig();
      setOutput(formatLLMConfig(data));
    } catch (error) {
      setOutput(`❌ Error: ${(error as Error).message}`);
    } finally {
      setLoading(null);
    }
  };

  const handlePrintSystemCapabilities = async () => {
    setLoading('system');
    try {
      const capabilities = await window.api.debug.getSystemCapabilities();
      setOutput(formatSystemCapabilities(capabilities));
    } catch (error) {
      setOutput(`❌ Error: ${(error as Error).message}`);
    } finally {
      setLoading(null);
    }
  };

  const handlePrintOptimalConfig = async () => {
    setLoading('optimal');
    try {
      // Get current LLM model ID
      const status: any = await window.api.server.status();
      if (status.modelId) {
        const data = await window.api.debug.getOptimalConfig(status.modelId);
        setOutput(formatOptimalConfig(data));
      } else {
        setOutput('⚠️  No LLM server running - start server first');
      }
    } catch (error) {
      setOutput(`❌ Error: ${(error as Error).message}`);
    } finally {
      setLoading(null);
    }
  };

  const handlePrintResourceEstimates = async () => {
    setLoading('resources');
    try {
      const data = await window.api.debug.getResourceEstimates();
      setOutput(formatResourceEstimates(data));
    } catch (error) {
      setOutput(`❌ Error: ${(error as Error).message}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <h3>Debug Tools</h3>
        <p className="debug-subtitle">Print diagnostic info to terminal console</p>
      </div>

      <div className="debug-buttons">
        <button
          className="debug-button"
          onClick={handlePrintLLMConfig}
          disabled={loading === 'llm'}
        >
          {loading === 'llm' ? 'Printing...' : 'Print LLM Config'}
        </button>

        <button
          className="debug-button"
          onClick={handlePrintSystemCapabilities}
          disabled={loading === 'system'}
        >
          {loading === 'system' ? 'Printing...' : 'Print System Capabilities'}
        </button>

        <button
          className="debug-button"
          onClick={handlePrintOptimalConfig}
          disabled={loading === 'optimal'}
        >
          {loading === 'optimal' ? 'Printing...' : 'Print Optimal Config'}
        </button>

        <button
          className="debug-button"
          onClick={handlePrintResourceEstimates}
          disabled={loading === 'resources'}
        >
          {loading === 'resources' ? 'Printing...' : 'Print Resource Estimates'}
        </button>
      </div>

      {output && (
        <div className="debug-output">
          <div className="debug-output-header">
            <h4>Output</h4>
            <button className="clear-button" onClick={() => setOutput('')}>
              Clear
            </button>
          </div>
          <pre className="debug-output-content">{output}</pre>
        </div>
      )}

      <div className="debug-note">
        <strong>Note:</strong> Full details also logged to terminal console
      </div>
    </div>
  );
}
