import type { Session } from '@/lib/ccAgent.types';

import type { FilterProjectOrder, FilterSortBy } from '../hooks/helpers/sidebarFilterCore';
import {
  compareSessionGroupsByPriority,
  compareSessionGroupsByRunning,
  sortSessionsForMainList,
  type MainListPriorityContext,
} from './mainListModel';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import { sessionCreatedMs } from './dateSessionGrouping';
import { projectKeyComparisonKey, type ProjectNode } from './projectGrouping';

/**
 * 项目面板沿用主列表的状态排序；旧调用方未传上下文时保留既有优先级顺序。
 */
export function sortSessionsForSidebar(
  sessions: readonly Session[],
  sortBy: FilterSortBy,
  priorityContext?: MainListPriorityContext,
): Session[] {
  return sortBy === 'recency' || (sortBy === 'priority' && !priorityContext)
    ? sessions.slice()
    : sortSessionsForMainList(sessions, sortBy, priorityContext);
}

export function sortProjectsForSidebar(
  projects: readonly ProjectNode[],
  sortBy: FilterSortBy,
  manualProjectOrder: readonly string[],
  projectOrder: FilterProjectOrder = 'activity',
  localPlatform: string = '',
  priorityContext?: MainListPriorityContext,
): ProjectNode[] {
  const withSortedSessions = projects.map((project) => ({
    ...project,
    sessions: sortSessionsForSidebar(project.sessions, sortBy, priorityContext),
  }));

  if (projectOrder === 'custom') {
    const normalizedOrder = normalizeManualProjectOrder(
      manualProjectOrder,
      projects.map((project) => project.projectKey),
      localPlatform,
    );
    const rank = new Map(
      normalizedOrder.map((key, index) => [
        projectKeyComparisonKey(key, localPlatform) ?? key,
        index,
      ]),
    );
    return withSortedSessions.sort(
      (a, b) =>
        (rank.get(projectKeyComparisonKey(a.projectKey, localPlatform) ?? a.projectKey) ??
          Number.MAX_SAFE_INTEGER) -
        (rank.get(projectKeyComparisonKey(b.projectKey, localPlatform) ?? b.projectKey) ??
          Number.MAX_SAFE_INTEGER),
    );
  }

  if (sortBy === 'created') {
    return withSortedSessions.sort(
      (a, b) =>
        Math.max(0, ...b.sessions.map(sessionCreatedMs)) -
          Math.max(0, ...a.sessions.map(sessionCreatedMs)) ||
        (a.sessions[0]?.id ?? '').localeCompare(b.sessions[0]?.id ?? ''),
    );
  }

  if (sortBy === 'priority' && priorityContext) {
    return withSortedSessions.sort((a, b) =>
      compareSessionGroupsByPriority(a.sessions, b.sessions, priorityContext),
    );
  }
  if (sortBy === 'running' && priorityContext) {
    return withSortedSessions.sort((a, b) =>
      compareSessionGroupsByRunning(a.sessions, b.sessions, priorityContext),
    );
  }

  return withSortedSessions;
}
