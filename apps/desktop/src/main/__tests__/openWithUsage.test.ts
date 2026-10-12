import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOpenWithUsageStore } from '../openWithUsage';

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-open-with-usage-'));
  file = path.join(directory, 'open-with-usage.json');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it('creates no file until a successful app opening is recorded and survives a new instance', () => {
  const store = createOpenWithUsageStore(file, vi.fn());
  expect(store.getLastUsed('/Applications/Code.app')).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
  store.recordUsed('/Applications/Code.app', 500);
  const fresh = createOpenWithUsageStore(file, vi.fn());
  expect(fresh.getLastUsed('/Applications/Code.app')).toBe(500);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    lastUsed: { '/Applications/Code.app': 500 },
  });
});

it('merges other writers and keeps the latest time rather than overwriting it with an old timestamp', () => {
  const first = createOpenWithUsageStore(file, vi.fn());
  const second = createOpenWithUsageStore(file, vi.fn());
  first.recordUsed('/Applications/Code.app', 500);
  second.recordUsed('/Applications/Typora.app', 600);
  first.recordUsed('/Applications/Code.app', 100);
  expect(second.getLastUsed('/Applications/Code.app')).toBe(500);
  expect(first.getLastUsed('/Applications/Typora.app')).toBe(600);
});

it('degrades corrupt history for sorting but refuses to overwrite it', () => {
  const onError = vi.fn();
  fs.writeFileSync(file, 'not json');
  const store = createOpenWithUsageStore(file, onError);
  expect(store.getLastUsed('/Applications/Code.app')).toBe(0);
  expect(onError).toHaveBeenCalledOnce();
  expect(() => store.recordUsed('/Applications/Code.app', 500)).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('not json');
});

it('reads the atomic backup rather than discarding recoverable history', () => {
  fs.writeFileSync(
    file + '.bak',
    JSON.stringify({ version: 1, lastUsed: { '/Applications/Code.app': 500 } }),
  );
  const store = createOpenWithUsageStore(file, vi.fn());
  expect(store.getLastUsed('/Applications/Code.app')).toBe(500);
  expect(fs.existsSync(file)).toBe(true);
});
