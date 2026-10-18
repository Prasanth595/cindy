import { describe, expect, it } from 'vitest';

import type { BotGroupOpenPlanSummary, BotGroupSummary } from '../../../../shared/botGroupChat';
import type { AgentIslandSessionActivity } from '../../../../shared/agentIsland';
import { botGroupNeedsAttention } from '../botGroupAttention';
import type { BotProfile } from '../botStore';

function summary(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: 'g1',
    name: '官网',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    organizerBotId: 'xiaoman',
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function openPlan(overrides: Partial<BotGroupOpenPlanSummary> = {}): BotGroupOpenPlanSummary {
  return {
    id: 'p1',
    status: 'waiting',
    currentStep: 0,
    stepCount: 3,
    currentBotName: '咪咪',
    currentStepStatus: 'done',
    ...overrides,
  };
}

function bot(id: string): BotProfile {
  return {
    id,
    name: id,
    avatar: '',
    avatarColor: 'red',
    description: '',
    skills: [],
    sessions: [{ id: `${id}-group`, kind: 'group' }],
  } as unknown as BotProfile;
}

describe('botGroupNeedsAttention', () => {
  it('分工停在等开始 / 等继续 / 等重试时提示', () => {
    expect(botGroupNeedsAttention(summary({ openPlan: openPlan({ status: 'proposed', currentStep: null }) }), [], new Map())).toBe(true);
    expect(botGroupNeedsAttention(summary({ openPlan: openPlan({ currentStepStatus: 'done' }) }), [], new Map())).toBe(true);
    expect(botGroupNeedsAttention(summary({ openPlan: openPlan({ currentStepStatus: 'failed' }) }), [], new Map())).toBe(true);
    expect(botGroupNeedsAttention(summary({ openPlan: openPlan({ currentBotName: null, currentStepStatus: null }) }), [], new Map())).toBe(true);
  });

  it('分工正在安排或正在做时不提示 —— 那是运行态,不是等用户', () => {
    expect(botGroupNeedsAttention(summary({ planningBotId: 'mimi' }), [], new Map())).toBe(false);
    expect(
      botGroupNeedsAttention(summary({ openPlan: openPlan({ status: 'running' }) }), [], new Map()),
    ).toBe(false);
    expect(botGroupNeedsAttention(summary(), [], new Map())).toBe(false);
  });

  it('发言 lane 进入 needs-interaction 时提示', () => {
    const activity = new Map<string, AgentIslandSessionActivity>([
      ['mimi-group', { sessionId: 'mimi-group', phase: 'needs-interaction' } as AgentIslandSessionActivity],
    ]);
    expect(
      botGroupNeedsAttention(summary({ speakingBotIds: ['mimi'] }), [bot('mimi')], activity),
    ).toBe(true);
    // 群专线以外普通会话的等待不算这个群的提醒。
    const otherSession = new Map<string, AgentIslandSessionActivity>([
      ['mimi-main', { sessionId: 'mimi-main', phase: 'needs-interaction' } as AgentIslandSessionActivity],
    ]);
    expect(
      botGroupNeedsAttention(summary({ speakingBotIds: ['mimi'] }), [bot('mimi')], otherSession),
    ).toBe(false);
  });
});
