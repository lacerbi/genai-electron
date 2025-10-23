import { useState, useEffect, useCallback } from 'react';
import type { ResourceUsage, SavedLLMState, SystemCapabilities } from '../../types/api';
import type { ResourceEvent } from '../../types/ui';

export function useResourceMonitor() {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  const [savedState, setSavedState] = useState<SavedLLMState | null>(null);
  const [wouldOffload, setWouldOffload] = useState(false);
  const [events, setEvents] = useState<ResourceEvent[]>([]);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch GPU capabilities on mount and refresh on server events
  useEffect(() => {
    const fetchCapabilities = async () => {
      try {
        const caps = await window.api.system.detect();
        setCapabilities(caps);
      } catch (err) {
        console.error('Failed to get system capabilities:', err);
      }
    };

    fetchCapabilities();

    // Also listen to server events to refresh capabilities (cache cleared on server start/stop)
    if (window.api && window.api.on) {
      const handleServerEvent = () => {
        fetchCapabilities(); // Refresh after server events (memory/GPU may have changed)
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
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    if (!window.api || !window.api.resources) {
      console.error('window.api.resources not available');
      return;
    }

    try {
      const data = await window.api.resources.getUsage();
      setUsage(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const checkOffloadStatus = useCallback(async () => {
    if (!window.api || !window.api.resources) {
      return;
    }

    try {
      const needsOffload = await window.api.resources.wouldNeedOffload();
      setWouldOffload(needsOffload);
    } catch (err) {
      console.error('Failed to check offload status:', err);
    }
  }, []);

  const checkSavedState = useCallback(async () => {
    if (!window.api || !window.api.resources) {
      return;
    }

    try {
      const state = await window.api.resources.getSavedState();
      setSavedState(state);
    } catch (err) {
      console.error('Failed to get saved state:', err);
    }
  }, []);

  const addEvent = useCallback((message: string, type: ResourceEvent['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setEvents((prev) => [{ time, message, type }, ...prev].slice(0, 20));
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  // Poll resource usage every 2 seconds
  useEffect(() => {
    fetchUsage();
    checkOffloadStatus();
    checkSavedState();

    const interval = setInterval(() => {
      fetchUsage();
      checkOffloadStatus();
      checkSavedState();
    }, 2000);

    return () => clearInterval(interval);
  }, [fetchUsage, checkOffloadStatus, checkSavedState]);

  // Poll GPU info every 5 seconds for real-time VRAM updates (bypasses cache)
  useEffect(() => {
    const fetchGPUInfo = async () => {
      try {
        const gpuInfo = await window.api.system.getGPU();
        // Update capabilities with fresh GPU data
        setCapabilities((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            gpu: gpuInfo,
          };
        });
      } catch (err) {
        console.error('Failed to get GPU info:', err);
      }
    };

    const interval = setInterval(() => {
      fetchGPUInfo();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // Listen to server events for timeline
  useEffect(() => {
    if (!window.api || !window.api.on) {
      console.error('window.api not available');
      return;
    }

    // LLM server events
    window.api.on('server:started', () => {
      addEvent('LLM Server started', 'info');
    });

    window.api.on('server:stopped', () => {
      addEvent('LLM Server stopped', 'info');
    });

    window.api.on('server:crashed', (errorData: { message: string }) => {
      addEvent(`LLM Server crashed: ${errorData.message}`, 'error');
    });

    // Diffusion server events
    window.api.on('diffusion:started', () => {
      addEvent('Diffusion Server started', 'info');
    });

    window.api.on('diffusion:stopped', () => {
      addEvent('Diffusion Server stopped', 'info');
    });

    window.api.on('diffusion:crashed', (errorData: { message: string }) => {
      addEvent(`Diffusion Server crashed: ${errorData.message}`, 'error');
    });

    return () => {
      if (window.api && window.api.off) {
        window.api.off('server:started');
        window.api.off('server:stopped');
        window.api.off('server:crashed');
        window.api.off('diffusion:started');
        window.api.off('diffusion:stopped');
        window.api.off('diffusion:crashed');
      }
    };
  }, [addEvent]);

  return {
    usage,
    savedState,
    wouldOffload,
    events,
    capabilities,
    error,
    refresh: fetchUsage,
    clearEvents,
    addEvent,
  };
}
