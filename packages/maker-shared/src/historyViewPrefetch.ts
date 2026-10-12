import { historyWorkSummaries, type HistoryMessageSource, type HistoryViewPage } from './historyView.js';
import type { HistoryViewSnapshot, HistoryWorkDetailState } from './historyViewController.js';
import { historyViewEndMs } from './historyViewHandoff.js';

/** Recently changed tasks read ahead after a list refresh; older tasks wait to be opened. */
export const HISTORY_PREFETCH_SESSION_LIMIT = 5;

export interface HistoryPrefetchSession {
  id: string;
  updatedAt: string;
  activeTurnStartedAt?: number | null;
  lastTurnEndedAt?: number | null;
}

/** A turn that started after the last one ended keeps writing rows without touching `updatedAt`. */
function isTurnRunning(session: HistoryPrefetchSession): boolean {
  return typeof session.activeTurnStartedAt === 'number'
    && session.activeTurnStartedAt > (session.lastTurnEndedAt ?? 0);
}

/** `updatedAt` misses turn ends and is not bumped per message; the turn fields fill that gap. */
function activityMs(session: HistoryPrefetchSession): number {
  return Math.max(Date.parse(session.updatedAt) || 0, session.lastTurnEndedAt ?? 0, session.activeTurnStartedAt ?? 0);
}

/**
 * Version a read ahead is valid for. A running task has none: it changes until its turn ends,
 * so every refresh after a gap reads it again.
 */
export function historyPrefetchVersion(session: HistoryPrefetchSession): string | undefined {
  return isTurnRunning(session) ? undefined : String(activityMs(session));
}

/**
 * Pick the most recently active tasks not yet read ahead at their current version. Only the
 * newest `limit` eligible tasks are considered, so a quiet list never walks into older tasks.
 */
export function selectHistoryPrefetchSessions<S extends HistoryPrefetchSession>(
  sessions: readonly S[],
  options: { eligible(session: S): boolean; prefetchedAt(sessionId: string): string | undefined; limit?: number },
): S[] {
  const rank = (session: S) => isTurnRunning(session) ? Number.POSITIVE_INFINITY : activityMs(session);
  return sessions
    .filter((session) => activityMs(session) > 0 && options.eligible(session))
    .sort((a, b) => rank(b) - rank(a) || activityMs(b) - activityMs(a))
    .slice(0, options.limit ?? HISTORY_PREFETCH_SESSION_LIMIT)
    .filter((session) => {
      const version = historyPrefetchVersion(session);
      return version === undefined || options.prefetchedAt(session.id) !== version;
    });
}

/** A cached snapshot that already reaches the task's last activity needs no read ahead. */
export function historySnapshotCovers<T extends HistoryMessageSource>(
  snapshot: Pick<HistoryViewSnapshot<T>, 'items'> | null | undefined,
  session: HistoryPrefetchSession,
): boolean {
  return !!snapshot && !isTurnRunning(session) && historyViewEndMs(snapshot) >= activityMs(session);
}

/**
 * The latest page read ahead, in the shape a view restores from disk. Expanded work keeps its
 * cached body only while that range is unchanged; anything else opens folded.
 */
export function historySnapshotFromPage<T extends HistoryMessageSource>(
  page: HistoryViewPage<T>,
  previous: HistoryViewSnapshot<T> | null | undefined,
): HistoryViewSnapshot<T> {
  const details = new Map<string, HistoryWorkDetailState<T>>();
  const expanded = new Set<string>();
  for (const summary of historyWorkSummaries(page.items)) {
    const detail = previous?.details.get(summary.key);
    if (!previous?.expanded.has(summary.key) || !detail?.complete || detail.loading || detail.error
      || detail.revision !== summary.revision) continue;
    details.set(summary.key, detail);
    expanded.add(summary.key);
  }
  return {
    items: page.items, details, expanded, nextCursor: page.nextCursor, hasMore: page.hasMore,
    loading: false, ready: true, error: null,
  };
}
