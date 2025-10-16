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

  const clearLogs = () => {
    setLogs([]);
  };

  return {
    logs,
    loading,
    clearLogs,
  };
}
