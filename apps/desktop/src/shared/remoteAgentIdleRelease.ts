/**
 * 本机作为使用方：用其他电脑上的模型时，那台电脑给这台电脑的任务数有上限。快到上限时，闲置满这么多
 * 分钟的任务先断开那台电脑上的 Agent，把位置让给新任务；再发消息时自动接回原来的对话。0 = 从不断开，
 * 也是默认值：升级后行为与没有连接池时一样，用户自己打开才生效。
 */
export interface RemoteAgentIdleRelease {
  idleMinutes: number;
}

export const REMOTE_AGENT_IDLE_RELEASE_MAX_MINUTES = 120;
export const DEFAULT_REMOTE_AGENT_IDLE_RELEASE: Readonly<RemoteAgentIdleRelease> = { idleMinutes: 0 };

export function isRemoteAgentIdleRelease(value: unknown): value is RemoteAgentIdleRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const minutes = (value as RemoteAgentIdleRelease).idleMinutes;
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= REMOTE_AGENT_IDLE_RELEASE_MAX_MINUTES;
}

export interface RemoteAgentIdleReleaseView {
  value: RemoteAgentIdleRelease;
  defaults: RemoteAgentIdleRelease;
  isCustomized: boolean;
}
