import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProviderShareUsageStore, providerShareUsageRangeStart } from '../providerShareUsageStore';

const sample = (model: string, input: number, output: number, turns = 1) => ({
  model, turns, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0,
});

describe('provider share usage store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-usage-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates per member and model, filters by range and only returns requested shares', async () => {
    let now = new Date(2026, 9, 7, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 5)] });
    now = new Date(2026, 8, 20, 12).getTime();
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 100, 50)] });
    store.record('share-2', 'm9', { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });
    now = new Date(2026, 9, 7, 13).getTime();

    const month = store.query(new Set(['share-1']), 'month');
    expect(month).toHaveLength(1);
    expect(month[0]).toMatchObject({ shareId: 'share-1', memberId: 'm1' });
    expect(month[0].models).toEqual([{ kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', model: 'opus', turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
    expect(month[0].lastUsedAt).toBe(new Date(2026, 9, 7, 12).getTime());
    expect(store.query(new Set(['share-1']), 'all')[0].models[0]).toMatchObject({ turns: 2, inputTokens: 110, outputTokens: 55 });

    await store.flush();
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['share-1', 'share-2']), 'all')).toHaveLength(2);
  });

  it('splits each row by computer in the group without changing the row key, so older versions keep the totals', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    // 加组内电脑之前记的一行：合计 3 轮，没有区分电脑。
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rows: [{
        day: '2026-10-11', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
        turns: 3, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0.3, lastAt: 1,
      }],
    }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 1)] });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 20, 2)] });
    const models = store.query(new Set(['s']), 'all')[0]!.models;
    expect(models.map((model) => [model.memberKey, model.turns, model.inputTokens])).toEqual(
      expect.arrayContaining([['local', 1, 10], ['device:studio:a2', 1, 20], [null, 3, 30]]),
    );
    expect(models).toHaveLength(3);

    // 文件里仍是同一行(旧版本的键)，合计包含全部；各台的分布在 byMember 里。
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<Record<string, unknown>> };
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({ turns: 5, inputTokens: 60, byMember: { local: { turns: 1 }, 'device:studio:a2': { turns: 1 } } });

    // 降级期间旧版本只加了合计：多出来的算没区分电脑，不会让某台超过合计。
    saved.rows[0]!.turns = 7;
    saved.rows[0]!.inputTokens = 80;
    fs.writeFileSync(file, JSON.stringify(saved));
    const after = createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')[0]!.models;
    expect(after.find((model) => model.memberKey === null)).toMatchObject({ turns: 5, inputTokens: 50 });
  });

  it('keeps existing computer distributions and all counters after exceeding the per-row capacity and restarting', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    const usage = (memberKey: string, turns = 1) => ({
      kind: 'claude-code', providerId: 'anthropic', memberKey, samples: [{
        ...sample('opus', turns * 10, turns * 5, turns),
        cacheReadTokens: turns * 2, cacheCreateTokens: turns * 3, sdkCostUsd: turns * 0.01,
      }],
    });
    for (let i = 0; i < 512; i++) store.record('s', 'm', usage(`device:d${i}:anthropic`));
    store.record('s', 'm', usage('device:overflow:anthropic', 2));
    // 满容量后已有键仍能更新，不能因为新键溢出而丢掉已记的电脑。
    store.record('s', 'm', usage('device:d0:anthropic', 3));
    const before = store.query(new Set(['s']), 'all');
    expect(before[0]!.models).toHaveLength(513);
    expect(before[0]!.models.find((model) => model.memberKey === 'device:d0:anthropic')).toMatchObject({ turns: 4 });
    expect(before[0]!.models.find((model) => model.memberKey === null)).toMatchObject({ turns: 2, inputTokens: 20 });
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<{ byMember: Record<string, unknown>; turns: number }> };
    expect(Object.keys(saved.rows[0]!.byMember)).toHaveLength(512);
    expect(saved.rows[0]!.byMember).not.toHaveProperty('device:overflow:anthropic');
    expect(saved.rows[0]!.turns).toBe(517);
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['s']), 'all')).toEqual(before);
    const models = before[0]!.models;
    for (const [field, total] of [
      ['turns', 517], ['inputTokens', 5170], ['outputTokens', 2585],
      ['cacheReadTokens', 1034], ['cacheCreateTokens', 1551], ['sdkCostUsd', 5.17],
    ] as const) {
      expect(models.reduce((sum, model) => sum + model[field], 0)).toBeCloseTo(total);
    }
    reloaded.record('s', 'm', usage('device:overflow:anthropic'));
    reloaded.record('s', 'm', usage('device:d511:anthropic'));
    const after = reloaded.query(new Set(['s']), 'all');
    expect(after[0]!.models.find((model) => model.memberKey === null)).toMatchObject({ turns: 3 });
    expect(after[0]!.models.find((model) => model.memberKey === 'device:d511:anthropic')).toMatchObject({ turns: 2 });
    await reloaded.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')).toEqual(after);
  });

  it('recovers the stored distributions from an older oversized byMember row without losing its total', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const counters = { turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{
      day: '2026-10-11', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
      ...counters, turns: 513, inputTokens: 5130, outputTokens: 2565, lastAt: now,
      byMember: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`device:d${i}:anthropic`, counters])),
    }] }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    const models = store.query(new Set(['s']), 'all')[0]!.models;
    expect(models.filter((model) => model.memberKey !== null)).toHaveLength(512);
    expect(models.find((model) => model.memberKey === null)).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 5 });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:d0:anthropic', samples: [sample('opus', 20, 10, 2)] });
    const after = store.query(new Set(['s']), 'all');
    expect(after[0]!.models.find((model) => model.memberKey === 'device:d0:anthropic')).toMatchObject({ turns: 3 });
    await store.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')).toEqual(after);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<{ byMember: Record<string, unknown>; turns: number }> };
    expect(Object.keys(saved.rows[0]!.byMember)).toHaveLength(512);
    expect(saved.rows[0]!.turns).toBe(515);
  });

  it('starts from an empty ledger when the file is corrupt and drops malformed rows', () => {
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, '{not json');
    expect(createProviderShareUsageStore(file).query(new Set(['s']), 'all')).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ day: '2026-10-01', shareId: 's', memberId: 'm', kind: 'pi', providerId: null, model: 'x', turns: -1 }] }));
    expect(createProviderShareUsageStore(file).query(new Set(['s']), 'all')).toEqual([]);
  });

  it('computes range starts in local days', () => {
    const now = new Date(2026, 9, 7, 9).getTime();
    expect(providerShareUsageRangeStart('all', now)).toBeNull();
    expect(providerShareUsageRangeStart('month', now)).toBe('2026-10-01');
    expect(providerShareUsageRangeStart('7d', now)).toBe('2026-10-01');
  });
});
