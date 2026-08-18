import { once } from 'node:events';
import { describe, expect, it, jest } from '@jest/globals';

import { ServerError } from '../../src/errors/index.js';
import { ProcessManager } from '../../src/process/ProcessManager.js';

describe('ProcessManager spawn failures', () => {
  it('registers the error listener before rejecting a missing-PID spawn', async () => {
    const manager = new ProcessManager();
    const onError = jest.fn();
    const command = `genai-electron-missing-executable-${process.pid}`;
    const uncaught = jest.fn();
    process.once('uncaughtException', uncaught);

    try {
      expect(() => manager.spawn(command, [], { onError })).toThrow(ServerError);
      await new Promise((resolve) => setImmediate(resolve));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'ENOENT' });
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.removeListener('uncaughtException', uncaught);
    }
  });

  it('delivers a platform-neutral nonexistent executable through onError', async () => {
    const manager = new ProcessManager();
    const command = `genai-electron-missing-executable-${process.pid}-callback`;
    let result;
    try {
      result = manager.spawn(command, [], {});
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError);
      return;
    }

    const [error] = (await once(result.process, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ENOENT');
  });
});
