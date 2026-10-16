import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 最小 drizzle 假链:每次 select() 按顺序弹出一组行;链上任何方法都返回自身并可 await。
 * 读取路径依次 select:伙伴归属 → 会话 cleared_at → 来源消息存活 → 进行中的后台任务。
 */
const db = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => {
        const rows = db.queue.shift() ?? [];
        const chain: Record<string, unknown> = {
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        for (const name of ['from', 'innerJoin', 'where', 'limit']) chain[name] = () => chain;
        return chain;
      },
    },
  }),
}));

import {
  applyWorkingMemoryProposal,
  buildWorkingMemoryRefreshNote,
  createWorkingMemoryRefreshRegistry,
  emptyWorkingMemory,
  isWorkingMemoryFresh,
  parseWorkingMemory,
  pruneWithdrawnWorkingMemoryForSession,
  pruneWorkingMemoryForMessages,
  readBotWorkingMemory,
  readWorkingMemoryNoteForSession,
  renderWorkingMemory,
  WORKING_MEMORY_HEADING,
  WORKING_MEMORY_LIMITS,
  workingMemoryForReview,
  workingMemoryPath,
  WorkingMemoryRevisionConflict,
  writeBotWorkingMemory,
  type BotWorkingMemory,
} from '../botWorkingMemory';

const messages = [
  { id: 'u1', role: 'user', text: '周五前把周报模板改成先结论后细节,别再用旧格式了' },
  { id: 'a1', role: 'assistant', text: '好的,我周五前把周报模板改成先结论后细节,改完发你确认' },
  { id: 't1', role: 'tool_result', text: 'report-template.md written' },
];

