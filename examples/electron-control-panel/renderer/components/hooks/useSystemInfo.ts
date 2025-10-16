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
    try {
      const data = await window.api.system.detect();
      setCapabilities(data as SystemCapabilities);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemInfo();
  }, []);

  return {
    capabilities,
    loading,
    error,
    refresh: fetchSystemInfo,
  };
}
