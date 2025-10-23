import { useState, useEffect } from 'react';

interface SystemCapabilities {
  cpu: {
    cores: number;
    model: string;
    arch: string;
  };
  memory: {
    total: number;
    available: number;
  };
  gpu: {
    available: boolean;
    type?: string;
    name?: string;
    vram?: number;
    vramAvailable?: number;
  };
  recommendations: {
    maxModelSize: string;
    maxGpuLayers: number;
    recommendedModels: Array<{
      name: string;
      size: string;
      supported: boolean;
    }>;
  };
}

export function useSystemInfo() {
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSystemInfo = async () => {
    setLoading(true);
    setError(null);

    // Safety check: ensure window.api exists
    if (!window.api || !window.api.system) {
      console.error('window.api not available');
      setError('System API not available');
      setLoading(false);
      return;
    }

    try {
      const data = await window.api.system.detect();
      setCapabilities(data as SystemCapabilities);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Fetch system info on mount and poll every 5 seconds
  useEffect(() => {
    fetchSystemInfo();

    const interval = setInterval(() => {
      fetchSystemInfo();
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Listen to server events to trigger immediate refresh
  useEffect(() => {
    if (!window.api || !window.api.on) {
      return;
    }

    const handleServerEvent = () => {
      // Refresh system info when server starts/stops (memory changes)
      fetchSystemInfo();
    };

    window.api.on('server:started', handleServerEvent);
    window.api.on('server:stopped', handleServerEvent);
    window.api.on('diffusion:started', handleServerEvent);
    window.api.on('diffusion:stopped', handleServerEvent);

    return () => {
      if (window.api && window.api.off) {
        window.api.off('server:started', handleServerEvent);
        window.api.off('server:stopped', handleServerEvent);
        window.api.off('diffusion:started', handleServerEvent);
        window.api.off('diffusion:stopped', handleServerEvent);
      }
    };
  }, []);

  return {
    capabilities,
    loading,
    error,
    refresh: fetchSystemInfo,
  };
}
