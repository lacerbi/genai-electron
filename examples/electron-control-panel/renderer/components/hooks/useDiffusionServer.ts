import { useState, useEffect, useCallback } from 'react';
import type { DiffusionServerInfo } from '../../types/api';

interface DiffusionServerConfig {
  modelId: string;
  port?: number;
  threads?: number;
  gpuLayers?: number;
}

export function useDiffusionServer() {
  const [serverInfo, setServerInfo] = useState<DiffusionServerInfo>({
    status: 'stopped',
    health: 'unknown',
    modelId: '',
    port: 8081,
    busy: false,
  });
  const [isHealthy, setIsHealthy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    // Safety check: ensure window.api exists
    if (!window.api || !window.api.diffusion) {
      console.error('window.api.diffusion not available');
      return;
    }

    try {
      const newStatus = await window.api.diffusion.status();
      setServerInfo(newStatus);

      if (newStatus.status === 'running') {
        const health = await window.api.diffusion.health();
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

  // Listen to diffusion server events
  useEffect(() => {
    // Safety check: ensure window.api exists
    if (!window.api || !window.api.on) {
      console.error('window.api not available');
      return;
    }

    window.api.on('diffusion:started', () => {
      fetchStatus();
    });

    window.api.on('diffusion:stopped', () => {
      fetchStatus();
    });

    window.api.on(
      'diffusion:crashed',
      (errorData: { message: string; code?: number | null; signal?: string | null }) => {
        setError(`Diffusion server crashed: ${errorData.message}`);
        fetchStatus();
      }
    );

    return () => {
      if (window.api && window.api.off) {
        window.api.off('diffusion:started');
        window.api.off('diffusion:stopped');
        window.api.off('diffusion:crashed');
      }
    };
  }, [fetchStatus]);

  const start = async (config: DiffusionServerConfig) => {
    setError(null);
    try {
      await window.api.diffusion.start(config);
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await window.api.diffusion.stop();
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  return {
    serverInfo,
    isHealthy,
    error,
    start,
    stop,
    refresh: fetchStatus,
  };
}
