/** Which computer runs each companion (cloud-companions.md §3), fed by chatServer register(). */
import {
  EMPTY_COMPANION_CLOUD_SNAPSHOT,
  type CompanionCloudActor,
  type CompanionCloudSnapshot,
} from '../../shared/companionCloud.js';
import { chatRejection, errorCode, type CompanionApi, type CompanionLog } from './types.js';

export type CompanionHomeListener = (snapshot: CompanionCloudSnapshot) => void;

export function createCompanionHomeRegistry() {
  let snapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT;
  const listeners = new Set<CompanionHomeListener>();
  const actorOf = (botId: string) => snapshot.actors.find(actor => actor.externalId === botId);
  const registry = {
    snapshot: () => snapshot,
    update(next: CompanionCloudSnapshot) {
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
      snapshot = { ...next, actors: next.actors.map(actor => ({ ...actor })) };
      for (const listener of listeners) {
        try { listener(snapshot); } catch { /* one listener never blocks the others */ }
      }
    },
    reset: () => registry.update(EMPTY_COMPANION_CLOUD_SNAPSHOT),
    isEnabled: () => snapshot.enabled,
    /** Home device of a registered companion; undefined when this account has no actor for it. */
    homeOf: (botId: string): string | null | undefined => actorOf(botId)?.homeDeviceId,
    /** True when the feature is off, the companion has no home yet, or this computer is its home. */
    isHomeHere(botId: string): boolean {
      if (!snapshot.enabled) return true;
      const home = actorOf(botId)?.homeDeviceId;
      return !home || home === snapshot.selfDeviceId;
    },
    actorIdFor: (botId: string): string | null => actorOf(botId)?.id ?? null,
    onChange(listener: CompanionHomeListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return registry;
}

export type CompanionHomeRegistry = ReturnType<typeof createCompanionHomeRegistry>;

/** Process-wide registry; chatServer resets it when its account/endpoint instance ends. */
export const companionHomes = createCompanionHomeRegistry();

interface HomeActor { id: string; kind: string; externalId: string; homeDeviceId?: string | null }

/**
 * First registration only: claim companions whose home is still empty for this
 * computer (compare-and-set against null). A conflict means another computer won;
 * adopt its answer. Mutates `actors` with the resulting homes.
 */
export async function registerCompanionHomes(input: {
  api: CompanionApi;
  selfDeviceId: string;
  actors: HomeActor[];
  botIds: string[];
  isDemoted: (botId: string) => boolean;
  log?: CompanionLog;
}): Promise<void> {
  for (const botId of input.botIds) {
    const actor = input.actors.find(a => a.kind === 'bot' && a.externalId === botId);
    if (!actor || actor.homeDeviceId != null || input.isDemoted(botId)) continue;
    try {
      const result = await input.api<{ homeDeviceId?: string | null }>(`/actors/${actor.id}`, 'PATCH',
        { homeDeviceId: input.selfDeviceId, expectedHomeDeviceId: null });
      actor.homeDeviceId = result?.homeDeviceId ?? input.selfDeviceId;
    } catch (error) {
      const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
      if (conflict) actor.homeDeviceId = typeof conflict.homeDeviceId === 'string' ? conflict.homeDeviceId : null;
      else input.log?.warn('Companion home registration will retry', { actorId: actor.id, code: errorCode(error) });
    }
  }
}

export function companionSnapshot(input: {
  enabled: boolean;
  selfDeviceId: string | null;
  humanActorId: string | null;
  actors: Array<HomeActor & { name: string; avatar?: string | null }>;
}): CompanionCloudSnapshot {
  const actors: CompanionCloudActor[] = input.actors.filter(a => a.kind === 'bot').map(a => ({
    id: a.id, externalId: a.externalId, name: a.name, avatar: a.avatar ?? null, homeDeviceId: a.homeDeviceId ?? null,
  }));
  return { enabled: input.enabled, selfDeviceId: input.selfDeviceId, humanActorId: input.humanActorId, actors };
}
