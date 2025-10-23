/**
 * Tests for electron-lifecycle utility
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { attachAppLifecycle } from '../../src/utils/electron-lifecycle.js';
import type { ServerManagers } from '../../src/utils/electron-lifecycle.js';

// Mock types
interface MockApp {
  on: jest.Mock;
  exit: jest.Mock;
}

interface MockServerManager {
  getStatus: jest.Mock;
  stop: jest.Mock;
}

describe('electron-lifecycle', () => {
  describe('attachAppLifecycle', () => {
    let mockApp: MockApp;
    let mockLlamaServer: MockServerManager;
    let mockDiffusionServer: MockServerManager;
    let beforeQuitHandler: ((event: { preventDefault: () => void }) => Promise<void>) | null;

    beforeEach(() => {
      // Reset handler
      beforeQuitHandler = null;

      // Create mock Electron app
      mockApp = {
        on: jest.fn((eventName: string, handler: typeof beforeQuitHandler) => {
          if (eventName === 'before-quit') {
            beforeQuitHandler = handler;
          }
        }),
        exit: jest.fn(),
      };

      // Create mock server managers
      mockLlamaServer = {
        getStatus: jest.fn(() => 'stopped'),
        stop: jest.fn(async () => {}),
      };

      mockDiffusionServer = {
        getStatus: jest.fn(() => 'stopped'),
        stop: jest.fn(async () => {}),
      };

      // Spy on console methods
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should register before-quit event listener', () => {
      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
      });

      expect(mockApp.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    });

    it('should stop running LLM server on app quit', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'running');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockLlamaServer.getStatus).toHaveBeenCalled();
        expect(mockLlamaServer.stop).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should stop running diffusion server on app quit', async () => {
      mockDiffusionServer.getStatus = jest.fn(() => 'running');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        diffusionServer: mockDiffusionServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockDiffusionServer.getStatus).toHaveBeenCalled();
        expect(mockDiffusionServer.stop).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should stop both servers when both are running', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'running');
      mockDiffusionServer.getStatus = jest.fn(() => 'running');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
        diffusionServer: mockDiffusionServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockLlamaServer.stop).toHaveBeenCalled();
        expect(mockDiffusionServer.stop).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should not stop servers that are not running', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'stopped');
      mockDiffusionServer.getStatus = jest.fn(() => 'stopped');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
        diffusionServer: mockDiffusionServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockLlamaServer.stop).not.toHaveBeenCalled();
        expect(mockDiffusionServer.stop).not.toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should handle errors during cleanup gracefully', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'running');
      mockLlamaServer.stop = jest.fn(async () => {
        throw new Error('Failed to stop server');
      });

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(console.error).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0); // Should still exit
      }
    });

    it('should work with no servers provided', async () => {
      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {});

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should work with only LLM server provided', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'running');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockLlamaServer.stop).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should work with only diffusion server provided', async () => {
      mockDiffusionServer.getStatus = jest.fn(() => 'running');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        diffusionServer: mockDiffusionServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockDiffusionServer.stop).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0);
      }
    });

    it('should call preventDefault to allow async cleanup', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'running');

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        // preventDefault should be called first to prevent immediate quit
        expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
      }
    });

    it('should exit app even if both servers fail to stop', async () => {
      mockLlamaServer.getStatus = jest.fn(() => 'running');
      mockLlamaServer.stop = jest.fn(async () => {
        throw new Error('LLM stop failed');
      });

      mockDiffusionServer.getStatus = jest.fn(() => 'running');
      mockDiffusionServer.stop = jest.fn(async () => {
        throw new Error('Diffusion stop failed');
      });

      attachAppLifecycle(mockApp as unknown as Parameters<typeof attachAppLifecycle>[0], {
        llamaServer: mockLlamaServer as never,
        diffusionServer: mockDiffusionServer as never,
      });

      // Simulate app quit
      if (beforeQuitHandler) {
        const mockEvent = { preventDefault: jest.fn() };
        await beforeQuitHandler(mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(console.error).toHaveBeenCalled();
        expect(mockApp.exit).toHaveBeenCalledWith(0); // Should still exit
      }
    });
  });
});
