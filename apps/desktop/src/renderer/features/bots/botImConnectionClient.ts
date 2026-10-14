/**
 * Renderer 侧「伙伴自有 IM 机器人连接」的读写入口(伙伴设置「消息平台」页)。
 *
 * 同一份 `botImConnection.list()` 投影 + `botImConnection:changed` 广播: 添加、移除与
 * 传输层状态变化都走广播刷新。线上类型与语义见 shared/botImConnection.ts。
 */
import { useEffect, useState } from 'react';

import type {
  BotImConnectionAddInput,
  BotImConnectionAddResult,
  BotImConnectionListPayload,
  BotImConnectionRemoveResult,
} from '../../../shared/botImConnection';

type BotImConnectionApi = Window['electronAPI']['botImConnection'];

export function botImConnectionApi(): BotImConnectionApi | null {
  // 副窗口 / 旧 preload 没有这个命名空间时整块功能静默隐藏, 不抛错。
  const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI
    ?.botImConnection;
  return api && typeof api.list === 'function' ? api : null;
}

export function useBotImConnections(): {
  payload: BotImConnectionListPayload | null;
  /** 首次读取还在途; 读取失败或没有 IPC 时为 false, payload 保持 null。 */
  loading: boolean;
  apply: (next: BotImConnectionListPayload) => void;
} {
  const [payload, setPayload] = useState<BotImConnectionListPayload | null>(null);
  const [loading, setLoading] = useState(() => botImConnectionApi() !== null);

  useEffect(() => {
    const api = botImConnectionApi();
    if (!api) return;
    let cancelled = false;
    const unsubscribe = api.onChanged((next) => {
      if (!cancelled) setPayload(next);
    });
    void api
      .list()
      .then((next) => {
        // 列表在途时先到的广播更新, 不被这份旧快照盖掉。
        if (!cancelled) setPayload((current) => current ?? next);
      })
      .catch(() => {
        // 读不到时按「还没有连接」展示; 下一次广播会补上。
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { payload, loading, apply: setPayload };
}

export function addBotImConnection(input: BotImConnectionAddInput): Promise<BotImConnectionAddResult> {
  const api = botImConnectionApi();
  if (!api) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.add(input);
}

export function removeBotImConnection(id: string): Promise<BotImConnectionRemoveResult> {
  const api = botImConnectionApi();
  if (!api) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.remove({ id });
}

/** 飞书 app id 打码(头 4 尾 4), 列表里不展示完整身份。 */
export function maskBotImContextId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}
