/**
 * 测试价值
 * - 生产入口与可观察结果:boundTranscript / lastExchange 的输出(伙伴读到的摘录与任务摘要的两句)。
 * - 规则依据:工作台摘录有界且去掉指令块;get_task_digest 取「主人最后的要求 / 助手最后一句」。
 * - 现有覆盖缺口:放弃「项目」后本机转录扫描已删除(其测试随之删除);lastExchange 为新增。
 * - 最小失败输入:末尾是空助手消息 / 指令块;多行助手回复。
 * - tier:unit(纯函数,数据库模块 mock 掉,不加载)。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => { throw new Error('not used'); } }));

import { boundTranscript, lastExchange } from '../botWorkbenchTranscripts.js';

describe('boundTranscript', () => {
  it('strips instruction blocks, drops empty messages and keeps the most recent within the budget', () => {
    const items = [
      { role: 'user' as const, text: 'old '.repeat(400), at: 1 },
      { role: 'assistant' as const, text: '<system-reminder>internal</system-reminder>', at: 2 },
      { role: 'user' as const, text: '把图标导出来', at: 3 },
      { role: 'assistant' as const, text: '导好了 mdpi,还差 xxhdpi', at: 4 },
    ];
    const bounded = boundTranscript(items, 200);
    expect(bounded.items.map((item) => item.at)).toEqual([1, 3, 4]);
    expect(bounded.items[0].text.startsWith('…')).toBe(true);
    expect(bounded.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(200);
    expect(bounded.truncated).toBe(true);
    expect(boundTranscript(items.slice(2)).truncated).toBe(false);
  });
});

describe('lastExchange', () => {
  it('takes the latest owner ask and the last line of the latest non-empty assistant reply', () => {
    expect(lastExchange([
      { role: 'user', text: '先修登录' },
      { role: 'assistant', text: '好的' },
      { role: 'user', text: '<system-reminder>internal</system-reminder>再跑一遍测试' },
      { role: 'assistant', text: '跑完了。\n还有 2 个失败' },
      { role: 'assistant', text: '<system-reminder>only a hint</system-reminder>' },
    ])).toEqual({ lastUserAsk: '再跑一遍测试', lastAssistantLine: '还有 2 个失败' });
    expect(lastExchange([])).toEqual({ lastUserAsk: null, lastAssistantLine: null });
  });
});
