import { useCallback, useEffect, useState } from 'react';

import {
  readSidebarOwnerStorage,
  sidebarOwnerStorageKey,
  writeSidebarOwnerStorage,
} from '@/lib/sidebarOwnerStorage';

/**
 * 「已看过发现伙伴入口」按账号存在本机,与侧栏其他个人布局偏好同作用域(见
 * teammatesSectionPrefs):换账号会重新提示一次,同一账号换窗口、重启都不会再提示。
 */
const KEY = 'sidebar.botMarketEntryHint.v1';
const SEEN = 'seen';

/** 存储写不进去时(无账号、被拒)本次运行内仍记住,避免反复重挂载反复打扰。 */
const seenThisRun = new Set<string>();

/** 读写异常一律按已看过处理:一个新功能提示不值得在存储出问题时反复打扰。 */
function isUnseen(ownerId: string | null): boolean {
  if (!ownerId || seenThisRun.has(ownerId)) return false;
  try {
    if (readSidebarOwnerStorage(KEY, ownerId) !== null) return false;
    // The owner-scoped reader folds a throwing storage into "no value"; probe it so an
    // unavailable storage reads as seen rather than as never shown.
    localStorage.getItem(sidebarOwnerStorageKey(KEY, ownerId));
    return true;
  } catch {
    return false;
  }
}

function recordSeen(ownerId: string | null): void {
  if (!ownerId) return;
  seenThisRun.add(ownerId);
  try {
    writeSidebarOwnerStorage(KEY, ownerId, SEEN);
  } catch {
    // Already remembered for this run above.
  }
}

export interface BotMarketEntryHint {
  /** 这个账号还没看过入口:「+」常驻并带蓝点。 */
  unseen: boolean;
  /** 立即视为已看过并持久化(点击「+」的瞬间调用)。 */
  markSeen: () => void;
}

export function useBotMarketEntryHint(ownerId: string | null): BotMarketEntryHint {
  const [unseen, setUnseen] = useState(() => isUnseen(ownerId));
  useEffect(() => {
    setUnseen(isUnseen(ownerId));
    if (!ownerId) return;
    // Another window of the same account may have marked it seen; the storage event fires only in the other windows.
    const key = sidebarOwnerStorageKey(KEY, ownerId);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) setUnseen(isUnseen(ownerId));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ownerId]);
  const markSeen = useCallback(() => {
    recordSeen(ownerId);
    setUnseen(false);
  }, [ownerId]);
  return { unseen, markSeen };
}

/** Test seam: forget what this run remembered, as a fresh window would. */
export function resetBotMarketEntryHintForTest(): void {
  seenThisRun.clear();
}
