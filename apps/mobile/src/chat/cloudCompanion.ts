/**
 * 云端伙伴（docs/product-rules/cloud-companions.md §3.1）在手机上的纯逻辑：哪一行能在主力电脑离线时
 * 打开云端对话、同一伙伴在多台电脑上的副本只留主力电脑那一份、换电脑后的等待与超时。
 * 不触碰网络或界面，便于单测。
 */
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { chatCursor, chatMessageText, type ChatActor, type ChatMessage, type ChatSetHomeResult } from './chatServerClient';

/** How long the phone waits for the new main computer to list the companion. */
export const CLOUD_SWITCH_TIMEOUT_MS = 90_000;
/** Roster re-read cadence while waiting (pushes usually arrive first). */
export const CLOUD_SWITCH_POLL_MS = 5_000;

/** The account's companion actor for this roster row, when that row's computer is its main computer. */
export function cloudActorForRow(actors: readonly ChatActor[], row: HostedRemoteCollectionItem): ChatActor | null {
  if (row.item.ref.kind !== 'bot' || !row.host.deviceId) return null;
  return actors.find(actor => actor.kind === 'bot' && actor.externalId === row.item.ref.id
    && actor.homeDeviceId === row.host.deviceId) ?? null;
}

/**
 * The same companion listed by several computers shows only its main computer's copy. When no
 * listed copy is on the main computer (or no main computer is known), every copy stays visible.
 */
export function suppressDemotedCompanions<T extends HostedRemoteCollectionItem>(items: readonly T[], actors: readonly ChatActor[]): T[] {
  const counts = new Map<string, number>();
  for (const row of items) if (row.item.ref.kind === 'bot') counts.set(row.item.ref.id, (counts.get(row.item.ref.id) ?? 0) + 1);
  if (![...counts.values()].some(count => count > 1)) return [...items];
  const homes = new Map<string, string>();
  for (const actor of actors) if (actor.kind === 'bot' && actor.externalId && actor.homeDeviceId) homes.set(actor.externalId, actor.homeDeviceId);
  return items.filter(row => {
    if (row.item.ref.kind !== 'bot' || (counts.get(row.item.ref.id) ?? 0) < 2) return true;
    const home = homes.get(row.item.ref.id);
    if (!home || !items.some(other => other.item.ref.kind === 'bot' && other.item.ref.id === row.item.ref.id && other.host.deviceId === home)) return true;
    return row.host.deviceId === home;
  });
}

export interface CloudSwitchCandidate { deviceId: string; name: string }

/** Computers the companion can move to: online, remote control allowed, not a phone, not the current home. */
export function cloudSwitchCandidates(
  devices: readonly { canOpen: boolean; device: { deviceId: string; name: string; platform: string | null } }[],
  currentHome: string | null,
): CloudSwitchCandidate[] {
  return devices.filter(row => row.canOpen && !isMobilePlatform(row.device.platform) && row.device.deviceId !== currentHome)
    .map(row => ({ deviceId: row.device.deviceId, name: row.device.name }));
}

export interface CloudMessage { id: string; fromCompanion: boolean; text: string; createdAt: number }

/** Oldest first, deduplicated; the companion's actor wrote its replies, everyone else is the owner. */
export function cloudCompanionMessages(messages: readonly ChatMessage[], actorId: string): CloudMessage[] {
  const unique = [...new Map(messages.map(message => [message.id, message])).values()]
    .filter(message => !message.deleted && !message.threadRootId && message.origin !== 'system');
  unique.sort((a, b) => {
    const left = BigInt(chatCursor(a.seq)); const right = BigInt(chatCursor(b.seq));
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return unique.flatMap(message => {
    const text = chatMessageText(message).trim();
    return text ? [{ id: message.id, fromCompanion: message.authorId === actorId, text, createdAt: Date.parse(message.createdAt) }] : [];
  });
}

/** What the phone shows while (and after) asking another computer to take over. */
export type CloudSwitchState =
  | { phase: 'idle' }
  | { phase: 'requesting'; target: CloudSwitchCandidate }
  | { phase: 'waiting'; target: CloudSwitchCandidate; since: number }
  | { phase: 'timeout'; target: CloudSwitchCandidate }
  | { phase: 'conflict'; homeDeviceId: string | null }
  | { phase: 'failed'; target: CloudSwitchCandidate };

/** The server's answer to the compare-and-set. */
export function cloudSwitchAfterSetHome(target: CloudSwitchCandidate, result: ChatSetHomeResult, now: number): CloudSwitchState {
  if (result.ok) return { phase: 'waiting', target, since: now };
  // Another device moved it to exactly this computer: wait for it just the same.
  if (result.homeDeviceId === target.deviceId) return { phase: 'waiting', target, since: now };
  return { phase: 'conflict', homeDeviceId: result.homeDeviceId };
}

/** The new main computer's row for the companion, once that computer lists it. */
export function cloudSwitchArrival<T extends HostedRemoteCollectionItem>(items: readonly T[], deviceId: string, botId: string): T | null {
  return items.find(row => row.item.ref.kind === 'bot' && row.host.deviceId === deviceId && row.item.ref.id === botId) ?? null;
}

/** One waiting tick: open the arrived row, give up after the timeout, otherwise keep waiting. */
export function cloudSwitchTick<T extends HostedRemoteCollectionItem>(state: CloudSwitchState, items: readonly T[], botId: string, now: number,
  timeoutMs = CLOUD_SWITCH_TIMEOUT_MS): { state: CloudSwitchState; arrived: T | null } {
  if (state.phase !== 'waiting') return { state, arrived: null };
  const arrived = cloudSwitchArrival(items, state.target.deviceId, botId);
  if (arrived) return { state: { phase: 'idle' }, arrived };
  if (now - state.since >= timeoutMs) return { state: { phase: 'timeout', target: state.target }, arrived: null };
  return { state, arrived: null };
}
