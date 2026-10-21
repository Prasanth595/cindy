// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { AskUserQuestionItem, PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

import type { VoiceQuestionBridge } from '../components/new-chat/voiceQuestionSelection';

const start = vi.fn(() => true);
const stop = vi.fn(async () => undefined);

// Stateful stand-in for the dictation hook: starting flips the card into the
// busy state, which is what disables question navigation.
vi.mock('../components/new-chat/useAskUserDictation', () => ({
  useAskUserDictation: () => {
    const [state, setState] = useState<'idle' | 'listening'>('idle');
    return {
      state,
      isBusy: state !== 'idle',
      liveText: null,
      lastError: null,
      start: () => {
        start();
        setState('listening');
        return true;
      },
      stop: async () => {
        await stop();
        setState('idle');
      },
    };
  },
}));

beforeEach(async () => {
  start.mockClear();
  stop.mockClear();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderAsk(questions: PendingAskUser['questions']) {
  const onAnswer = vi.fn();
  const view = render(createElement(AskUserQuestionPrompt, {
    sessionId: 'ask-voice',
    pending: { requestId: 'req-voice', questions },
    onAnswer,
    viewerState: 'expanded',
    onViewerStateChange: () => {},
    draft: null,
    onDraftChange: () => {},
  }));
  return { view, onAnswer };
}

describe('AskUserQuestion voice entry', () => {
  it('shows a voice button on the pinned free-text row and starts dictation from it', async () => {
    const { view } = renderAsk([
      { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ]);

    const voice = view.getByTestId('ask-user-voice');
    expect(voice.getAttribute('aria-label')).toContain('语音');
    fireEvent.click(voice);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(view.getByPlaceholderText('请输入回答…')).toBeTruthy();
  });

  it('keeps the voice button in the same bottom-pinned cluster as the send button', () => {
    const { view } = renderAsk([
      { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ]);
    fireEvent.click(view.getByText('输入其他回答…'));

    const voice = view.getByTestId('ask-user-voice');
    const cluster = voice.parentElement!;
    // Sharing one container is what keeps the two on the same center line as the
    // answer grows; self-end pins the pair to the row's bottom edge.
    expect(within(cluster).getByText('提交').tagName).toBe('BUTTON');
    expect(cluster.className).toContain('items-center');
    expect(cluster.className).toContain('self-end');
  });

  it('keeps a voice button when the question has no options', () => {
    const { view } = renderAsk([{ question: '补充一句' }]);
    const voice = view.getByTestId('ask-user-voice');
    expect(voice).toBeTruthy();
    expect(view.getByPlaceholderText('请输入回答…')).toBeTruthy();
    expect(within(voice.parentElement!).getByText('提交').tagName).toBe('BUTTON');
  });

  it('bottom-pins the voice button in multi-select where the row has no send button', () => {
    const { view } = renderAsk([
      { question: '选哪些？', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
    ]);
    fireEvent.click(view.getByText('输入其他回答…'));

    const voice = view.getByTestId('ask-user-voice');
    const cluster = voice.parentElement!;
    expect(within(cluster).queryByText('提交')).toBeNull();
    expect(cluster.className).toContain('self-end');
  });

  it('starts dictation from the global voice shortcut while the card is open', async () => {
    const previous = window.electronAPI;
    let trigger: ((payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void) | undefined;
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: typeof trigger) => {
          trigger = callback;
          return () => { trigger = undefined; };
        },
        claimGlobalShortcutTrigger: () => {},
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
    try {
      renderAsk([
        { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
      ]);
      await act(async () => { trigger?.({ id: 'shortcut-1', phase: 'start' }); });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
    } finally {
      window.electronAPI = previous;
    }
  });

  it('does not stop the recording on the tap that ends the press which started it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const previous = window.electronAPI;
    let trigger: ((payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void) | undefined;
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: typeof trigger) => {
          trigger = callback;
          return () => { trigger = undefined; };
        },
        claimGlobalShortcutTrigger: () => {},
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
    try {
      renderAsk([{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]);
      // Fake performance starts at zero; pass the initial 250ms shortcut guard.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'press-1', phase: 'start' }); });
      expect(start).toHaveBeenCalledOnce();

      // Short press: held past the 250ms dedupe window, still released quickly.
      // The release must not cancel the recording this same press started.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'press-1', phase: 'tap' }); });
      expect(stop).not.toHaveBeenCalled();

      // A new press while listening stops it.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'press-2', phase: 'start' }); });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      window.electronAPI = previous;
    }
  });

  it('starts dictation from a shortcut trigger without a phase (plain modifier combo)', async () => {
    const previous = window.electronAPI;
    let trigger: ((payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void) | undefined;
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: typeof trigger) => {
          trigger = callback;
          return () => { trigger = undefined; };
        },
        claimGlobalShortcutTrigger: () => {},
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
    try {
      renderAsk([{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]);
      // Plain modifier combos arrive without a phase; they must still start.
      await act(async () => { trigger?.({ id: 'combo-1' }); });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
    } finally {
      window.electronAPI = previous;
    }
  });

  it('stops when a held shortcut press is released', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const previous = window.electronAPI;
    let trigger: ((payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void) | undefined;
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: typeof trigger) => {
          trigger = callback;
          return () => { trigger = undefined; };
        },
        claimGlobalShortcutTrigger: () => {},
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
    try {
      renderAsk([{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]);
      // Fake performance starts at zero; pass the initial 250ms shortcut guard.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'hold-1', phase: 'start' }); });
      expect(start).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      // Held press released: `end` must stop, unlike the `tap` of a quick press.
      await act(async () => { trigger?.({ id: 'hold-1', phase: 'end' }); });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      window.electronAPI = previous;
    }
  });

  it('blocks question navigation and submit while dictation owns the answer', async () => {
    const { view } = renderAsk([
      { question: '第一题？', options: [{ label: '甲' }, { label: '乙' }] },
      { question: '第二题？', options: [{ label: '丙' }, { label: '丁' }] },
    ]);

    fireEvent.click(view.getByTestId('ask-user-voice'));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    // Switching questions mid-dictation would write the rest into another answer.
    for (const label of ['跳过', '下一题', '提交']) {
      const button = view.queryByText(label);
      if (button?.closest('button')) {
        expect((button.closest('button') as HTMLButtonElement).disabled).toBe(true);
      }
    }
    expect((view.getByText('跳过').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('companion voice mode integration', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  function setup(question: Partial<AskUserQuestionItem> = {}) {
    const voiceBridge: VoiceQuestionBridge = { current: null };
    const props = {
      sessionId: 'task',
      pending: {
        requestId: 'question-1',
        questions: [{ question: 'Choose a plan', options: [{ label: '简洁' }, { label: '详细' }, { label: '表格' }], ...question }],
      },
      onAnswer: vi.fn(),
      viewerState: 'expanded' as const,
      onViewerStateChange: vi.fn(),
      draft: null,
      onDraftChange: vi.fn(),
      voiceBridge,
    };
    const view = render(createElement(AskUserQuestionPrompt, props));
    const say = (text: string) => act(() => voiceBridge.current?.receive(text));
    return { view, props, say };
  }

  describe('ordinary question voice choices', () => {
    // The two independently implemented voice entries must not capture together.
    it('yields the microphone to conversation mode and restores standalone dictation when it closes', async () => {
      const f = setup();
      expect(f.view.queryByTestId('ask-user-voice')).toBeNull();
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, voiceBridge: undefined }));
      fireEvent.click(f.view.getByTestId('ask-user-voice'));
      expect(start).toHaveBeenCalledOnce();
      await act(async () => f.view.rerender(createElement(AskUserQuestionPrompt, f.props)));
      expect(stop).toHaveBeenCalledOnce();
      expect(f.view.queryByTestId('ask-user-voice')).toBeNull();
      f.say('第一项');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁' });
    });

    it.each(['第一项', '第一个', '我选简洁。', '简洁', 'first option', 'option 1', '第一個'])(
      'submits a clear single choice through the card: %s', (text) => {
        const f = setup();
        f.say(text);
        expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '简洁' });
        // No receipt yet: keep the original question and draft retryable.
        expect(f.view.getByText('Choose a plan')).toBeTruthy();
        expect(f.props.onDraftChange.mock.lastCall?.[0]?.answers).toEqual({ 'Choose a plan': '简洁' });
      },
    );

    it('numbers only visible options, not the upstream Other placeholder', () => {
      const f = setup({ options: [{ label: 'Other' }, { label: '简洁' }, { label: '详细' }] });
      f.say('第一项');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁' });
    });

    it('previews multi-select, allows cancellation, and confirms canonical visual order', () => {
      const f = setup({ multiSelect: true });
      f.say('第三项和第一项');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.selectedLabels).toEqual(['表格', '简洁']);
      f.say('取消选择');
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.selectedLabels).toEqual([]);
      f.say('确认选择');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      f.say('第三项和第一项');
      f.say('确认选择');
      expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '["简洁","表格"]' });
    });

    it.each(['第一项或第二项', '第一项和第二项', '不要选第一项', '他说第一项', '第九项', '简'])(
      'does not guess or submit ambiguous/unmatched speech: %s', (text) => {
        const f = setup();
        f.say(text);
        f.say('确认选择');
        expect(f.props.onAnswer).not.toHaveBeenCalled();
        expect(f.view.getByText(/No clear option recognized/)).toBeTruthy();
      },
    );

    it('requires disambiguation for duplicate labels', () => {
      const f = setup({ options: [{ label: '方案' }, { label: '方案。' }] });
      f.say('方案');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.view.getByText(/Your choice is unclear/)).toBeTruthy();
    });

    it('previews a free answer and confirms through the existing draft', () => {
      const f = setup({ options: [] });
      f.say('请安排在周六下午');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.customInput).toBe('请安排在周六下午');
      fireEvent.click(f.view.getByRole('button', { name: 'Submit' }));
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '请安排在周六下午' });
    });

    it('shares manual multi-selection and changes the ASR target on edits', () => {
      const f = setup({ multiSelect: true });
      f.say('第一项');
      const beforeEdit = f.props.voiceBridge.current;
      fireEvent.click(f.view.getByText('详细'));
      expect(f.props.voiceBridge.current).not.toBe(beforeEdit);
      f.say('确认选择');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '["简洁","详细"]' });
    });

    it('adds consecutive spoken choices without prematurely submitting', () => {
      const f = setup({ multiSelect: true });
      f.say('第一项');
      f.say('第三项');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      f.say('确认选择');
      expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '["简洁","表格"]' });
    });

    it('scopes targets to wizard steps and request identity, and removes them when voice closes', async () => {
      const f = setup();
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, pending: {
        ...f.props.pending, questions: [...f.props.pending.questions, { question: 'When?', options: [{ label: '明天' }] }],
      } }));
      const first = f.props.voiceBridge.current;
      f.say('第一项');
      expect(f.props.voiceBridge.current).toBeNull();
      await waitFor(() => expect(f.props.voiceBridge.current).not.toBeNull());
      expect(f.props.voiceBridge.current).not.toBe(first);
      act(() => first?.receive('第一项'));
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      f.say('明天');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁', 'When?': '明天' });
      const previous = f.props.voiceBridge.current;
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, pending: { ...f.props.pending, requestId: 'question-2' } }));
      expect(f.props.voiceBridge.current).not.toBe(previous);
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, voiceBridge: undefined }));
      expect(f.props.voiceBridge.current).toBeNull();
    });

    it('restores a minimized card for a voice answer', () => {
      const f = setup();
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, viewerState: 'minimized' }));
      f.say('第一项');
      expect(f.props.onViewerStateChange).toHaveBeenCalledWith('expanded');
    });
  });

});
