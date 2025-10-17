import { useState, useEffect } from 'react';

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

export function useServerLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      // Safety check: ensure window.api exists
      if (!window.api || !window.api.server) {
        console.error('window.api not available');
        setLoading(false);
        return;
      }

      try {
        const newLogs = await window.api.server.logs(100);
        setLogs(newLogs as LogEntry[]);
      } catch (err) {
        console.error('Failed to fetch logs:', err);
      } finally {
        setLoading(false);
      }
    };

    // Initial fetch
    fetchLogs();

    // Poll every 5 seconds
    const interval = setInterval(fetchLogs, 5000);

    return () => clearInterval(interval);
  }, []);

  const clearLogs = async () => {
    try {
      // Clear the log file on disk
      await window.api.server.clearLogs();
      // Clear UI state
      setLogs([]);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  return {
    logs,
    loading,
    clearLogs,
  };
}
