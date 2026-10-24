/**
 * useSessionBackgroundActivity —— 会话「turn 已结束但 CC 子进程仍在调模型」
 * (后台子 agent 等)的响应式状态 + 一键全停动作。
 *
 * 数据源:main 侧 claude-session-background-activity(loopback proxy 的
 * per-session API 活动信号)。挂载 / 切会话时先拉一次快照(避免错过挂载前的
 * 翻转广播),随后靠 push 增量维护;全停走 stopSessionBackgroundTasks(main
 * 关闭常驻 CC 子进程,会话可续),成功后本地立即熄灭,广播到达时幂等校正。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function useSessionBackgroundActivity(sessionId: string | undefined): {
  active: boolean;
  stopping: boolean;
  stopAll: () => Promise<void>;
} {
  // A reused view must not inherit another task's activity or late stop result.
  const scopeRef = useRef({ sessionId, revision: 0 });
  if (scopeRef.current.sessionId !== sessionId) scopeRef.current = { sessionId, revision: 0 };
  const scope = scopeRef.current;
  const [activity, setActivity] = useState({ scope, active: false });
  const pendingStops = useRef(new Set<string>());
  const [stoppingSessionIds, setStoppingSessionIds] = useState(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const api = window.electronAPI?.maker;
    if (!api?.getSessionBackgroundActivity) return;
    let disposed = false;
    const readRevision = scope.revision;
    const off = api.onSessionBackgroundActivityChanged((payload) => {
      if (disposed || payload.sessionId !== sessionId) return;
      scope.revision += 1;
      setActivity({ scope, active: payload.active });
    });
    void api
      .getSessionBackgroundActivity(sessionId)
      .then((snap) => {
        if (!disposed && scope.revision === readRevision) setActivity({ scope, active: snap.active });
      })
      .catch(() => {
        // maker 未 init 等瞬态:保持 false,push 到达时校正。
      });
    return () => {
      disposed = true;
      off();
    };
  }, [sessionId, scope]);

  const stopAll = useCallback(async () => {
    if (!sessionId || pendingStops.current.has(sessionId)) return;
    const api = window.electronAPI?.maker;
    if (!api?.stopSessionBackgroundTasks) return;
    pendingStops.current.add(sessionId);
    setStoppingSessionIds(new Set(pendingStops.current));
    const revisionAtStop = scope.revision;
    try {
      await api.stopSessionBackgroundTasks(sessionId);
      // A different task or a newer push owns the view after navigation/restart.
      if (mounted.current && scopeRef.current === scope && scope.revision === revisionAtStop) {
        scope.revision += 1;
        setActivity({ scope, active: false });
      }
    } catch {
      // 关闭失败时不伪造已停止状态，继续由后台活动 push / turn 事件校正。
    } finally {
      pendingStops.current.delete(sessionId);
      if (mounted.current) setStoppingSessionIds(new Set(pendingStops.current));
    }
  }, [sessionId, scope]);

  return {
    active: activity.scope === scope && activity.active,
    stopping: Boolean(sessionId && stoppingSessionIds.has(sessionId)),
    stopAll,
  } as const;
}
