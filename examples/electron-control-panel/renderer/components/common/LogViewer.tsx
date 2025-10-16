import React, { useEffect, useRef } from 'react';
import ActionButton from './ActionButton';
import './LogViewer.css';

interface LogEntry {
  level: string;
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

  const getLevelClass = (level: string): string => {
    const lowerLevel = level.toLowerCase();
    if (lowerLevel.includes('error')) return 'log-error';
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
            <div key={index} className={`log-entry ${getLevelClass(log.level)}`}>
              <span className="log-timestamp">{log.timestamp}</span>
              <span className="log-level">[{log.level}]</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LogViewer;
