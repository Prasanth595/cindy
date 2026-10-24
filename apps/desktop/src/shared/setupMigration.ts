/**
 * New-computer setup: read a non-secret configuration snapshot from another computer on the
 * same account and rebuild it here (docs/product-rules/new-device-setup-migration.md).
 *
 * Main owns the snapshot transport, the plan and everything that installs or writes host
 * state (plugins, skills, settings files). The renderer applies what it already owns or
 * already edits through existing settings APIs (interface preferences, providers, MCP,
 * built-in tool switches, remote access switches). Secrets never appear in these types.
 */
import type {
  SetupSnapshotMcpServer,
  SetupSnapshotPluginSource,
  SetupSnapshotProvider,
  SetupSnapshotSection,
} from '@cindy/device-link';
import type { DataOwnerPushStamp } from './dataOwnerPush';
import type { GhostInstallConsentFacts } from './ghostInstallConsent';

export const SETUP_MIGRATION_IPC = {
  SOURCES: 'setup-migration:sources',
  PREVIEW: 'setup-migration:preview',
  APPLY: 'setup-migration:apply',
  STATE: 'setup-migration:state',
  DISMISS: 'setup-migration:dismiss',
  PROGRESS: 'setup-migration:progress',
  /** Renderer → Main: this window can answer interface-preference reads for another computer. */
  HOST_READY: 'setup-migration:host-ready',
  HOST_REQUEST: 'setup-migration:host-request',
  HOST_REPLY: 'setup-migration:host-reply',
} as const;

/**
 * Interface preferences that live in renderer localStorage and mean the same on any computer.
 * Window positions, sidebars, device pickers, microphone ids and model memories are excluded.
 */
export const SETUP_MIGRATION_RENDERER_PREF_KEYS: readonly string[] = [
  'theme',
  'theme.familyId',
  'theme.lightId',
  'theme.darkId',
  'language',
  'notifications.enabled',
  'notifications.feishuEnabled',
  'notifications.wecomGroupEnabled',
  'notifications.agentIslandEnabled',
  'notifications.agentIslandSoundSettings',
  'notifications.agentIslandMascotSkin',
  'chat.streamFadePreference',
  'chat.messageNavRail.enabled',
  'chat.sendShortcutPreference',
  'chat.linkOpenPreference',
  'chat.webLinkOpenPreference',
  // The window-behavior settings file only caches this for macOS window creation; the
  // switch and the Windows click handling read this key, so both must move together.
  'input.swallowActivationClick',
];
export const SETUP_MIGRATION_RENDERER_PREF_PREFIXES: readonly string[] = [
  'experimental.',
  // Per-account personal prompt (`userPrompt.value.<owner>`); only the signed-in account's moves.
  'userPrompt.value.',
];

