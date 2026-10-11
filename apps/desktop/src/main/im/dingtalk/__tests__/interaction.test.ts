import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DingTalkIM } from '@cindy/im';

import { setMainLocale } from '../../../i18n';
import { __testing, handleDingTalkTextInteraction } from '../interaction';
import { presentChannelQuestionnaire } from '../../../maker-ipc/channelQuestionnaire';
import { createSharedPermission } from '../../../maker-ipc/sharedPermission';

beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('zh-CN'));

describe('dingtalk text interactions', () => {
  it('settles the shared permission when the text reply times out', async () => {
    const sharedPermission = createSharedPermission();
    const im = {
      requestTextReply: vi.fn(async () => { throw new Error('DINGTALK_INTERACTION_TIMEOUT'); }),
      sendText: vi.fn(async () => {}),
    } as unknown as DingTalkIM;
    await expect(handleDingTalkTextInteraction(im, 'owner', {
      kind: 'permission', requestId: 'timeout', toolName: 'Bash', input: {},
    }, { sharedPermission })).resolves.toMatchObject({ kind: 'permission', behavior: 'deny' });
    expect(sharedPermission.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    await expect(sharedPermission.result).resolves.toMatchObject({ reason: 'dingtalk_interaction_timeout_or_cancelled' });
  });

  it('parses explicit allow and deny replies', () => {
    const request = {
      kind: 'permission' as const,
      requestId: 'request-1',
      toolName: 'shell_command',
      input: {},
    };
    expect(__testing.parseInteractionReply(request, '允许')).toEqual({
      kind: 'permission',
      behavior: 'allow',
    });
    expect(__testing.parseInteractionReply(request, '拒绝')).toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'dingtalk_user_denied',
    });
  });

  it('自动审批故障时在钉钉确认提示里写明原因', () => {
    const ordinary = __testing.formatInteractionPrompt({
      kind: 'permission',
      requestId: 'request-1',
      toolName: 'shell_command',
      input: {},
    });
    expect(ordinary).toBe('需要确认操作：shell_command\n回复“允许”继续，或回复“拒绝”取消。');

    const unavailable = __testing.formatInteractionPrompt({
      kind: 'permission',
      requestId: 'request-1',
      toolName: 'shell_command',
      input: {},
      metadata: { autoReviewUnavailable: true },
    });
    expect(unavailable).toContain('自动审批没完成，请确认要不要允许这次操作。');
    expect(unavailable).toContain('需要确认操作：shell_command');
    expect(unavailable).toContain('回复“允许”继续');
  });

  it('maps a numbered answer to the matching option label', () => {
    const request = {
      kind: 'ask_user_question' as const,
      requestId: 'request-2',
      questions: [
        {
          question: '选择方向',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };
    expect(__testing.parseInteractionReply(request, '2')).toEqual({
      kind: 'ask_user_question',
      answers: { 选择方向: 'B' },
    });
  });

  it('asks multiple questions one at a time', async () => {
    const replies = ['2', 'custom'];
    const requestTextReply = vi.fn(
      async <T>(_userId: string, _prompt: string, parse: (text: string) => T | null) =>
        parse(replies.shift() ?? '') as T,
    );
    const im = { requestTextReply } as unknown as DingTalkIM;
    const request = {
      kind: 'ask_user_question' as const,
      requestId: 'request-3',
      questions: [
        { question: '方向', options: [{ label: 'A' }, { label: 'B' }] },
        { question: '备注' },
      ],
    };

    await expect(handleDingTalkTextInteraction(im, 'owner-1', request)).resolves.toEqual({
      kind: 'ask_user_question',
      answers: { 方向: 'B', 备注: 'custom' },
    });
    expect(requestTextReply).toHaveBeenCalledTimes(2);
    expect(requestTextReply.mock.calls[0][1]).toContain('（1/2）');
    expect(requestTextReply.mock.calls[1][1]).toContain('（2/2）');
  });
});

it('preserves earlier answers and stops after a question times out', async () => {
  const requestTextReply = vi.fn().mockResolvedValueOnce('first answer')
    .mockRejectedValueOnce(new Error('DINGTALK_INTERACTION_TIMEOUT'));
  const im = { requestTextReply } as unknown as DingTalkIM;
  await expect(handleDingTalkTextInteraction(im, 'owner', {
    kind: 'ask_user_question', requestId: 'questions',
    questions: ['First?', 'Second?', 'Third?'].map(question => ({ question })),
  }, { timeoutMs: 123 })).resolves.toEqual({
    kind: 'ask_user_question', answers: { 'First?': 'first answer' }, dismissed: true,
  });
  expect(requestTextReply).toHaveBeenCalledTimes(2);
  expect(requestTextReply.mock.calls[1].slice(3)).toEqual([123, undefined, 'questions']);
});

it('does not label every paginated question as the entire questionnaire', async () => {
  const requestTextReply = vi.fn(async (_userId: string, _prompt: string) => 'answer');
  const im = { requestTextReply } as unknown as DingTalkIM;
  await expect(presentChannelQuestionnaire({
    kind: 'ask_user_question', requestId: 'paged',
    questions: ['First?', 'Second?', 'Third?'].map(question => ({ question })),
  }, page => handleDingTalkTextInteraction(im, 'owner', page), undefined, undefined, true))
    .resolves.toEqual({ kind: 'ask_user_question', answers: {
      'First?': 'answer', 'Second?': 'answer', 'Third?': 'answer',
    } });
  expect(requestTextReply).toHaveBeenCalledTimes(3);
  for (const [, prompt] of requestTextReply.mock.calls) {
    expect(prompt).not.toContain('（1/1）');
    expect(prompt).toContain('需要你补充信息：');
  }
});

it.each([
  ['zh-CN', '需要你补充信息：', '请回复选项序号或你的答案。'],
  ['zh-TW', '需要你補充資訊：', '請回覆選項編號或你的答案。'],
  ['en', 'Answer needed: ', 'Reply with an option number or your answer.'],
  ['ja', '回答が必要です：', '選択肢の番号または回答を入力してください。'],
  ['ko', '답변이 필요합니다: ', '선택지 번호나 답변을 입력해 주세요.'],
] as const)('localizes paginated DingTalk prompts in %s', (locale, prefix, hint) => {
  setMainLocale(locale);
  expect(__testing.formatQuestionPrompt({ question: 'Question?' }, 0, 1))
    .toBe(`${prefix}Question?\n${hint}`);
});
