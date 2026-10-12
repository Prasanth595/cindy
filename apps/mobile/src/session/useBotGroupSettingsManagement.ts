import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BOT_GROUP_REMOTE_COLLECTION_ID, type BotGroupRemoteActionId, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { getRemoteResource, invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupResourceRef, canManageBotGroup } from './botGroupRemote';
import { useRemoteResourceList } from './useRemoteResourceList';
import { useTeammateRoster } from './useTeammateRoster';

type Manager = { host: RemoteResourceHostTarget; group: BotGroupRemoteChatData };

/** Associate a direct server chat with computers that actually expose this exact room. */
export function useBotGroupSettingsManagement(groupId: string, enabled: boolean) {
  const { accountGeneration } = useAuth();
  const { i18n } = useTranslation();
  const { invoke, openLink, connectionEpoch, status, getPresenceAvailability, onRemoteResourceChanged } = useDeviceLink();
  const revoked = useRevokedDevices();
  const roster = useTeammateRoster(enabled);
  const list = useRemoteResourceList(BOT_GROUP_REMOTE_COLLECTION_ID, roster.groupTargets, enabled);
  const binding = JSON.stringify([accountGeneration, groupId, enabled, connectionEpoch]);
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const activeBinding = useRef<string | null>(null);
  useEffect(() => {
    activeBinding.current = binding;
    return () => { if (activeBinding.current === binding) activeBinding.current = null; };
  }, [binding]);
  const [selectedId, select] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ binding: string; key: string; managers: Manager[]; reason: 'noHost' | 'permission' | 'upgrade' | 'unavailable' | null }>();
  const writing = useRef(false);
  const candidates = list.items.filter(row => row.item.ref.id === groupId && row.item.ref.kind === 'bot-group'
    && roster.groupTargets.some(host => host.deviceId === row.host.deviceId) && !revoked.has(row.host.deviceId) && list.isOnline(row.host));
  const candidateKey = JSON.stringify(candidates.map(row => [row.host.deviceId, row.item.revision]));
  const key = JSON.stringify([candidateKey, refreshVersion, status]);
  const currentRef = useRef({ binding, key, enabled, managers: [] as Manager[] });
  const own = snapshot?.binding === binding && snapshot.key === key;
  const managers = own ? snapshot.managers.filter(manager => !revoked.has(manager.host.deviceId) && list.isOnline(manager.host)) : [];
  currentRef.current = { binding, key, enabled, managers };
  const selected = managers.find(manager => manager.host.deviceId === selectedId) ?? managers[0];

  useEffect(() => {
    if (!enabled || roster.loading || list.syncing) return;
    let cancelled = false;
    const current = () => !cancelled && bindingRef.current === binding && currentRef.current.key === key;
    void (async () => {
      const found: Manager[] = [];
      let reason: NonNullable<typeof snapshot>['reason'] = candidates.length ? 'unavailable' : 'noHost';
      // Keep the same bounded fanout as the roster reader on the shared relay.
      for (let offset = 0; offset < candidates.length; offset += 2) {
        const replies = await Promise.allSettled(candidates.slice(offset, offset + 2).map(async ({ host }) => {
          await openLink(host.deviceId);
          if (!current()) return null;
          const resource = await getRemoteResource(invoke, host, botGroupResourceRef(groupId), i18n.language, BOT_GROUP_CLIENT_PRIMITIVES);
          const group = botGroupChatDataFromResource(resource);
          return group?.id === groupId && group.serverBacked ? { host, group } : null;
        }));
        if (!current()) return;
        for (const reply of replies) {
          if (reply.status !== 'fulfilled' || !reply.value) continue;
          const manager = reply.value;
          if (canManageBotGroup(manager.group)) found.push(manager);
          else if (!manager.group.supportsSettingsManagement) reason = 'upgrade';
          else reason = 'permission';
        }
      }
      if (current()) setSnapshot({ binding, key, managers: found, reason: found.length ? null : reason });
    })();
    return () => { cancelled = true; };
    // The serialized key pins candidates; unstable roster callbacks must not restart reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, key, enabled, roster.loading, list.syncing, invoke, openLink, i18n.language]);

  const refresh = useCallback(() => { setRefreshVersion(value => value + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onRemoteResourceChanged((deviceId, payload) => {
      if (!candidates.some(row => row.host.deviceId === deviceId) || payload.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some(ref => ref.id === groupId)) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; refresh(); }, 150);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, groupId, candidateKey, onRemoteResourceChanged, refresh]);

  const act = useCallback(async (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>) => {
    const expected = currentRef.current;
    const manager = selected;
    if (!expected.enabled || !manager || writing.current) throw new Error('PERMISSION_DENIED');
    writing.current = true;
    const valid = () => activeBinding.current === binding && bindingRef.current === binding && currentRef.current.enabled
      && currentRef.current.managers.some(value => value.host.deviceId === manager.host.deviceId)
      && getPresenceAvailability(manager.host.deviceId) !== false;
    try {
      await openLink(manager.host.deviceId);
      if (!valid()) throw new Error('PERMISSION_DENIED');
      const receipt = await invokeRemoteResourceAction(invoke, manager.host, {
        collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, resourceRef: botGroupResourceRef(groupId), actionId,
        input: { expectedRevision: manager.group.revision, ...input },
      }, i18n.language);
      // A reply from a prior account/sheet must not close the current screen.
      if (bindingRef.current !== binding || activeBinding.current !== binding) throw new Error('PERMISSION_DENIED');
      return receipt;
    } finally {
      writing.current = false;
      if (bindingRef.current === binding && activeBinding.current === binding) refresh();
    }
  }, [binding, groupId, selected, getPresenceAvailability, openLink, invoke, i18n.language, refresh]);

  const loading = enabled && (roster.loading || list.syncing || !own);
  return { selected, managers, select, act, loading, reason: loading ? null : snapshot ? snapshot.reason : 'noHost',
    refresh: () => { void roster.refresh(); void list.refresh(); refresh(); } };
}
