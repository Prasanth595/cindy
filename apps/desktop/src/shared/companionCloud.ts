/** Cloud companions (docs/product-rules/cloud-companions.md): which computer runs each companion. */
export interface CompanionCloudActor {
  /** Chat Server actor id. */
  id: string;
  /** Local Bot profile id. */
  externalId: string;
  name: string;
  avatar: string | null;
  /** device-link deviceId of the companion's home computer; null when not registered yet. */
  homeDeviceId: string | null;
}

export interface CompanionCloudSnapshot {
  /** Server supports companion homes and this login carries a device id. */
  enabled: boolean;
  selfDeviceId: string | null;
  humanActorId: string | null;
  actors: CompanionCloudActor[];
}

export const EMPTY_COMPANION_CLOUD_SNAPSHOT: CompanionCloudSnapshot = Object.freeze({
  enabled: false,
  selfDeviceId: null,
  humanActorId: null,
  actors: [],
}) as CompanionCloudSnapshot;
