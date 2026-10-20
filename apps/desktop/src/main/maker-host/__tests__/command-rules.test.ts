/** Permission/storage tier: real publication and invalidation, isolated source/owner.
 * Existing approval tests did not cover native packages, tombstones or source races.
 * Native parsing is exercised separately by the helper's Rust and native E2E tests.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_RULE_ENGINE, createCommandRulesEvaluator } from '../command-rules';

describe('native command rule package lifecycle', () => {
  let directory: string;
  let owner: string | null;
  let files: Array<{ sourceId: string; text: string }>;
  let nativeError: string | undefined;
  let nativeDecision: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cindy-command-rule-store-'));
    owner = 'owner-one'; nativeError = undefined; nativeDecision = 'allow';
    files = [{ sourceId: '/fixture/codex/rules/a.rules', text: 'def rule():\n    return "whole native module"\n' }];
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const request = () => ({ toolName: 'bash' as const, command: 'probe one', workingDir: '/fixture/project',
    evidence: { cwd: '/fixture/project', argv: ['bash', '-lc', 'probe one'] } });
  const native = vi.fn(async (r: Record<string, unknown>) => r.operation === 'discover'
    ? { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE, codexHome: '/fixture/codex', cwd: r.cwd,
      layers: [{ sourceId: '/fixture/codex', version: 'fixture', kind: 'user', enabled: true }], files }
    : nativeError ? { error: nativeError }
      : { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE, revision: r.revision, argv: r.argv, decision: nativeDecision });
  const evaluate = () => createCommandRulesEvaluator({ ownerScope: () => owner,
    storageDirectory: () => directory, sourceHomes: async () => ['/fixture/codex'], runner: async () => native });
  async function packagePath() { return path.join(directory, (await readdir(directory)).find((n) => n.endsWith('.json'))!); }

  it('publishes whole files once, reuses the snapshot, and binds native argv/revision', async () => {
    const evaluateRules = evaluate();
    const first = await evaluateRules(request());
    expect(first.decision).toBe('allow');
    expect(await first.isCurrent()).toBe(true);
    const before = await readFile(await packagePath(), 'utf8');
    const second = await evaluateRules(request());
    expect(second.revision).toBe(first.revision);
    expect(await readFile(await packagePath(), 'utf8')).toBe(before);
    const saved = JSON.parse(before);
    expect(saved.files[0]).toMatchObject({ sourceId: files[0]!.sourceId, text: files[0]!.text, order: 0 });
    expect(native.mock.calls.at(-1)![0]).toMatchObject({ operation: 'evaluate', files, argv: request().evidence.argv });
  });

  it('imports the first real source after an earlier no-rules command', async () => {
    const initial = files; files = [];
    const evaluateRules = evaluate();
    const empty = await evaluateRules(request());
    expect(empty.decision).toBe('unmatched');
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([]);
    files = initial;
    expect(await empty.isCurrent()).toBe(false);
    expect((await evaluateRules(request())).decision).toBe('allow');
  });

  it('retains the last valid package and refuses stale allows after a source change', async () => {
    const evaluateRules = evaluate();
    const old = await evaluateRules(request());
    files = [{ ...files[0]!, text: 'changed source' }];
    expect(await old.isCurrent()).toBe(false);
    const next = await evaluateRules(request());
    expect(next.decision).toBe('error');
    expect(next.reason).toContain('RULES_SOURCE_CHANGED');
    const saved = JSON.parse(await readFile(await packagePath(), 'utf8'));
    expect(saved.files[0].text).not.toBe(files[0]!.text);
    expect(saved.pendingSourceDigest).toBeTypeOf('string');
  });

  it('retains effective project rules instead of falling back to an untrusted empty home', async () => {
    const managed = '/fixture/managed'; const external = '/fixture/external';
    const projectFile = { sourceId: '/fixture/project/.codex/rules/project.rules', text: 'native project rule' };
    const evaluateRules = createCommandRulesEvaluator({ ownerScope: () => owner,
      storageDirectory: () => directory, sourceHomes: async () => [managed, external], runner: async () => async (r) => {
        if (r.operation !== 'discover') return { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE,
          revision: r.revision, argv: r.argv, decision: 'forbidden' };
        return { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE, codexHome: r.codexHome, cwd: r.cwd,
          layers: [{ sourceId: '/fixture/project/.codex', version: 'fixture', kind: 'project', enabled: r.codexHome === managed }],
          files: r.codexHome === managed ? [projectFile] : [] };
      } });
    expect((await evaluateRules(request())).decision).toBe('forbidden');
    const saved = JSON.parse(await readFile(await packagePath(), 'utf8'));
    expect(saved.scope.codexHome).toBe(managed);
    expect(saved.files[0]).toMatchObject(projectFile);
  });

  it.each(['managed-removed', 'managed-appeared'])(
    'keeps the migration identity when fallback changes: %s', async (change) => {
      const managed = '/fixture/managed'; const external = '/fixture/external';
      let managedHasRules = change === 'managed-removed';
      const nativeRunner = async (r: Record<string, unknown>) => {
        if (r.operation !== 'discover') return { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE,
          revision: r.revision, argv: r.argv, decision: 'forbidden' };
        const home = String(r.codexHome);
        return { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE, codexHome: home, cwd: r.cwd,
          layers: [{ sourceId: home, version: 'fixture', kind: 'user', enabled: true }],
          files: home === managed && !managedHasRules ? [] : [{ sourceId: home + '/rules/a.rules', text: home }] };
      };
      const evaluateRules = createCommandRulesEvaluator({ ownerScope: () => owner,
        storageDirectory: () => directory, sourceHomes: async () => [managed, external], runner: async () => nativeRunner });
      const old = await evaluateRules(request());
      expect(old.decision).toBe('forbidden');
      const filename = await packagePath();
      const saved = JSON.parse(await readFile(filename, 'utf8'));
      saved.revision = 'user-edited';
      await writeFile(filename, JSON.stringify(saved));
      managedHasRules = !managedHasRules;
      expect(await old.isCurrent()).toBe(false);
      const changed = await evaluateRules(request());
      expect(changed.decision).toBe('error');
      expect(changed.reason).toContain('RULES_SOURCE_CHANGED');
      const retained = JSON.parse(await readFile(filename, 'utf8'));
      expect(retained.revision).toBe('user-edited');
      expect(retained.scope.codexHome).toBe(saved.scope.codexHome);
      expect(retained.pendingSourceDigest).toBeTypeOf('string');
      expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
      retained.deleted = true; retained.files = [];
      await writeFile(filename, JSON.stringify(retained));
      const deleted = await evaluateRules(request());
      expect(deleted.decision).toBe('unmatched');
      expect(await deleted.isCurrent()).toBe(true);
      expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    },
  );

  it('keeps owner, execution host, cwd and configured home scopes isolated', async () => {
    let homes = ['/fixture/codex'];
    const evaluateRules = createCommandRulesEvaluator({ ownerScope: () => owner,
      storageDirectory: () => directory, sourceHomes: async () => homes, runner: async () => async (r) => {
        const result = await native(r);
        return r.operation === 'discover' ? { ...result, codexHome: r.codexHome } : result;
      } });
    const first = await evaluateRules(request());
    owner = 'owner-two'; await evaluateRules(request()); owner = 'owner-one';
    await evaluateRules({ ...request(), remoteHostId: 'host-two' });
    await evaluateRules({ ...request(), evidence: { ...request().evidence, cwd: '/fixture/other-project' } });
    homes = ['/fixture/other-home']; await evaluateRules(request()); homes = ['/fixture/codex'];
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toHaveLength(5);
    expect((await evaluateRules(request())).revision).toBe(first.revision);
    expect(await first.isCurrent()).toBe(true);
  });

  it('keeps a deletion marker across restarts and never reimports the source', async () => {
    await evaluate()(request());
    const filename = await packagePath();
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    saved.deleted = true; saved.files = [];
    await writeFile(filename, JSON.stringify(saved));
    const result = await evaluate()(request());
    expect(result.decision).toBe('unmatched');
    expect(await result.isCurrent()).toBe(true);
    expect(JSON.parse(await readFile(filename, 'utf8')).deleted).toBe(true);
  });

  it('invalidates an existing lease after package edits, deletion or an owner boundary', async () => {
    const result = await evaluate()(request());
    const filename = await packagePath();
    const bytes = await readFile(filename, 'utf8');
    await writeFile(filename, bytes + ' ');
    // Insignificant JSON whitespace is not a policy edit.
    expect(await result.isCurrent()).toBe(true);
    await writeFile(filename, JSON.stringify({ ...JSON.parse(bytes), revision: 'user-edited' }));
    expect(await result.isCurrent()).toBe(false);
    await writeFile(filename, bytes);
    owner = 'owner-two';
    expect(await result.isCurrent()).toBe(false);
  });

  it.each(['INVALID_RULES', 'UNSUPPORTED_RULES_VERSION', 'SOURCE_RULE_READ_FAILED'])(
    'does not turn native %s into unmatched', async (error) => {
      nativeError = error;
      expect((await evaluate()(request())).decision).toBe('error');
    },
  );

  it('refuses corrupt published data and missing execution evidence without overwriting it', async () => {
    const evaluateRules = evaluate(); await evaluateRules(request());
    expect((await evaluateRules({ ...request(), evidence: null })).decision).toBe('error');
    const filename = await packagePath(); await writeFile(filename, '{broken');
    expect((await evaluateRules(request())).decision).toBe('error');
    expect(await readFile(filename, 'utf8')).toBe('{broken');
  });
});
