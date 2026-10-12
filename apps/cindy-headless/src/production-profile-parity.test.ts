import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('example profiles match the packaged runtime pins', () => {
  it('keeps every example and smoke profile aligned with the repository runtime versions', async () => {
    const tools = { 'claude-code': 'claude', codex: 'codex', pi: 'pi' } as const;
    const versions = Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([backend, tool]) => {
      const metadata = JSON.parse(await readFile(path.resolve('../../tools', tool, 'latest.json'), 'utf8'));
      return [backend, metadata.version];
    })));
    const entries = await readdir('profiles', { recursive: true });
    const profiles = entries.filter((entry) => entry.endsWith('.json') && !entry.endsWith('profile.lock.json'));
    expect(profiles.length).toBeGreaterThan(0);
    for (const entry of profiles) {
      const profile = JSON.parse(await readFile(path.join('profiles', entry), 'utf8'));
      expect(profile.agentBinaryVersion, entry).toBe(versions[profile.agentBackend]);
    }
  });
});
