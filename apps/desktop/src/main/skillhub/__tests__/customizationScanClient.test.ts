import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomizationScanClient, type CustomizationScanChild } from '../customizationScanClient';
import type { CustomizationScanRequest } from '../customizationScanProtocol';

class FakeScanner extends EventEmitter implements CustomizationScanChild {
  postMessage = vi.fn<(message: CustomizationScanRequest) => void>();
  kill = vi.fn(() => true);

  reply(result = { items: [], errors: [] }): void {
    const request = this.postMessage.mock.calls.at(-1)![0];
    this.emit('message', { kind: 'result', id: request.id, result });
  }
}

afterEach(() => vi.useRealTimers());

describe('bounded customization discovery', () => {
  it('returns an error and kills an unresponsive scanner while Main timers still run', async () => {
    vi.useFakeTimers();
    const child = new FakeScanner();
    const client = new CustomizationScanClient({ fork: () => child, timeoutMs: 100 });
    const scan = client.scan('pi', { workingDirs: ['/project'] });
    const heartbeat = vi.fn();
    setTimeout(heartbeat, 10);

    await vi.advanceTimersByTimeAsync(10);
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    expect(await scan).toEqual({
      items: [], errors: [{ message: '[pi] Customization scan timed out' }],
    });
    expect(child.kill).toHaveBeenCalledOnce();

    // A hung/failed run must not poison the next refresh.
    const refresh = client.scan('pi', { workingDirs: ['/project'] });
    child.reply();
    expect(await refresh).toEqual({ items: [], errors: [] });
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate scans but gives each caller its own mutable result', async () => {
    const child = new FakeScanner();
    const fork = vi.fn(() => child);
    const client = new CustomizationScanClient({ fork });
    const options = { workingDirs: ['/project'], kinds: ['skill'] };
    const first = client.scan('claude-code', options);
    const second = client.scan('claude-code', options);
    expect(fork).toHaveBeenCalledOnce();
    expect(child.postMessage.mock.calls[0][0]).toMatchObject({
      kind: 'scan', engine: 'claude-code', options,
    });
    child.reply();
    const a = await first;
    const b = await second;
    a.errors.push({ message: 'Caller-local managed skill failure' });
    expect(b.errors).toEqual([]);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('isolates failures between engines and ignores late responses from a timed-out child', async () => {
    vi.useFakeTimers();
    const children: FakeScanner[] = [];
    const client = new CustomizationScanClient({
      fork: () => { const child = new FakeScanner(); children.push(child); return child; },
      timeoutMs: 100,
    });
    const pi = client.scan('pi', {});
    const codex = client.scan('codex', {});
    children[1].reply();
    expect(await codex).toEqual({ items: [], errors: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pi).errors[0].message).toContain('timed out');
    const refresh = client.scan('pi', {});
    children[0].reply();
    children[2].reply();
    expect(await refresh).toEqual({ items: [], errors: [] });
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it.each(['exit', 'error', 'postMessage', 'fork', 'invalid result'])(
    'settles and cleans up when the scanner fails at %s', async (failure) => {
      const child = new FakeScanner();
      const client = new CustomizationScanClient({
        fork: () => {
          if (failure === 'fork') throw new Error('cannot start');
          return child;
        },
      });
      if (failure === 'postMessage') child.postMessage.mockImplementation(() => { throw new Error('closed'); });
      const scan = client.scan('codex', {});
      if (failure === 'exit') child.emit('exit', 1);
      if (failure === 'error') child.emit('error', 'crashed');
      if (failure === 'invalid result') {
        child.emit('message', { kind: 'result', id: child.postMessage.mock.calls[0][0].id, result: null });
      }
      expect((await scan).errors).toHaveLength(1);
      expect(child.kill).toHaveBeenCalledTimes(failure === 'fork' ? 0 : 1);
      client.dispose();
      expect(child.kill).toHaveBeenCalledTimes(failure === 'fork' ? 0 : 1);
    },
  );

  it('bounds concurrent children and cancels pending work on shutdown', async () => {
    const child = new FakeScanner();
    const fork = vi.fn(() => child);
    const client = new CustomizationScanClient({ fork, maxConcurrent: 1 });
    const scan = client.scan('pi', {});
    const overflow = await client.scan('pi', { workingDirs: ['/other'] });
    expect(overflow.errors[0].message).toContain('busy');
    expect(fork).toHaveBeenCalledOnce();
    client.dispose();
    expect((await scan).errors[0].message).toContain('stopped');
    expect(child.kill).toHaveBeenCalledOnce();
    expect((await client.scan('pi', {})).errors).toHaveLength(1);
    expect(fork).toHaveBeenCalledOnce();
  });
});
