/** Cloud companions (docs/product-rules/cloud-companions.md): which computer runs each companion. */
export interface CompanionCloudHomeDevice {
  deviceId: string;
  /** Device-link name; empty when the device is not in this account's device list. */
  name: string;
  online: boolean;
  isSelf: boolean;
}

export interface CompanionCloudActor {
  /** Chat Server actor id. */
  id: string;
  /** Local Bot profile id. */
  externalId: string;
  name: string;
  avatar: string | null;
  /** device-link deviceId of the companion's home computer; null when not registered yet. */
  homeDeviceId: string | null;
  /** Resolved home computer; only present in the renderer view (state IPC / change push). */
  homeDevice?: CompanionCloudHomeDevice | null;
}

export interface CompanionCloudSnapshot {
  /** Server supports companion homes and this login carries a device id. */
  enabled: boolean;
  selfDeviceId: string | null;
  humanActorId: string | null;
  actors: CompanionCloudActor[];
  /** Local companions whose home moved to another computer: hidden, never run here. */
  demotedBotIds: string[];
}

export const EMPTY_COMPANION_CLOUD_SNAPSHOT: CompanionCloudSnapshot = Object.freeze({
  enabled: false,
  selfDeviceId: null,
  humanActorId: null,
  actors: [],
  demotedBotIds: [],
}) as CompanionCloudSnapshot;

export type CompanionCloudFailureCode = 'HOME_CONFLICT' | 'OFFLINE' | 'NOT_ENABLED' | 'FAILED' | 'TARGET_UNAVAILABLE' | 'BUSY';

export type CompanionCloudActionResult =
  | { ok: true }
  | { ok: false; code: CompanionCloudFailureCode; homeDeviceId?: string | null };

export interface CompanionTranscriptMessage {
  /** Chat Server message id. */
  id: string;
  seq: string;
  role: 'user' | 'assistant';
  text: string;
  /** Unix ms. */
  createdAt: number;
}

export interface CompanionTranscriptPage {
  /** Oldest first. */
  messages: CompanionTranscriptMessage[];
  /** Pass back as `before` for older messages; absent at the start of the room. */
  nextBefore?: string;
}

export interface CompanionTransferTarget {
  deviceId: string;
  name: string;
  online: boolean;
}
