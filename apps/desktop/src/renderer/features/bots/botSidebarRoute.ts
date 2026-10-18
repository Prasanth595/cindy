import { matchPath } from 'react-router-dom';

/**
 * 侧栏「伙伴」段里，当前主区域正开着哪个聊天。
 *
 * 侧栏槽位由 Feature Layout 注册、渲染在 Shell 的 upperContent 里（见
 * `useRegisterCCAgentSidebar`），不在 /bots 的路由子树内 —— 那一层
 * `useParams()` 永远拿不到 `:botId` / `:deviceId` / `:groupId`。所以这里只从
 * pathname 解析，和 `useViewedBotSessionId`（同样因为这个原因改用 useMatch）
 * 是同一口径。
 */
export type OpenChatRoute =
  | { kind: 'group'; groupId: string }
  | { kind: 'remote'; deviceId: string; botId: string }
  | { kind: 'bot'; botId: string };

/** /bots 下的静态段：它们不是伙伴 id，不能被 `:botId` 吞掉。 */
const STATIC_BOT_SIBLINGS = new Set(['list', 'roster']);

export function resolveOpenChatRoute(pathname: string): OpenChatRoute | null {
  // 子路由（设置抽屉、历史、私聊）都算「正在看这个聊天」，因此不要求路径结束。
  const group = matchPath({ path: '/bots/groups/:groupId', end: false }, pathname);
  if (group?.params.groupId) {
    return { kind: 'group', groupId: group.params.groupId };
  }

  const remote = matchPath({ path: '/bots/remote/:deviceId/:botId', end: false }, pathname);
  if (remote?.params.deviceId && remote.params.botId) {
    return { kind: 'remote', deviceId: remote.params.deviceId, botId: remote.params.botId };
  }

  const bot = matchPath({ path: '/bots/:botId', end: false }, pathname);
  const botId = bot?.params.botId;
  if (!botId || STATIC_BOT_SIBLINGS.has(botId)) return null;
  return { kind: 'bot', botId };
}
