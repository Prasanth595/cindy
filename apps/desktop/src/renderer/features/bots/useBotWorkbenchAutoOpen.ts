import { useEffect, useRef } from 'react';

import { ensureBotWorkbenchTab } from '@/features/right-sidebar/lib/openBotWorkbenchTab';
import { useBotGlance, type GlanceHost } from './botGlance';

const LOCAL_HOST: GlanceHost = { deviceId: null };

/**
 * 工作台的打开规则：进入伙伴页不打开；该伙伴的「等你」从 0 变成 >0（含进入时就已经有事等你）
 * 时自动打开一次。「一次」由 ensureBotWorkbenchTab 的布局记录保证——主人关过或收起过右侧栏，
 * 之后再有事等也不再自动打开，只留头部入口与「+」菜单。
 */
export function useBotWorkbenchAutoOpen(sessionId: string | undefined, botId: string | undefined): void {
  const enabled = Boolean(sessionId && botId);
  const { glance } = useBotGlance(botId ?? '', LOCAL_HOST, enabled);
  // 换了伙伴时上一位的投影可能还在这一帧里，只认这位伙伴自己的。
  const waiting = enabled && glance && glance.botId === botId ? glance.waiting.length : null;
  const previous = useRef<number | null>(null);
  const signal = useRef<AbortSignal | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    signal.current = controller.signal;
    previous.current = null;
    return () => controller.abort();
  }, [sessionId, botId]);

  useEffect(() => {
    if (waiting === null || !sessionId || !botId) return;
    const before = previous.current;
    previous.current = waiting;
    if (waiting > 0 && !before) {
      void ensureBotWorkbenchTab(sessionId, botId, signal.current).catch(() => undefined);
    }
  }, [waiting, sessionId, botId]);
}
