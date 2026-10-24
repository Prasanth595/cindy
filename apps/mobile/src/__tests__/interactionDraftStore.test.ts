import { beforeEach, describe, expect, it } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  clearAllInteractionDrafts,
  clearAskUserDraft,
  clearPlanReviewDraft,
  readAskUserDraft,
  readPlanReviewDraft,
  saveAskUserDraft,
  savePlanReviewDraft,
} from '@/session/interactionDraftStore';

describe('interactionDraftStore', () => {
  beforeEach(() => {
    setMobileAuthOwner('interaction-owner', 'global');
    clearAllInteractionDrafts();
  });

  // Unit: request IDs are shared with the other participants. A delayed form
  // save or receipt must neither expose nor clear the next account's answer.
  it.each(['account', 'realm'] as const)('isolates question and plan drafts across %s switches', (scope) => {
    const owner = getMobileAuthOwner();
    const answer = { answers: {}, currentIndex: 0, customInput: 'A', selectedLabels: [], showCustomInput: true };
    const plan = { feedback: 'A', feedbackOpen: true, planText: 'plan' };
    saveAskUserDraft('shared-request', answer);
    savePlanReviewDraft('shared-plan', plan);
    setMobileAuthOwner(scope === 'account' ? 'other-owner' : 'interaction-owner', scope === 'realm' ? 'cn' : 'global');
    expect(readAskUserDraft('shared-request')).toBeNull();
    expect(readPlanReviewDraft('shared-plan')).toBeNull();
    saveAskUserDraft('shared-request', { ...answer, customInput: 'B' });
    savePlanReviewDraft('shared-plan', { ...plan, feedback: 'B' });
    saveAskUserDraft('shared-request', answer, owner);
    savePlanReviewDraft('shared-plan', plan, owner);
    clearAskUserDraft('shared-request', owner);
    clearPlanReviewDraft('shared-plan', owner);
    expect(readAskUserDraft('shared-request')?.customInput).toBe('B');
    expect(readPlanReviewDraft('shared-plan')?.feedback).toBe('B');
    setMobileAuthOwner('interaction-owner', 'global');
    expect(readAskUserDraft('shared-request')?.customInput).toBe('A');
    expect(readPlanReviewDraft('shared-plan')?.feedback).toBe('A');
  });

  it('stores ask-user drafts by request id and returns defensive clones', () => {
    saveAskUserDraft('req-1', {
      answers: { q1: 'Yes' },
      currentIndex: 1,
      customInput: 'partial',
      selectedLabels: ['A'],
      showCustomInput: true,
    });

    const first = readAskUserDraft('req-1');
    expect(first).toEqual({
      answers: { q1: 'Yes' },
      currentIndex: 1,
      customInput: 'partial',
      selectedLabels: ['A'],
      showCustomInput: true,
    });

    first!.answers.q1 = 'Mutated';
    first!.selectedLabels.push('B');
    expect(readAskUserDraft('req-1')).toEqual({
      answers: { q1: 'Yes' },
      currentIndex: 1,
      customInput: 'partial',
      selectedLabels: ['A'],
      showCustomInput: true,
    });
  });

  it('clears one request without touching other drafts', () => {
    saveAskUserDraft('req-1', {
      answers: {},
      currentIndex: 0,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });
    saveAskUserDraft('req-2', {
      answers: { q: 'answer' },
      currentIndex: 0,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });

    clearAskUserDraft('req-1');

    expect(readAskUserDraft('req-1')).toBeNull();
    expect(readAskUserDraft('req-2')?.answers).toEqual({ q: 'answer' });
  });

  it('ignores empty request ids and normalizes current index', () => {
    saveAskUserDraft('', {
      answers: {},
      currentIndex: 0,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });
    saveAskUserDraft('req-1', {
      answers: {},
      currentIndex: 1.8,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });

    expect(readAskUserDraft('')).toBeNull();
    expect(readAskUserDraft('req-1')?.currentIndex).toBe(1);
  });

  it('stores plan review drafts across remounts until the request resolves', () => {
    savePlanReviewDraft('plan-1', {
      feedback: '请补充风险控制',
      feedbackOpen: true,
      planText: '# Edited plan',
    });

    const draft = readPlanReviewDraft('plan-1');
    expect(draft).toEqual({
      feedback: '请补充风险控制',
      feedbackOpen: true,
      planText: '# Edited plan',
    });

    draft!.planText = '# Mutated';
    expect(readPlanReviewDraft('plan-1')?.planText).toBe('# Edited plan');

    clearPlanReviewDraft('plan-1');
    expect(readPlanReviewDraft('plan-1')).toBeNull();
  });
});
