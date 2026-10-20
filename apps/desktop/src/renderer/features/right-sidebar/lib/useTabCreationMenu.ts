import { useRef, useState, useSyncExternalStore } from 'react';
import { canonicalBotSessionId, useBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { isRemoteSessionWriteBlocked } from '@/features/cc-agent/lib/remoteSessionWriteGuard';
import { sessionsStore } from '@/lib/sessionsStore';
import { listTabKindMenuMetas, useTabKindRegistryVersion } from '../registry';
import type { TabKindId, TabKindMenuMeta } from '../types';
import { openBotWorkbenchTab } from './openBotWorkbenchTab';
import { canOpenSideChat, openSideChatTab } from './openSideChatTab';

const BOT_SECONDARY_KINDS = new Set<TabKindId>([
  'review',
  'subagents',
  'background-tasks',
  'terminal',
]);

export interface TabCreationMenu {
  items: Array<TabKindMenuMeta & { disabled: boolean; busy: boolean }>;
  select: (kind: TabKindId) => void;
}

/** Both entry surfaces share the registry, eligibility, pending state and open actions. */
export function useTabCreationMenu({
  sessionId,
  subagentsAvailable,
  onSelect,
}: {
  sessionId: string | null | undefined;
  subagentsAvailable: boolean;
  onSelect: (kind: TabKindId) => void;
}): TabCreationMenu {
  useTabKindRegistryVersion();
  const bots = useBotProfiles();
  const bot = sessionId ? findBotProfileForSession(bots, sessionId) : undefined;
  const localSession = useSyncExternalStore(
    sessionsStore.subscribe,
    () => sessionId ? sessionsStore.findById(sessionId) : null,
  );
  const remoteSessions = useRemoteProjectSessions();
  const session = remoteSessions.find(row => row.id === sessionId) ?? localSession;
  const workbenchBotId = bot && sessionId && canonicalBotSessionId(bot) === sessionId
    && !session?.remoteHostId && !session?.deviceLinkDeviceId ? bot.id : null;
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const items = listTabKindMenuMetas().filter(item => {
    if (item.kind.startsWith('ghost:')) return false;
    if (item.kind === 'bot-workbench' && !workbenchBotId) return false;
    if (item.kind === 'subagents' && !subagentsAvailable) return false;
    if (item.kind === 'side-chat' && (bot || !canOpenSideChat(session))) return false;
    return !bot || !BOT_SECONDARY_KINDS.has(item.kind);
  }).map(item => {
    const busy = item.kind === 'side-chat' && !!sessionId && openingSessionId === sessionId;
    return {
      ...item,
      busy,
      disabled: !sessionId || !item.enabled || busy
        || (item.kind === 'side-chat' && isRemoteSessionWriteBlocked(session)),
    };
  });

  const select = (kind: TabKindId) => {
    if (!sessionId || !items.some(item => item.kind === kind && !item.disabled)) return;
    if (kind === 'side-chat') {
      if (pending.current === sessionId) return;
      pending.current = sessionId;
      setOpeningSessionId(sessionId);
      void openSideChatTab(sessionId).finally(() => {
        if (pending.current === sessionId) pending.current = null;
        setOpeningSessionId(current => current === sessionId ? null : current);
      });
      return;
    }
    if (kind === 'bot-workbench' && workbenchBotId) {
      void openBotWorkbenchTab(sessionId, workbenchBotId).catch(() => undefined);
      return;
    }
    onSelect(kind);
  };

  // Keep unavailable future entries last on both surfaces.
  return { items: [...items.filter(item => item.enabled), ...items.filter(item => !item.enabled)], select };
}
