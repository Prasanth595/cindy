import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, invalidateMobileAuthOwnerForSwitch, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import * as quotes from '@/session/chatQuoteStore';

const store = vi.hoisted(() => new Map<string, string>());

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

describe('chatQuoteStore', () => {
  beforeEach(async () => {
    setMobileAuthOwner('quote-owner', 'global');
    vi.useRealTimers();
    vi.clearAllMocks();
    const { __testing } = await import('@/session/chatQuoteStore');
    __testing.reset();
    store.clear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { __testing } = await import('@/session/chatQuoteStore');
    __testing.reset();
    store.clear();
    setMobileAuthOwner(null);
  });

  // Unit privacy regression: the same shared task ID exists for two owners.
  // Prior tests exercised only one owner and did not cover retired callbacks.
  it.each(['account', 'realm'] as const)('keeps quotes private across %s changes and rejects old edits', (scope) => {
    const owner = getMobileAuthOwner();
    quotes.appendQuote('shared', { text: 'A quote' });
    invalidateMobileAuthOwnerForSwitch();
    setMobileAuthOwner(scope === 'account' ? 'other-owner' : 'quote-owner', scope === 'realm' ? 'cn' : 'global');
    expect(quotes.getQuotes('shared')).toEqual([]);
    quotes.appendQuote('shared', { text: 'B quote' });
    quotes.appendQuote('shared', { text: 'late A quote' }, owner);
    quotes.clearQuotes('shared', owner);
    expect(quotes.getQuotes('shared')).toEqual([{ text: 'B quote' }]);
    setMobileAuthOwner('quote-owner', 'global');
    expect(quotes.getQuotes('shared')).toEqual([{ text: 'A quote' }]);
  });

  it('ignores a retired hydrate while allowing a new generation of the same owner to hydrate', async () => {
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    let finish!: (value: string | null) => void;
    vi.mocked(storage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = quotes.hydrateQuotes('shared');
    setMobileAuthOwner('other-owner', 'global');
    setMobileAuthOwner('quote-owner', 'global');
    store.set(quotes.__testing.storageKeyForSession('shared'), JSON.stringify([{ text: 'current disk quote' }]));
    await quotes.hydrateQuotes('shared');
    finish(JSON.stringify([{ text: 'retired read' }]));
    await first;
    expect(quotes.getQuotes('shared')).toEqual([{ text: 'current disk quote' }]);
  });

  it('does not claim legacy quote storage or accept signed-out edits', async () => {
    store.set('xdt.chatQuotes.v1.shared', JSON.stringify([{ text: 'unowned quote' }]));
    await quotes.hydrateQuotes('shared');
    expect(quotes.getQuotes('shared')).toEqual([]);
    setMobileAuthOwner(null);
    quotes.appendQuote('shared', { text: 'signed-out quote' });
    expect(quotes.getQuotes('shared')).toEqual([]);
    expect(store.has('xdt.chatQuotes.v1.shared')).toBe(true);
  });

  it('appends quotes, notifies subscribers, and clears all at once', async () => {
    const { appendQuote, clearQuotes, getQuotes, subscribeQuotes } = await import('@/session/chatQuoteStore');
    const seen: number[] = [];
    const unsubscribe = subscribeQuotes('s1', () => seen.push(getQuotes('s1').length));

    appendQuote('s1', { text: 'first' });
    appendQuote('s1', { text: 'second', sourcePath: 'docs/a.md' });
    expect(getQuotes('s1')).toEqual([
      { text: 'first' },
      { text: 'second', sourcePath: 'docs/a.md' },
    ]);
    expect(seen).toEqual([1, 2]);
    expect(getQuotes('s2')).toEqual([]);

    clearQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
    expect(seen).toEqual([1, 2, 0]);
    unsubscribe();
  });

  it('ignores empty-text quotes', async () => {
    const { appendQuote, getQuotes } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: '' });
    expect(getQuotes('s1')).toEqual([]);
  });

  it('persists after the debounce window and hydrates on cold start', async () => {
    vi.useFakeTimers();
    const { __testing, appendQuote } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: 'kept', sourcePath: 'src/x.ts' });
    vi.advanceTimersByTime(__testing.persistDebounceMs + 10);
    vi.useRealTimers();
    await flushMicrotasks();
    expect(JSON.parse(store.get(__testing.storageKeyForSession('s1')) ?? '[]')).toEqual([
      { text: 'kept', sourcePath: 'src/x.ts' },
    ]);

    // 冷启动:内存清空后 hydrate 从 AsyncStorage 回填并通知订阅方。
    __testing.reset();
    const { getQuotes, hydrateQuotes, subscribeQuotes } = await import('@/session/chatQuoteStore');
    const seen: number[] = [];
    subscribeQuotes('s1', () => seen.push(getQuotes('s1').length));
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([{ text: 'kept', sourcePath: 'src/x.ts' }]);
    expect(seen).toEqual([1]);
  });

  it('does not resurrect cleared quotes on hydrate (cleared marker wins)', async () => {
    const { __testing, appendQuote, clearQuotes, getQuotes, hydrateQuotes } = await import('@/session/chatQuoteStore');
    store.set(__testing.storageKeyForSession('s1'), JSON.stringify([{ text: 'stale' }]));
    appendQuote('s1', { text: 'live' });
    clearQuotes('s1');
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
  });

  it('setQuotes restores a snapshot (send-failure recovery) and empty array clears', async () => {
    const { appendQuote, clearQuotes, getQuotes, setQuotes } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: 'a' });
    const snapshot = [...getQuotes('s1')];
    clearQuotes('s1');
    setQuotes('s1', snapshot);
    expect(getQuotes('s1')).toEqual([{ text: 'a' }]);
    setQuotes('s1', []);
    expect(getQuotes('s1')).toEqual([]);
  });

  it('preserves an ordered fork/rewind body only while visible text and quotes are unchanged', async () => {
    vi.useFakeTimers();
    const {
      __testing,
      hydrateQuotes,
      resolveOrderedQuoteDraft,
      setOrderedQuoteDraft,
      setQuotes,
    } = await import('@/session/chatQuoteStore');
    const quotes = [{ text: 'A' }, { text: 'B', sourcePath: 'docs/b.md' }];
    const orderedDraft = {
      encodedBody: [
        '> <!-- cindy-composer-quote -->',
        '> A',
        '',
        'reply A',
        '',
        '> <!-- cindy-composer-quote -->',
        '> B',
        '> — source: docs/b.md',
        '',
        'reply B',
      ].join('\n'),
      projectedText: 'reply A\n\nreply B',
    };

    setOrderedQuoteDraft('s1', quotes, orderedDraft);
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, quotes)).toEqual(orderedDraft);
    expect(resolveOrderedQuoteDraft('s1', 'edited', quotes)).toBeNull();
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, [quotes[1], quotes[0]])).toBeNull();

    // 发送失败期间新采集的引用不在原 encodedBody 里，必须丢弃旧顺序基线，
    // 否则重试会误命中并静默漏发 C。
    const expandedQuotes = [...quotes, { text: 'C' }];
    setOrderedQuoteDraft('s-extra', expandedQuotes, orderedDraft);
    expect(resolveOrderedQuoteDraft('s-extra', orderedDraft.projectedText, expandedQuotes)).toBeNull();

    vi.advanceTimersByTime(__testing.persistDebounceMs + 10);
    vi.useRealTimers();
    await flushMicrotasks();
    __testing.reset();
    await hydrateQuotes('s1');
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, quotes)).toEqual(orderedDraft);

    // 普通引用更新明确让旧顺序基线失效。
    setQuotes('s1', quotes);
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, quotes)).toBeNull();
  });

  it('drops malformed persisted payloads on hydrate', async () => {
    const { __testing, getQuotes, hydrateQuotes } = await import('@/session/chatQuoteStore');
    store.set(__testing.storageKeyForSession('s1'), '{"not":"an array"}');
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
  });

  it('truncateQuoteText caps at QUOTE_MAX_CHARS with an ellipsis', async () => {
    const { QUOTE_MAX_CHARS, truncateQuoteText } = await import('@/session/chatQuoteStore');
    const long = 'x'.repeat(QUOTE_MAX_CHARS + 20);
    const truncated = truncateQuoteText(long);
    expect(truncated).toHaveLength(QUOTE_MAX_CHARS + 1);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncateQuoteText('short')).toBe('short');
  });
});