export function isPortableRendererPrefKey(key: string): boolean {
  return (
    SETUP_MIGRATION_RENDERER_PREF_KEYS.includes(key) ||
    SETUP_MIGRATION_RENDERER_PREF_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export interface SetupMigrationHostRequest {
  requestId: string;
  expiresAt: number;
  ownerStamp: DataOwnerPushStamp;
}

export interface SetupMigrationHostReply {
  requestId: string;
  prefs?: Record<string, string>;
  failed?: true;
}

export type SetupMigrationSourceUnavailableReason =
  | 'offline'
  | 'remote-control-off'
  | 'control-disabled';

export interface SetupMigrationSource {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt: string | null;
  /** Absent when the computer can be read now. */
  unavailable?: SetupMigrationSourceUnavailableReason;
}

/**
 * `ready` = will be copied; `present` = already the same here; `kept` = this computer already
 * has its own value, which is kept; `unavailable` = cannot be copied right now (see reason).
 */
export type SetupMigrationItemState = 'ready' | 'present' | 'kept' | 'unavailable';

export type SetupMigrationUnavailableReason =
  | 'not-in-catalog'
  | 'source-not-added'
  | 'needs-sign-in'
  | 'local-only'
  | 'platform'
  | 'invalid';

interface ItemBase {
  /** Stable selection key inside one plan. */
  key: string;
  state: SetupMigrationItemState;
  reason?: SetupMigrationUnavailableReason;
}

export interface SetupMigrationPluginItem extends ItemBase {
  ghostId: string;
  name: string;
  version: string;
  namespace: string | null;
  pluginId: string | null;
  source: SetupSnapshotPluginSource;
  marketName: string | null;
  enabledOnSource: boolean;
  /** Permissions this computer will ask for, computed by Main from the market release. */
  consent: GhostInstallConsentFacts | null;
}

export interface SetupMigrationSkillItem extends ItemBase {
  name: string;
  version: string | null;
  catalogScope: 'market' | 'team' | null;
  enabledOnSource: boolean;
}

export interface SetupMigrationSettingsItem extends ItemBase {
  /** Settings group id; the renderer owns its label. */
  id: string;
  changeCount: number;
  keptCount: number;
}

export interface SetupMigrationMcpItem extends ItemBase {
  server: SetupSnapshotMcpServer;
}

export interface SetupMigrationProviderItem extends ItemBase {
  provider: SetupSnapshotProvider;
}

export interface SetupMigrationBuiltinToolItem extends ItemBase {
  id: string;
  enabled: boolean;
}

export type SetupMigrationAccessId = 'remote-control' | 'keep-awake';

export interface SetupMigrationAccessItem extends ItemBase {
  id: SetupMigrationAccessId;
}

export interface SetupMigrationRendererPrefsItem extends ItemBase {
  values: Record<string, string>;
}

export type SetupMigrationChecklistKind =
  | 'plugin-setup'
  | 'plugin-manual'
  | 'market-source'
  | 'skill-manual'
  | 'provider-key'
  | 'provider-connection'
  | 'provider-sign-in'
  | 'local-model'
  | 'mcp-token'
  | 'builtin-key'
  | 'im-channel'
  | 'computer-use'
  | 'remote-desktop'
  | 'ssh';

/** One thing that must be done once on this computer; never contains secret material. */
export interface SetupMigrationChecklistItem {
  id: string;
  kind: SetupMigrationChecklistKind;
  /** Object name shown to the user (plugin, provider, channel…); may be empty. */
  label: string;
  /** Host identity used to open the right settings page (ghost instance, provider id…). */
  ref?: string;
  /** Extra labels, e.g. which plugin accounts are missing. */
  details?: string[];
  done?: boolean;
}

export interface SetupMigrationPlan {
  planId: string;
  source: { deviceId: string; name: string; platform: string };
  createdAt: number;
  plugins: SetupMigrationPluginItem[];
  skills: SetupMigrationSkillItem[];
  settings: SetupMigrationSettingsItem[];
  rendererPrefs: SetupMigrationRendererPrefsItem | null;
  providers: SetupMigrationProviderItem[];
  mcpServers: SetupMigrationMcpItem[];
  builtinTools: SetupMigrationBuiltinToolItem[];
  access: SetupMigrationAccessItem[];
  /** Known before applying: credentials, logins and permissions this computer will need. */
  checklist: SetupMigrationChecklistItem[];
  /** Sections the other computer could not read this time. */
  unavailable: SetupSnapshotSection[];
}

export interface SetupMigrationApplyRequest {
  planId: string;
  /** Plan keys the user left selected. */
  keys: string[];
  /** Plugin keys whose permissions the user confirmed in the batch confirmation. */
  approvedPluginKeys: string[];
}

export type SetupMigrationOutcome = 'done' | 'skipped' | 'failed';

export interface SetupMigrationResult {
  key: string;
  outcome: SetupMigrationOutcome;
  /** Stable error code for display; never a raw error message. */
  code?: string;
}

export interface SetupMigrationApplyResponse {
  results: SetupMigrationResult[];
  checklist: SetupMigrationChecklistItem[];
}

export interface SetupMigrationProgress {
  planId: string;
  key: string;
  phase: 'running' | SetupMigrationOutcome;
  completed: number;
  total: number;
}

export interface SetupMigrationState {
  lastRun: {
    sourceName: string;
    finishedAt: number;
    checklist: SetupMigrationChecklistItem[];
  } | null;
  /** A computer worth suggesting on this new computer; null when no suggestion applies. */
  suggestion: { deviceId: string; name: string } | null;
}

export type SetupMigrationDismissRequest =
  | { kind: 'suggestion' }
  | { kind: 'checklist-item'; id: string }
  | { kind: 'checklist' };

export interface SetupMigrationApi {
  sources(): Promise<SetupMigrationSource[]>;
  preview(deviceId: string): Promise<SetupMigrationPlan>;
  apply(request: SetupMigrationApplyRequest): Promise<SetupMigrationApplyResponse>;
  state(): Promise<SetupMigrationState>;
  dismiss(request: SetupMigrationDismissRequest): Promise<SetupMigrationState>;
  onProgress(listener: (progress: SetupMigrationProgress) => void): () => void;
  host: {
    ready(): void;
    reply(reply: SetupMigrationHostReply): void;
    onRequest(listener: (request: SetupMigrationHostRequest) => void): () => void;
  };
}
