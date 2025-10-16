import { useState, useEffect, useCallback } from 'react';

interface ServerStatus {
  status: 'running' | 'stopped' | 'starting' | 'error';
  modelId?: string;
  port?: number;
  pid?: number;
}

interface ServerConfig {
  modelId: string;
  port?: number;
  contextSize?: number;
  gpuLayers?: number;
  threads?: number;
  parallelRequests?: number;
  flashAttention?: boolean;
}

export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus>({ status: 'stopped' });
  const [isHealthy, setIsHealthy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const newStatus = await window.api.server.status();
      setStatus(newStatus as ServerStatus);

      if ((newStatus as ServerStatus).status === 'running') {
        const health = await window.api.server.health();
        setIsHealthy(health);
      } else {
        setIsHealthy(false);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Poll status every 3 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Listen to server events
  useEffect(() => {
    // Safety check: ensure window.api exists
    if (!window.api || !window.api.on) {
      console.error('window.api not available');
      return;
    }

    window.api.on('server:started', () => {
      fetchStatus();
    });

    window.api.on('server:stopped', () => {
      fetchStatus();
    });

    window.api.on('server:crashed', (errorData: { message: string; stack?: string }) => {
      setError(`Server crashed: ${errorData.message}`);
      fetchStatus();
    });

    return () => {
      if (window.api && window.api.off) {
        window.api.off('server:started');
        window.api.off('server:stopped');
        window.api.off('server:crashed');
      }
    };
  }, [fetchStatus]);

  const start = async (config: ServerConfig) => {
    setError(null);
    try {
      await window.api.server.start(config);
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await window.api.server.stop();
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  const restart = async () => {
    setError(null);
    try {
      await window.api.server.restart();
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  return {
    status,
    isHealthy,
    error,
    start,
    stop,
    restart,
    refresh: fetchStatus,
  };
}
