import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomizationScanRequest } from '../customizationScanProtocol';

const { fork, onQuit, warn } = vi.hoisted(() => ({ fork: vi.fn(), onQuit: vi.fn(), warn: vi.fn() }));
vi.mock('electron', () => ({ app: { once: onQuit }, utilityProcess: { fork } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn }) }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.resetModules(); });

describe('Desktop customization scan host', () => {
  it('forks only the bundled entry with home/system variables, no credentials, and disposes on quit', async () => {
    vi.stubEnv('CINDY_TEST_SECRET', 'must-not-reach-the-scanner');
    const child = new EventEmitter();
    const kill = vi.fn(() => true);
    const postMessage = vi.fn((request: CustomizationScanRequest) => {
      queueMicrotask(() => child.emit('message', {
        kind: 'result', id: request.id, result: { items: [], errors: [] },
      }));
    });
    fork.mockReturnValue(Object.assign(child, { kill, postMessage }));
    const { scanLocalCustomizations } = await import('../customizationScanHost');
    expect(fork).not.toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
    expect(await scanLocalCustomizations('pi', { kinds: ['skill'] })).toEqual({ items: [], errors: [] });
    const [entry, args, options] = fork.mock.calls[0];
    expect(path.basename(entry)).toBe('customizationScanProcess.js');
    expect(args).toEqual([]);
    expect(options.cwd).toBe(os.tmpdir());
    expect(options.env.CINDY_TEST_SECRET).toBeUndefined();
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env.USERPROFILE).toBe(process.env.USERPROFILE);
    expect(options.stdio).toBe('ignore');
    expect(kill).toHaveBeenCalledOnce();
    // before-quit can be prevented by the active-task confirmation dialog.
    expect(onQuit).toHaveBeenCalledExactlyOnceWith('will-quit', expect.any(Function));

    onQuit.mock.calls[0][1]();
    expect((await scanLocalCustomizations('pi', {})).errors[0].message).toContain('stopped');
    expect(fork).toHaveBeenCalledOnce();
  });
});
