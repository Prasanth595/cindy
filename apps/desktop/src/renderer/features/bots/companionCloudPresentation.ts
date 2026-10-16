import type { CompanionCloudActor, CompanionCloudSnapshot } from '../../../shared/companionCloud';
import type { RemoteBot } from './remoteBotRoster';

/**
 * Local copies whose home moved to another computer stay out of the roster and entry choice.
 * The shadow list is persisted in main, so it applies offline and with the feature off too.
 */
export function withoutShadowedBots<T extends { id: string }>(bots: readonly T[], cloud: CompanionCloudSnapshot): T[] {
  if (cloud.demotedBotIds.length === 0) return [...bots];
  const shadowed = new Set(cloud.demotedBotIds);
  return bots.filter((bot) => !shadowed.has(bot.id));
}

/** The cloud companion whose home is `deviceId`, when the feature is on. */
export function cloudCompanionAt(cloud: CompanionCloudSnapshot, deviceId: string | undefined, botId: string | undefined): CompanionCloudActor | null {
  if (!cloud.enabled || !deviceId || !botId) return null;
  return cloud.actors.find((actor) => actor.externalId === botId && actor.homeDeviceId === deviceId) ?? null;
}

/** A remote companion whose home computer cannot be reached right now. */
export function isCloudHomeOffline(cloud: CompanionCloudSnapshot, bot: Pick<RemoteBot, 'id' | 'deviceId' | 'online'> | undefined, deviceId?: string, botId?: string): boolean {
  const actor = cloudCompanionAt(cloud, bot?.deviceId ?? deviceId, bot?.id ?? botId);
  if (!actor || actor.homeDeviceId === cloud.selfDeviceId) return false;
  return !bot?.online;
}

/**
 * Companions homed on a computer this device never listed (e.g. it was never online
 * here): still reachable as offline remote rows, so the cloud conversation can open.
 */
export function cloudOnlyRemoteBots(cloud: CompanionCloudSnapshot, remoteBots: readonly RemoteBot[]): RemoteBot[] {
  if (!cloud.enabled) return [];
  return cloud.actors.flatMap((actor) => {
    const home = actor.homeDeviceId;
    if (!home || home === cloud.selfDeviceId) return [];
    if (remoteBots.some((bot) => bot.deviceId === home && bot.id === actor.externalId)) return [];
    return [{
      id: actor.externalId,
      deviceId: home,
      deviceName: actor.homeDevice?.name ?? '',
      name: actor.name,
      avatar: actor.avatar ?? '',
      avatarColor: 'violet',
      description: '',
      preview: '',
      activityAt: 0,
      sessionId: null,
      online: false,
      connectionKnown: true,
    }];
  });
}

/**
 * One row per cloud companion: rows another computer still lists for a companion whose home is
 * known to be elsewhere (old copies, possibly cached while that computer is offline) are
 * dropped, and companions homed on a computer never listed here get an offline row.
 */
export function cloudRemoteBots(cloud: CompanionCloudSnapshot, remoteBots: readonly RemoteBot[]): RemoteBot[] {
  if (!cloud.enabled) return [...remoteBots];
  const homes = new Map(cloud.actors.flatMap((actor) => actor.homeDeviceId ? [[actor.externalId, actor.homeDeviceId] as const] : []));
  const listed = remoteBots.filter((bot) => { const home = homes.get(bot.id); return !home || home === bot.deviceId; });
  return [...listed, ...cloudOnlyRemoteBots(cloud, listed)];
}

export function homeDeviceName(cloud: CompanionCloudSnapshot, botId: string, fallback: string): string {
  const actor = cloud.actors.find((candidate) => candidate.externalId === botId);
  return actor?.homeDevice?.name?.trim() || fallback;
}

/**
 * Whether this computer runs `botId`: it holds the profile, the copy is not shadowed, and the
 * companion's known home (when the feature is on) is this computer. Sessions and tasks of a
 * companion live only on its home computer, so only there can they be looked up locally.
 */
export function companionRunsHere(cloud: CompanionCloudSnapshot, localBotIds: readonly string[], botId: string): boolean {
  if (!localBotIds.includes(botId) || cloud.demotedBotIds.includes(botId)) return false;
  const home = cloud.enabled ? cloud.actors.find((actor) => actor.externalId === botId)?.homeDeviceId : undefined;
  return !home || home === cloud.selfDeviceId;
}
