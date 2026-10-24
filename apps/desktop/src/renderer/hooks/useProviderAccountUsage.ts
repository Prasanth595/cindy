/**
 * useProviderAccountUsage —— API Key 供应商余额/配额数据 hook。
 *
 * 与订阅卡的 useProviderSubscriptionCard 互补：那边读 OAuth 订阅配额，这边经
 * PROVIDER_ACCOUNT_USAGE 读供应商自己的账户接口。挂载时拉一次，之后每 60s 静默
 * 刷新一次（main 侧缓存优先 + 节流，重复轮询不会放大上游请求）；失败不轮询重试，
 * 重挂载即重试。不支持（unsupported）时 supported=false，模块不渲染。
 *
 * `agent` 用于会话场景（输入框 chip）：同一供应商各引擎可用不同账户的独立密钥，
 * 传入会话所在引擎才能对准当前会话实际消耗的账户；设置页供应商级视图不传。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import type { ProviderAccountUsageResult } from '../../shared/providerAccountUsage';
import {
  hasDeepSeekOfficialRouteView,
  isZhipuCodingPlanProviderView,
} from '../lib/providerAccountUsageView';

export interface ProviderAccountUsageState {
  /** false = 该供应商没有可读的账户接口，调用方不应渲染模块。 */
  supported: boolean;
  result: ProviderAccountUsageResult | null;
  busy: boolean;
  refresh: () => void;
}

const REFRESH_INTERVAL_MS = 60_000;

export function useProviderAccountUsage(
  provider: ProviderView | undefined,
  agent?: AgentKind,
): ProviderAccountUsageState {
  const supported =
    !!provider
    && provider.auth?.method !== 'oauth'
    && (hasDeepSeekOfficialRouteView(provider) || isZhipuCodingPlanProviderView(provider));
  const [result, setResult] = useState<ProviderAccountUsageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!provider?.id) return;
      const id = ++requestId.current;
      setBusy(true);
      try {
        const next = await window.electronAPI.maker.fetchProviderAccountUsage({
          providerId: provider.id,
          forceRefresh,
          ...(agent ? { agent } : {}),
        });
        if (id === requestId.current) setResult(next);
      } catch {
        // IPC 层异常（不该发生）按未知失败处理，保留已有快照。
        if (id === requestId.current) setResult(null);
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    },
    [provider?.id, agent],
  );

  useEffect(() => {
    if (!supported) return;
    void load(false);
    // 余额/窗口会随使用变化，挂载期间低频静默刷新（main 缓存优先，不会放大上游请求）。
    const timer = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [supported, provider?.id, load]);

  // 换供应商即清空：旧连接的余额绝不能短暂挂在新连接的卡片下。
  useEffect(() => {
    setResult(null);
  }, [provider?.id]);

  return {
    supported,
    result,
    busy,
    refresh: () => void load(true),
  };
}
