import React, { useState } from 'react';
import './DebugPanel.css';

/**
 * Debug Panel Component
 *
 * Provides buttons to print diagnostic information to console.
 * Useful for debugging resource orchestration and config issues.
 */
export function DebugPanel() {
  const [loading, setLoading] = useState<string | null>(null);

  const handlePrintLLMConfig = async () => {
    setLoading('llm');
    try {
      await window.api.debug.getLLMConfig();
      console.log('✅ LLM config printed to console');
    } catch (error) {
      console.error('❌ Failed to get LLM config:', error);
    } finally {
      setLoading(null);
    }
  };

  const handlePrintSystemCapabilities = async () => {
    setLoading('system');
    try {
      await window.api.debug.getSystemCapabilities();
      console.log('✅ System capabilities printed to console');
    } catch (error) {
      console.error('❌ Failed to get system capabilities:', error);
    } finally {
      setLoading(null);
    }
  };

  const handlePrintOptimalConfig = async () => {
    setLoading('optimal');
    try {
      // Get current LLM model ID
      const status = await window.api.server.status();
      if (status.modelId) {
        await window.api.debug.getOptimalConfig(status.modelId);
        console.log('✅ Optimal config printed to console');
      } else {
        console.warn('⚠️  No LLM server running - start server first');
      }
    } catch (error) {
      console.error('❌ Failed to get optimal config:', error);
    } finally {
      setLoading(null);
    }
  };

  const handlePrintResourceEstimates = async () => {
    setLoading('resources');
    try {
      await window.api.debug.getResourceEstimates();
      console.log('✅ Resource estimates printed to console');
    } catch (error) {
      console.error('❌ Failed to get resource estimates:', error);
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

      <div className="debug-note">
        <strong>Note:</strong> Output appears in the terminal where you ran <code>npm run dev</code>
      </div>
    </div>
  );
}
