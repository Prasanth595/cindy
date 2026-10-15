import { describe, expect, it } from 'vitest';
import { historyPrefetchVersion, historySnapshotCovers, historySnapshotFromPage, selectHistoryPrefetchSessions } from '../historyViewPrefetch.js';
import type { HistoryViewSnapshot } from '../historyViewController.js';
import type { HistoryMessageSource, HistoryViewItem, HistoryWorkSummary } from '../historyView.js';

const summary = (key: string, revision: string, endedAtMs = 0): HistoryWorkSummary => ({
  key, firstMessageId: `${key}-first`, lastMessageId: `${key}-last`, startedAtMs: 0, endedAtMs,
  isStreaming: false, messageCount: 1, toolCount: 1, revision,
});
const work = (key: string, revision: string, endedAtMs = 0): HistoryViewItem<HistoryMessageSource> =>
  ({ type: 'work', key, summary: summary(key, revision, endedAtMs) });
const detail = (revision: string) => ({ messages: [], revision, lastMessageId: 'x', loading: false, complete: true, error: null });

describe('history read ahead', () => {
  it('reads only the newest changed tasks it has not read at their current version', () => {
    const ms = (second: number) => Date.parse(`2026-10-11T00:00:0${second}Z`);
    const sessions = [
      { id: 'old', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'a', updatedAt: '2026-10-11T00:00:05Z' },
      // updatedAt stays at the turn start; the turn end is the newer activity.
      { id: 'ended', updatedAt: '2026-10-11T00:00:01Z', activeTurnStartedAt: ms(1), lastTurnEndedAt: ms(6) },
      { id: 'running', updatedAt: '2026-10-01T00:00:00Z', activeTurnStartedAt: ms(2), lastTurnEndedAt: ms(1) },
      { id: 'skip', updatedAt: '2026-10-11T00:00:09Z' },
      { id: 'done', updatedAt: '2026-10-11T00:00:04Z' },
    ];
    const pick = () => selectHistoryPrefetchSessions(sessions, {
      eligible: (session) => session.id !== 'skip',
      prefetchedAt: (id) => id === 'done' ? String(ms(4)) : id === 'running' ? 'any' : undefined,
      limit: 4,
    }).map((session) => session.id);
    expect(pick()).toEqual(['running', 'ended', 'a']);
    expect(historyPrefetchVersion(sessions[2])).toBe(String(ms(6)));
    expect(historyPrefetchVersion(sessions[3])).toBeUndefined();
  });

  it('treats a snapshot reaching the last activity as current, never a running turn', () => {
    const end = Date.parse('2026-10-11T00:00:05Z');
    const snapshot = { items: [work('w', 'r', end)] };
    expect(historySnapshotCovers(snapshot, { id: 's', updatedAt: '2026-10-11T00:00:05Z' })).toBe(true);
    expect(historySnapshotCovers(snapshot, { id: 's', updatedAt: '2026-10-11T00:00:01Z', lastTurnEndedAt: end + 1 })).toBe(false);
    expect(historySnapshotCovers(snapshot, { id: 's', updatedAt: '2026-10-11T00:00:01Z', activeTurnStartedAt: end - 1, lastTurnEndedAt: 0 })).toBe(false);
    expect(historySnapshotCovers(null, { id: 's', updatedAt: '2026-10-11T00:00:01Z' })).toBe(false);
  });

  it('keeps expanded work only while its range is unchanged', () => {
    const previous: HistoryViewSnapshot<HistoryMessageSource> = {
      items: [work('same', 'r1'), work('changed', 'r1')], expanded: new Set(['same', 'changed']),
      details: new Map([['same', detail('r1')], ['changed', detail('r1')]]),
      nextCursor: null, hasMore: false, loading: false, ready: true, error: null,
    };
    const next = historySnapshotFromPage({ version: 1, items: [work('same', 'r1'), work('changed', 'r2')],
      nextCursor: 'older', hasMore: true }, previous);
    expect([...next.expanded]).toEqual(['same']);
    expect([...next.details.keys()]).toEqual(['same']);
    expect(next).toMatchObject({ ready: true, loading: false, error: null, hasMore: true, nextCursor: 'older' });
  });
});
