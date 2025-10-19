import React, { useEffect, useRef, useState } from 'react';
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
  const [showDebug, setShowDebug] = useState(false);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  /**
   * Get CSS class for log level
   *
   * Library now provides correct log levels, so we just map them to CSS classes
   */
  const getLevelClass = (level: string | undefined): string => {
    if (!level) return 'log-info';

    const lowerLevel = level.toLowerCase();
    if (lowerLevel === 'debug') return 'log-debug';
    if (lowerLevel === 'info') return 'log-info';
    if (lowerLevel === 'warn') return 'log-warn';
    if (lowerLevel === 'error') return 'log-error';

    return 'log-info';
  };

  /**
   * Filter logs based on debug toggle
   */
  const visibleLogs = logs.filter((log) => {
    // Hide debug logs unless toggle is on
    if (log.level?.toLowerCase() === 'debug' && !showDebug) {
      return false;
    }
    return true;
  });

  return (
    <div className="log-viewer">
      <div className="log-viewer-header">
        <span className="log-viewer-title">
          Logs ({visibleLogs.length}
          {showDebug ? '' : ` of ${logs.length}`})
        </span>
        <div className="log-viewer-controls">
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
            />
            <span>Show Debug</span>
          </label>
          {onClear && (
            <ActionButton variant="secondary" onClick={onClear}>
              Clear
            </ActionButton>
          )}
        </div>
      </div>
      <div className="log-viewer-content" ref={logContainerRef} style={{ height }}>
        {visibleLogs.length === 0 ? (
          <div className="log-empty">
            {logs.length === 0 ? 'No logs to display' : 'No logs match current filter'}
          </div>
        ) : (
          visibleLogs.map((log, index) => (
            <div key={index} className={`log-entry ${getLevelClass(log.level)}`}>
              <span className="log-timestamp">{log.timestamp}</span>
              <span className="log-level">[{log.level?.toUpperCase() || 'INFO'}]</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LogViewer;
