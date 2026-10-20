import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { CCAgentSidebarUpper } from '../../../src/renderer/features/cc-agent/CCAgentSidebarUpper';
import { ConversationSearchProvider } from '../../../src/renderer/features/cc-agent/sidebar/conversationSearchContext';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { useLocation } from 'react-router-dom';

function RouteProbe() {
  const location = useLocation();
  return <span hidden data-fixture-route={location.pathname} />;
}

localStorage.setItem('cc-agent.sidebar.filter.groupDialogue', 'true');
localStorage.setItem('cc-agent.sidebar.filter.groupDevice', 'false');
localStorage.setItem('cc-agent.sidebar.filter.groupBy', 'project');
localStorage.setItem('sidebar.mainListMode', 'list');

mountPage({
  route: '/cc-agent/dialogue-fixture',
  host: {
    binding: {
      onChanged: subscription('bindings'),
      listAttached: async () => ({ sessionIds: [] }),
      resolveSession: async () => ({ attached: false }),
    },
    deviceLink: {
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('deviceLinkStatus'),
      onRemotePush: subscription('remotePush'),
      onControlTargetChanged: subscription('controlTargets'),
      listDevices: async () => [],
      getState: async () => ({ status: 'stopped' }),
    },
    worktreeListAll: async () => [],
    localDb: {
      bots: { list: async () => [], onChanged: subscription('bots') },
      projectAliases: { list: async () => [], onChanged: subscription('projectAliases') },
      recentWorkdirs: { list: async () => [], onChanged: subscription('recentWorkdirs') },
    },
    sidebarSettings: {
      loadSnapshot: () => ({
        dataOwnerId: null,
        ownerGeneration: 0,
        pinnedOrderIsAuthoritative: true,
        pinnedOrder: [],
        hiddenProjectKeys: [],
        hiddenMainViewGhostIds: [],
      }),
      onHiddenProjectKeysChanged: subscription('hiddenProjectKeys'),
      onPinnedOrderChanged: subscription('pinnedOrder'),
      onHiddenMainViewGhostIdsChanged: subscription('hiddenGhosts'),
    },
  },
  render: () => (
    <WorktreeProvider>
      <ConversationSearchProvider>
        <AppFrame header={false} sidebar={<CCAgentSidebarUpper />}>
          <RouteProbe />
        </AppFrame>
      </ConversationSearchProvider>
    </WorktreeProvider>
  ),
});
