import { requestRevealSessionTab } from '../globalTabs';
import { addTab, ensureHydrated, getBucket, setActiveTab } from '../store';
import type { PluginTaskTabState } from '../plugins/plugin-task';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/**
 * 在指定任务的右侧栏打开插件任务页(taskView):同一任务里每个插件实例至多一个
 * 任务页页签,已有则聚焦。来自插件逻辑页的请求不是用户当次手势,分离侧栏形态下
 * 不抢前台(userInitiated:false)。
 */
export async function openPluginTaskTab(
  sessionId: string,
  instanceId: string,
  options: { userInitiated?: boolean } = {},
): Promise<void> {
  const userInitiated = options.userInitiated !== false;
  const route = await routeSidebarCommand(
    { type: 'open-plugin-task', sessionId, instanceId },
    { userInitiated },
  );
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    const bucket = getBucket(sessionId);
    const existing = bucket.tabs.find(
      (tab) =>
        tab.kind === 'plugin-task' &&
        (tab.state as PluginTaskTabState | null)?.instanceId === instanceId,
    );
    let tabId = existing?.id;
    if (existing) {
      await setActiveTab(sessionId, existing.id, { userInitiated });
    } else {
      tabId = (await addTab(sessionId, 'plugin-task', { instanceId } satisfies PluginTaskTabState))
        .id;
    }
    if (tabId) requestRevealSessionTab(sessionId, tabId);
  }
  if (route === 'attached' || route === 'routed') {
    requestRightSidebarVisibility('open', { sessionId, userInitiated });
  }
}
