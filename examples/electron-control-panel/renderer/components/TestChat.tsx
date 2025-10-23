import React, { useState, useEffect, useRef } from 'react';
import ActionButton from './common/ActionButton';
import Spinner from './common/Spinner';
import './TestChat.css';

interface TestChatProps {
  serverRunning: boolean;
  port?: number;
}

const TestChat: React.FC<TestChatProps> = ({ serverRunning }) => {
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState('');
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);

  // Configurable settings (higher defaults for thinking models)
  const [maxTokens, setMaxTokens] = useState(800);
  const [temperature, setTemperature] = useState(0.7);
  const [timeout, setTimeout] = useState(60);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleSend = async () => {
    if (!message.trim()) return;

    setLoading(true);
    setError(null);
    setResponse('');
    setReasoning(null);

    try {
      // Use genai-lite via IPC handler
      const result = await window.api.server.testMessage(message, {
        maxTokens,
        temperature,
      });

      // Handle the response from genai-lite
      if (result.object === 'chat.completion') {
        const choice = result.choices[0];

        // Extract reasoning if present
        if (choice.reasoning) {
          setReasoning(choice.reasoning);
        }

        // Extract content
        const content = choice.message?.content || '';

        // Validate response is not empty
        if (!content || content.trim().length === 0) {
          setError(
            `Model returned empty response. This often happens with thinking models when max_tokens is too low. ` +
              `Try increasing max_tokens to ${maxTokens + 500} or higher.`
          );
          setResponse('');
        } else {
          setResponse(content);
        }
      } else if (result.object === 'error') {
        // Handle error response from genai-lite
        throw new Error(result.error?.message || 'Unknown error from genai-lite');
      } else {
        throw new Error('Invalid response format from server');
      }
    } catch (err) {
      // Better error messages
      const errorMessage = (err as Error).message;

      if (errorMessage.includes('not running')) {
        setError('Server is not running. Please start the server first.');
      } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        setError(
          `Request timed out. For thinking models, try increasing max_tokens or simplifying the prompt.`
        );
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="test-chat">
      <div className="test-chat-input">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enter a test message..."
          disabled={!serverRunning || loading}
          onKeyPress={(e) => {
            if (e.key === 'Enter' && !loading) {
              handleSend();
            }
          }}
        />
        <ActionButton
          variant="primary"
          onClick={handleSend}
          disabled={!serverRunning || !message.trim()}
          loading={loading}
        >
          Send
        </ActionButton>
      </div>

      {!serverRunning && (
        <div className="test-chat-notice">Server must be running to test chat functionality.</div>
      )}

      <div className="test-chat-settings">
        <button
          className="settings-toggle"
          onClick={() => setShowSettings(!showSettings)}
          type="button"
        >
          {showSettings ? '▼' : '▶'} Advanced Settings
        </button>

        {showSettings && (
          <div className="settings-panel">
            <div className="setting-group">
              <label htmlFor="maxTokens">
                Max Tokens:
                <span className="setting-hint">
                  Higher values needed for thinking models (default: 800)
                </span>
              </label>
              <input
                id="maxTokens"
                type="number"
                min="50"
                max="4000"
                step="50"
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value, 10))}
                disabled={loading}
              />
            </div>

            <div className="setting-group">
              <label htmlFor="temperature">
                Temperature:
                <span className="setting-hint">
                  Controls randomness (0.0 = deterministic, 1.0 = creative)
                </span>
              </label>
              <input
                id="temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                disabled={loading}
              />
            </div>

            <div className="setting-group">
              <label htmlFor="timeout">
                Timeout (seconds):
                <span className="setting-hint">
                  Longer timeouts for thinking models (default: 60s)
                </span>
              </label>
              <input
                id="timeout"
                type="number"
                min="10"
                max="180"
                step="10"
                value={timeout}
                onChange={(e) => setTimeout(parseInt(e.target.value, 10))}
                disabled={loading}
              />
            </div>
          </div>
        )}
      </div>

      {loading && (
        <div className="test-chat-loading">
          <Spinner size="small" inline />
          <span>Waiting for response...</span>
        </div>
      )}

      {error && (
        <div className="test-chat-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {reasoning && !loading && (
        <div className="test-chat-reasoning">
          <div className="reasoning-header">
            <button
              className="reasoning-toggle"
              onClick={() => setShowReasoning(!showReasoning)}
              type="button"
            >
              {showReasoning ? '▼' : '▶'} Thinking / Reasoning
            </button>
          </div>
          {showReasoning && <div className="reasoning-content">{reasoning}</div>}
        </div>
      )}

      {response && !loading && (
        <div className="test-chat-response">
          <div className="response-label">Response:</div>
          <div className="response-content">{response}</div>
        </div>
      )}
    </div>
  );
};

export default TestChat;