describe('applyWorkingMemoryProposal', () => {
  const now = 1_700_000_000_000;

  it('admits new items only with a quote from a user or assistant message and keeps their message id', () => {
    const next = applyWorkingMemoryProposal(
      null,
      {
        threads: [{ text: '改周报模板', status: 'active', evidence: { messageId: 'u1', quote: '周报模板改成先结论后细节' } }],
        commitments: [
          { text: '周五前改完周报模板并发用户确认', trigger: '周五前', evidence: { messageId: 'a1', quote: '周五前把周报模板改成先结论后细节' } },
          { text: '凭空捏造的承诺', evidence: { messageId: 'a1', quote: 'not said' } },
          { text: '工具结果不能作为新承诺的证据', evidence: { messageId: 't1', quote: 'report-template.md written' } },
        ],
        waiting: [],
        corrections: [{ text: '不再用旧格式', evidence: { messageId: 'u1', quote: '别再用旧格式' } }],
        recentlyDone: [],
        resolved: [],
      },
      messages,
      { now, coveredThroughRowid: 42 },
    );
    expect(next.threads.map((t) => t.text)).toEqual(['改周报模板']);
    expect(next.commitments.map((c) => c.text)).toEqual(['周五前改完周报模板并发用户确认']);
    expect(next.commitments[0]).toMatchObject({ messageId: 'a1', trigger: '周五前' });
    expect(next.corrections[0]).toMatchObject({ text: '不再用旧格式', messageId: 'u1' });
    expect(next.coveredThroughRowid).toBe(42);
  });

  it('carries unchanged items verbatim without evidence, keeps omitted ones, and drops only evidenced resolutions', () => {
    const previous: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      revision: 3,
      coveredThroughRowid: 10,
      commitments: [
        { id: 'c1', text: '周五前改完周报模板', updatedAt: 1, messageId: 'old' },
        { id: 'c2', text: '给设计稿加暗色模式', updatedAt: 2 },
        { id: 'c3', text: '把测试补上', updatedAt: 3 },
      ],
    };
    const next = applyWorkingMemoryProposal(
      previous,
      {
        threads: [],
        // c1 原文沿用(无证据也行);c2 没提到 → 保留;c3 有工具证据的 resolved → 删除。
        commitments: [{ text: '周五前改完周报模板' }],
        waiting: [],
        corrections: [],
        recentlyDone: [{ text: '测试已补上', evidence: { messageId: 'a1', quote: '改完发你确认' } }],
        resolved: [
          { text: '把测试补上', evidence: { messageId: 't1', quote: 'report-template.md written' } },
          { text: '给设计稿加暗色模式', evidence: { messageId: 'a1', quote: 'never said this' } },
        ],
      },
      messages,
      { now, coveredThroughRowid: 5 },
    );
    expect(next.commitments.map((c) => c.text)).toEqual(['给设计稿加暗色模式', '周五前改完周报模板']);
    // 原样带回的条目连时间都不动,排序才能表达"最新优先"。
    expect(next.commitments.find((c) => c.id === 'c1')).toMatchObject({ messageId: 'old', updatedAt: 1 });
    expect(next.recentlyDone.map((d) => d.text)).toEqual(['测试已补上']);
    // 水位只前进不后退。
    expect(next.coveredThroughRowid).toBe(10);
  });

  it('requires evidence to change a field of an existing item, allows evidenced clearing, and bumps time only on real change', () => {
    const previous: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      commitments: [{ id: 'c1', text: '周五前改完周报模板', trigger: '周五前', updatedAt: 1 }],
      threads: [{ id: 't1', text: '周报模板改版', status: 'active', next: '发用户确认', updatedAt: 1 }],
    };
    const base = { threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [], resolved: [] };
    // 无证据改期限 → 当没提,旧值与时间都保留。
    const unproven = applyWorkingMemoryProposal(
      previous,
      { ...base, commitments: [{ text: '周五前改完周报模板', trigger: '下周一' }] },
      messages,
      { now, coveredThroughRowid: 1 },
    );
    expect(unproven.commitments[0]).toMatchObject({ id: 'c1', trigger: '周五前', updatedAt: 1 });
    // 有证据的改期限 → 接受并更新时间;有证据的空串 → 清空。
    const proven = applyWorkingMemoryProposal(
      previous,
      {
        ...base,
        commitments: [{ text: '周五前改完周报模板', trigger: '下周一', evidence: { messageId: 'u1', quote: '周五前把周报模板' } }],
        threads: [{ text: '周报模板改版', next: '', evidence: { messageId: 'a1', quote: '改完发你确认' } }],
      },
      messages,
      { now, coveredThroughRowid: 1 },
    );
    expect(proven.commitments[0]).toMatchObject({ id: 'c1', trigger: '下周一', updatedAt: now });
    expect(proven.threads[0]).toMatchObject({ id: 't1', status: 'active', updatedAt: now });
    expect(proven.threads[0]).not.toHaveProperty('next');
    // 字段省略 → 沿用旧值,不算变化。
    const omitted = applyWorkingMemoryProposal(
      previous,
      { ...base, threads: [{ text: '周报模板改版', evidence: { messageId: 'a1', quote: '改完发你确认' } }] },
      messages,
      { now, coveredThroughRowid: 1 },
    );
    expect(omitted.threads[0]).toMatchObject({ id: 't1', next: '发用户确认', updatedAt: 1 });
  });

  it('prunes items that came from deleted messages', () => {
    const memory: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      commitments: [
        { id: 'c1', text: '来自被删轮次的承诺', messageId: 'gone', updatedAt: 1 },
        { id: 'c2', text: '仍然有效的承诺', messageId: 'kept', updatedAt: 2 },
        { id: 'c3', text: '没有来源记录的旧承诺', updatedAt: 3 },
      ],
      corrections: [{ id: 'x', text: '被删的纠正', messageId: 'gone', updatedAt: 1 }],
    };
    const { memory: pruned, removed } = pruneWorkingMemoryForMessages(memory, new Set(['gone']));
    expect(removed).toBe(2);
    expect(pruned.commitments.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(pruned.corrections).toEqual([]);
  });

  it('caps each section to its limit keeping the newest', () => {
    const previous: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      threads: Array.from({ length: WORKING_MEMORY_LIMITS.threads }, (_, i) => ({
        id: `t${i}`, text: `旧线索 ${i}`, status: 'active' as const, updatedAt: i + 1,
      })),
    };
    const next = applyWorkingMemoryProposal(
      previous,
      { threads: [{ text: '新线索', evidence: { messageId: 'u1', quote: '周报模板' } }], commitments: [], waiting: [], corrections: [], recentlyDone: [], resolved: [] },
      messages,
      { now, coveredThroughRowid: 1 },
    );
    expect(next.threads).toHaveLength(WORKING_MEMORY_LIMITS.threads);
    expect(next.threads[0]!.text).toBe('新线索');
    expect(next.threads.map((t) => t.text)).not.toContain('旧线索 0');
  });
});

