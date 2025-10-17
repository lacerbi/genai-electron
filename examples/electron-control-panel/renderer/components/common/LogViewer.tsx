import React, { useEffect, useRef } from 'react';
import ActionButton from './ActionButton';
import './LogViewer.css';

interface LogEntry {
  level?: string; // Optional to handle edge cases
  message: string;
  timestamp: string;
}

interface LogViewerProps {
  logs: LogEntry[];
  autoScroll?: boolean;
  onClear?: () => void;
  height?: string;
}

const LogViewer: React.FC<LogViewerProps> = ({
  logs,
  autoScroll = true,
  onClear,
  height = '300px',
}) => {
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const getLevelClass = (level: string | undefined, message: string): string => {
    // Defensive: handle undefined or null levels
    if (!level) return 'log-info';

    const lowerLevel = level.toLowerCase();
    const lowerMessage = message.toLowerCase();

    // Special handling for llama.cpp logs which log everything as [ERROR]
    if (lowerLevel.includes('error')) {
      // HTTP requests with 200 status are successful operations, not errors
      if (lowerMessage.includes('request:') && lowerMessage.includes(' 200')) {
        return 'log-info';
      }

      // Slot operations are internal state management, not errors
      if (
        lowerMessage.includes('slot') &&
        (lowerMessage.includes('update_slots') ||
          lowerMessage.includes('launch_slot') ||
          lowerMessage.includes('release') ||
          lowerMessage.includes('get_availabl') ||
          lowerMessage.includes('print_timing'))
      ) {
        return 'log-debug';
      }

      // Server state changes are informational
      if (
        lowerMessage.includes('all slots are idle') ||
        lowerMessage.includes('params_from_') ||
        lowerMessage.includes('srv ')
      ) {
        return 'log-info';
      }

      // Actual errors (4xx, 5xx status codes, failure messages)
      if (
        /\s[45]\d{2}(\s|$)/.test(lowerMessage) ||
        lowerMessage.includes('failed') ||
        lowerMessage.includes('error:') ||
        lowerMessage.includes('exception')
      ) {
        return 'log-error';
      }

      // Default for other [ERROR] messages: treat as info
      return 'log-info';
    }

    if (lowerLevel.includes('warn')) return 'log-warn';
    return 'log-info';
  };

  return (
    <div className="log-viewer">
      <div className="log-viewer-header">
        <span className="log-viewer-title">Logs ({logs.length})</span>
        {onClear && (
          <ActionButton variant="secondary" onClick={onClear}>
            Clear
          </ActionButton>
        )}
      </div>
      <div className="log-viewer-content" ref={logContainerRef} style={{ height }}>
        {logs.length === 0 ? (
          <div className="log-empty">No logs to display</div>
        ) : (
          logs.map((log, index) => (
            <div key={index} className={`log-entry ${getLevelClass(log.level, log.message)}`}>
              <span className="log-timestamp">{log.timestamp}</span>
              <span className="log-level">[{log.level || 'INFO'}]</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LogViewer;
