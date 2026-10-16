/**
 * 某任务此刻实际走的供应商显示名 —— 渠道失败说明(额度不足等)要说清「是哪个供应商」。
 *
 * 只在需要时(失败收口)读一次, 尽力而为: 读库或供应商目录失败一律返回 null,
 * 调用方退回「当前供应商」的说法, 不为一个名字挡住失败消息。
 */
import { eq } from 'drizzle-orm';
import { actualSourceIdForModel } from '@cindy/model-providers';

import { dbToMakerAgentKind } from '../../../shared/agentKindConversion.js';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { getSessionProvider, hasSessionProvider } from '../../maker-host/session-provider-store';

export async function resolveSessionProviderLabel(sessionId: string): Promise<string | null> {
  try {
    const [row] = await getDbClient()
      .drizzle.select({
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row?.model) return null;
    const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
    // 内存里的来源比库里新(本轮刚切过、尚未落库时以运行中的为准)。
    const selected = hasSessionProvider(sessionId) ? getSessionProvider(sessionId) : row.providerId;
    // 「运行中会话」口径(与实际路由层 provider-route 一致): 停用 / 退役的拷贝仍算数 ——
    // 运行中的任务不因停用改道, 说明里的供应商必须是真正报额度错的那一家, 不能是
    // 新路由口径(effectiveSourceIdForModel)过滤后落到的替代来源。
    const providerId = actualSourceIdForModel(
      providers,
      selected?.trim() || null,
      row.model,
      dbToMakerAgentKind(row.agentKind),
    );
    return providers.find((provider) => provider.id === providerId)?.name ?? null;
  } catch {
    return null;
  }
}