describe('renderWorkingMemory', () => {
  const memory: BotWorkingMemory = {
    ...emptyWorkingMemory(),
    corrections: [{ id: 'x', text: '先结论后细节', supersedes: '旧格式', messageId: 'u1', updatedAt: 1 }],
    commitments: [{ id: 'c', text: '周五前改完周报模板', trigger: '周五前', updatedAt: 1 }],
    waiting: [{ id: 'w', text: '用户确认配色', on: 'user', updatedAt: 1 }],
    threads: [{ id: 't', text: '周报模板改版', status: 'active', next: '发用户确认', updatedAt: 1 }],
    recentlyDone: [{ id: 'd', text: '测试已补上', updatedAt: 1 }],
  };

  it('renders every section with message references and the not-authorization guidance', () => {
    const text = renderWorkingMemory(memory, { openTasks: [{ id: 'd-1', objective: '跑夜间回归', status: 'running' }] })!;
    expect(text.startsWith(WORKING_MEMORY_HEADING)).toBe(true);
    expect(text).toContain('not authorization');
    expect(text).toContain('- 先结论后细节 [supersedes: 旧格式] (message_id: u1)');
    expect(text).toContain('- 周五前改完周报模板 [when: 周五前]');
    expect(text).toContain('- user: 用户确认配色');
    expect(text).toContain('[running] 跑夜间回归 (task_id: d-1)');
    expect(text).toContain('- [active] 周报模板改版 → next: 发用户确认');
    expect(text).toContain('Recently completed');
  });

  it('drops trailing sections first (newest-last region) and keeps corrections, commitments and waiting', () => {
    const full = renderWorkingMemory(memory)!;
    const text = renderWorkingMemory(memory, {}, full.length - 1)!;
    expect(text.length).toBeLessThanOrEqual(full.length - 1);
    expect(text).toContain('先结论后细节');
    expect(text).toContain('周五前改完周报模板');
    expect(text).toContain('用户确认配色');
    expect(text).toContain('Open threads');
    expect(text).not.toContain('Recently completed');
  });

  it('always stays within the budget: protected sections shed their oldest items, each keeping at least one', () => {
    const big = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `${prefix} ${'很长的条目内容'.repeat(20)} ${i}`, updatedAt: n - i }));
    const bloated: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      corrections: big('纠正', 8),
      commitments: big('承诺', 10),
      waiting: big('等待', 6).map((w) => ({ ...w, on: 'user' as const })),
    };
    const budget = 1_500;
    const text = renderWorkingMemory(bloated, {}, budget)!;
    expect(text.length).toBeLessThanOrEqual(budget);
    // 最新的(列表最前)留着,最旧的先被裁。
    expect(text).toContain('纠正 ');
    expect(text).toContain('承诺 ');
    expect(text).toContain('等待 ');
    expect(text).toContain('纠正 很长');
    expect(text).not.toContain(' 7\n');
    // 只有线索也会被裁进预算,而不是因为"区数不足"直接发超预算文本。
    const threadsOnly: BotWorkingMemory = { ...emptyWorkingMemory(), threads: big('线索', 8).map((t) => ({ ...t, status: 'active' as const })) };
    expect(renderWorkingMemory(threadsOnly, {}, 600)!.length).toBeLessThanOrEqual(600);
  });

  it('returns null for an empty ledger', () => {
    expect(renderWorkingMemory(emptyWorkingMemory())).toBeNull();
  });
});

