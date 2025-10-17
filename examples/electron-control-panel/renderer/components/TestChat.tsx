import React, { useState, useEffect, useRef } from 'react';
import ActionButton from './common/ActionButton';
import Spinner from './common/Spinner';
import './TestChat.css';

interface TestChatProps {
  serverRunning: boolean;
  port?: number;
}

const TestChat: React.FC<TestChatProps> = ({ serverRunning, port = 8080 }) => {
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();
    const timeoutId = setTimeout(() => {
      abortControllerRef.current?.abort();
    }, 30000); // 30 second timeout

    try {
      // Make a direct fetch request to the llama-server
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: message,
            },
          ],
          max_tokens: 100,
          temperature: 0.7,
          stream: false, // CRITICAL: Prevent streaming response that causes hangs
        }),
        signal: abortControllerRef.current.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.choices && data.choices[0] && data.choices[0].message) {
        setResponse(data.choices[0].message.content);
      } else {
        throw new Error('Invalid response format from server');
      }
    } catch (err) {
      clearTimeout(timeoutId);

      // Better error messages
      if ((err as Error).name === 'AbortError') {
        setError('Request timed out after 30 seconds. Check server logs for issues.');
      } else if ((err as Error).message.includes('fetch')) {
        setError('Cannot connect to server. Make sure the server is running.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
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
        <div className="test-chat-notice">
          Server must be running to test chat functionality.
        </div>
      )}

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