describe('store', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips through the Bot Home file with CAS on revision', async () => {
    expect(await readBotWorkingMemory(root, 'bot-1')).toBeNull();
    const first = await writeBotWorkingMemory(
      root,
      'bot-1',
      { ...emptyWorkingMemory(), updatedAt: 5, commitments: [{ id: 'c', text: '承诺', updatedAt: 5 }] },
      0,
    );
    expect(first.revision).toBe(1);
    expect(workingMemoryPath(root, 'bot-1')).toBe(path.join(root, 'bots', 'bot-1', 'working-memory.json'));
    const stored = await readBotWorkingMemory(root, 'bot-1');
    expect(stored).toMatchObject({ revision: 1, commitments: [{ text: '承诺' }] });
    await expect(writeBotWorkingMemory(root, 'bot-1', emptyWorkingMemory(), 0)).rejects.toBeInstanceOf(WorkingMemoryRevisionConflict);
    await expect(writeBotWorkingMemory(root, 'bot-1', emptyWorkingMemory(), 1)).resolves.toMatchObject({ revision: 2 });
    expect((await fs.readdir(path.join(root, 'bots', 'bot-1'))).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('drops items whose source message was rewound or tombstoned at render time, and prunes them after a rewind', async () => {
    await writeBotWorkingMemory(
      root,
      'bot-1',
      {
        ...emptyWorkingMemory(),
        updatedAt: 1,
        commitments: [
          { id: 'c-live', text: '仍在时间线上的承诺', messageId: 'live', updatedAt: 3 },
          { id: 'c-rewound', text: '被编辑上一条消息撤回的承诺', messageId: 'rewound', updatedAt: 2 },
          { id: 'c-gone', text: '来源已成墓碑的承诺', messageId: 'tomb', updatedAt: 1 },
        ],
        corrections: [{ id: 'x', text: '被撤回轮次里的纠正', messageId: 'rewound', updatedAt: 2 }],
      },
      0,
    );
    const dbRows = [
      { clientId: 'live', rewindAt: null, role: 'assistant', createdAt: 10 },
      { clientId: 'rewound', rewindAt: 1_700_000_000_000, role: 'user', createdAt: 10 },
      { clientId: 'tomb', rewindAt: null, role: 'message_tombstone', createdAt: 10 },
    ];
    // 渲染:伙伴归属 → 会话 cleared_at → 来源存活 → 后台任务。
    db.queue.push([{ botId: 'bot-1' }], [{ clearedAt: null }], dbRows, []);
    const note = (await readWorkingMemoryNoteForSession('s-bot', root))!;
    expect(note).toContain('仍在时间线上的承诺');
    expect(note).not.toContain('撤回');
    expect(note).not.toContain('墓碑');
    // 磁盘上还没清;rewind 提交后对账持久清掉。
    expect((await readBotWorkingMemory(root, 'bot-1'))!.commitments).toHaveLength(3);
    db.queue.push([{ botId: 'bot-1' }], [{ clearedAt: null }], dbRows);
    expect(await pruneWithdrawnWorkingMemoryForSession('s-bot', root)).toBe(3);
    const after = (await readBotWorkingMemory(root, 'bot-1'))!;
    expect(after.commitments.map((c) => c.id)).toEqual(['c-live']);
    expect(after.corrections).toEqual([]);
    expect(after.revision).toBe(2);
    // 非伙伴主对话:不渲染也不清。
    db.queue.push([]);
    expect(await readWorkingMemoryNoteForSession('s-task', root)).toBeNull();
    db.queue.push([]);
    expect(await pruneWithdrawnWorkingMemoryForSession('s-task', root)).toBe(0);
  });

  it('treats items whose source message predates /clear as withdrawn, and prunes them after the clear is persisted', async () => {
    await writeBotWorkingMemory(
      root,
      'bot-1',
      {
        ...emptyWorkingMemory(),
        updatedAt: 1,
        commitments: [
          { id: 'c-after', text: '清空之后答应的事', messageId: 'after', updatedAt: 3 },
          { id: 'c-before', text: '清空之前答应的事', messageId: 'before', updatedAt: 2 },
        ],
        corrections: [{ id: 'x-before', text: '清空之前的纠正', messageId: 'before', updatedAt: 2 }],
        waiting: [{ id: 'w-before', text: '清空之前在等的回复', messageId: 'before', on: 'user', updatedAt: 2 }],
      },
      0,
    );
    const clearedAt = 1_000;
    const dbRows = [
      { clientId: 'after', rewindAt: null, role: 'assistant', createdAt: clearedAt + 1 },
      // 清空边界本身也算清空前(与 listMessagesForAgentHandoff 的 createdAt > clearedAt 一致)。
      { clientId: 'before', rewindAt: null, role: 'user', createdAt: clearedAt },
    ];
    db.queue.push([{ botId: 'bot-1' }], [{ clearedAt }], dbRows, []);
    const note = (await readWorkingMemoryNoteForSession('s-bot', root))!;
    expect(note).toContain('清空之后答应的事');
    expect(note).not.toContain('清空之前');
    db.queue.push([{ botId: 'bot-1' }], [{ clearedAt }], dbRows);
    expect(await pruneWithdrawnWorkingMemoryForSession('s-bot', root)).toBe(3);
    const after = (await readBotWorkingMemory(root, 'bot-1'))!;
    expect(after.commitments.map((c) => c.id)).toEqual(['c-after']);
    expect(after.corrections).toEqual([]);
    expect(after.waiting).toEqual([]);
  });

  it('treats a corrupt or foreign file as no ledger', async () => {
    await fs.mkdir(path.join(root, 'bots', 'bot-2'), { recursive: true });
    await fs.writeFile(workingMemoryPath(root, 'bot-2'), '{not json', 'utf8');
    expect(await readBotWorkingMemory(root, 'bot-2')).toBeNull();
    expect(parseWorkingMemory({ version: 99, threads: [{ text: 'x' }] }).threads).toEqual([]);
    expect(parseWorkingMemory({ version: 1, revision: 2, threads: [{ id: 'a', text: '  多  空格 ', status: 'blocked' }] }))
      .toMatchObject({ revision: 2, threads: [{ id: 'a', text: '多 空格', status: 'blocked' }] });
  });
});

describe('helpers', () => {
  it('freshness compares the covered row against the latest completed reply', () => {
    expect(isWorkingMemoryFresh(null, 1)).toBe(false);
    expect(isWorkingMemoryFresh({ ...emptyWorkingMemory(), coveredThroughRowid: 9 }, 10)).toBe(false);
    expect(isWorkingMemoryFresh({ ...emptyWorkingMemory(), coveredThroughRowid: 10 }, 10)).toBe(true);
  });

  it('review view omits ids and timestamps', () => {
    const view = workingMemoryForReview({
      ...emptyWorkingMemory(),
      waiting: [{ id: 'w', text: '等确认', on: 'external', updatedAt: 3 }],
    });
    expect(view).toEqual({ threads: [], commitments: [], waiting: [{ text: '等确认', on: 'external' }], corrections: [], recentlyDone: [] });
  });

  it('refresh registry consumes only the generation that was read, so a compaction during an in-flight send survives', () => {
    const registry = createWorkingMemoryRefreshRegistry();
    expect(registry.pendingGeneration('s')).toBeNull();
    registry.markCompacted('s');
    const first = registry.pendingGeneration('s')!;
    expect(first).toBeGreaterThan(0);
    // 发送在途时又压缩了一次:新一代替换旧一代。
    registry.markCompacted('s');
    const second = registry.pendingGeneration('s')!;
    expect(second).toBeGreaterThan(first);
    registry.consume('s', first);
    expect(registry.pendingGeneration('s')).toBe(second);
    registry.consume('s', second);
    expect(registry.pendingGeneration('s')).toBeNull();
    // /clear:清空前登记的标记作废,清空后第一次发送不再注入旧账本;其它会话不受影响。
    registry.markCompacted('s');
    registry.markCompacted('other');
    registry.reset('s');
    expect(registry.pendingGeneration('s')).toBeNull();
    expect(registry.pendingGeneration('other')).not.toBeNull();
    const note = buildWorkingMemoryRefreshNote('BODY');
    expect(note).toContain('[Working memory refresh');
    expect(note).toContain('BODY');
    expect(note.trimEnd().endsWith("== End of working memory refresh; the user's new message follows ==")).toBe(true);
  });
});
