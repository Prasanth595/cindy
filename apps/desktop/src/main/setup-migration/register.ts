/**
 * Wires new-computer setup to the real installers, stores and device link
 * (docs/product-rules/new-device-setup-migration.md). Business rules live in
 * service/plan/apply/snapshot; this file only adapts existing host modules.
 */
import { BrowserWindow, ipcMain } from 'electron';
import type { Maker } from '@cindy/maker-core';
import {
  SETUP_SNAPSHOT_CHANNEL,
  type SetupSnapshotPlugin,
  type SetupSnapshotRequest,
  type SetupSnapshotSkill,
} from '@cindy/device-link';
import { isByokProviderId, isOrganizationManagedProvider } from '@cindy/model-providers';

import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost.js';
import { evaluateGhostInstallConsent } from '../../shared/ghostInstallConsent.js';
import { isManagedSidecarProviderId } from '../../shared/localModelRuntime.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { PROVIDER_SECRET_IDS, type ProviderSecretId } from '../../shared/providerSecrets.js';
import {
  SETUP_MIGRATION_IPC,
  type SetupMigrationApplyRequest,
  type SetupMigrationChecklistItem,
  type SetupMigrationDismissRequest,
} from '../../shared/setupMigration.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  createWindowGhostInstallConsentPrompt,
  getGhostManager,
  getGhostSetupAssessment,
  setGhostEnabledForUser,
} from '../cindy-brain/index.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { setSetupSnapshotRemoteHandler } from '../device-link/dispatch.js';
import { defaultDeps as deviceDirectoryDeps, handleListDevices } from '../device-link/ipc.js';
import { readDeviceLinkSettings } from '../device-link/settings-store.js';
import { ownerScopedImSecrets } from '../im/ownerScopedStorage.js';
import { createLogger } from '../logger.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { listCustomMcpServers } from '../maker-host/custom-mcp-store.js';
import { listCustomProviders } from '../maker-host/custom-provider-store.js';
import { getPluginRegistry } from '../maker-host/index.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import type { BuiltInSkillDescriptor } from '../maker-host/built-in-skills.js';
import { getPluginMarketService } from '../plugin-market/service.js';
import { getRemoteSshPoolHydrated } from '../remote-ssh/index.js';
import {
  getProviderSecretStore,
  readCustomMcpToken,
  readCustomProviderKey,
} from '../secrets/providerSecretStore.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { setCindySkillEnabled } from '../skillhub/activationPreferences.js';
import * as skillInstallService from '../skillhub/installService.js';
import { tryAcquireSkillInstallLock } from '../skillhub/installLock.js';
import { scanAllSkills, type Skill } from '../skillhub/scanner.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { registerSetupMigrationRendererHost } from './rendererPrefsHost.js';
import {
  createSetupMigrationService,
  type PersistedSetupMigrationState,
  type SetupDeviceFact,
} from './service.js';
import { SETUP_SETTINGS_GROUPS } from './settingsGroups.js';
import type { TargetCatalogFact, TargetGhostFact } from './plan.js';
import type { SourceProviderFact } from './snapshot.js';

const log = createLogger('setup-migration');

export interface RegisterSetupMigrationOptions {
  getMaker(): Maker;
  getManagedSkillRoots(): readonly string[];
  getBuiltInSkills(): readonly BuiltInSkillDescriptor[];
}

const IM_CHANNEL_SECRETS: ReadonlyArray<[string, string]> = [
  ['telegram', 'telegram-bot-token'],
  ['feishu', 'feishu_bot_app_id'],
  ['wecom', 'wecom-bot-id'],
  ['dingtalk', 'dingtalk-bot-app-key'],
  ['discord', 'discord-bot-token'],
];
const CUSTOM_PROVIDER_AGENTS = ['claude-code', 'codex', 'pi'] as const;

const EMPTY_STATE: PersistedSetupMigrationState = { lastRun: null, suggestionDismissed: false };

function normalizeState(raw: unknown): PersistedSetupMigrationState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
  const value = raw as Record<string, unknown>;
  const lastRunRaw = value.lastRun as Record<string, unknown> | null | undefined;
  let lastRun: PersistedSetupMigrationState['lastRun'] = null;
  if (lastRunRaw && typeof lastRunRaw === 'object') {
    const checklist = Array.isArray(lastRunRaw.checklist)
      ? (lastRunRaw.checklist as unknown[]).flatMap((item): SetupMigrationChecklistItem[] => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.id !== 'string' || typeof entry.kind !== 'string') return [];
          return [
            {
              id: entry.id.slice(0, 512),
              kind: entry.kind as SetupMigrationChecklistItem['kind'],
              label: typeof entry.label === 'string' ? entry.label.slice(0, 200) : '',
              ...(typeof entry.ref === 'string' ? { ref: entry.ref.slice(0, 512) } : {}),
              ...(Array.isArray(entry.details)
                ? { details: entry.details.filter((d): d is string => typeof d === 'string').slice(0, 8) }
                : {}),
              ...(entry.done === true ? { done: true } : {}),
            },
          ];
        }).slice(0, 200)
      : [];
    lastRun = {
      sourceName: typeof lastRunRaw.sourceName === 'string' ? lastRunRaw.sourceName.slice(0, 200) : '',
      finishedAt: typeof lastRunRaw.finishedAt === 'number' ? lastRunRaw.finishedAt : 0,
      checklist,
    };
  }
  return { lastRun, suggestionDismissed: value.suggestionDismissed === true };
}

const stateFile = createOverrideSettingsFile<PersistedSetupMigrationState>({
  filePath: () => ownerScopedUserDataPath('setup-migration-state.json'),
  defaults: EMPTY_STATE,
  normalize: normalizeState,
  log: desktopMakerLogger.child('setup-migration-state'),
  label: 'setup-migration',
  scopeKey: activeOwnerScopeKey,
  maxBytes: 256 * 1024,
});

function ownerKey(): string | null {
  if (isAppSessionBoundaryPending() || !getActiveAppSession().dataOwnerId) return null;
  return activeOwnerScopeKey();
}

function listGhosts(): InstalledGhost[] {
  return isAppSessionBoundaryPending() ? [] : getGhostManager().list();
}

function ghostFact(ghost: InstalledGhost): TargetGhostFact {
  return {
    ghostId: ghost.manifest.id,
    namespace: ghost.namespace,
    instanceKey: installedGhostStoragePart(ghost),
    enabled: ghost.enabled,
    builtin: ghost.builtin === true,
  };
}

function findGhost(ghostId: string, namespace: string | null): InstalledGhost | null {
  const sameId = listGhosts().filter((ghost) => ghost.manifest.id === ghostId);
  return (
    sameId.find((ghost) => ghost.namespace !== undefined && (ghost.namespace ?? null) === namespace) ??
    (sameId.length === 1 && sameId[0].namespace === undefined ? sameId[0] : null)
  );
}

function ghostRef(ghost: InstalledGhost) {
  return {
    instanceKey: installedGhostStoragePart(ghost),
    enabled: ghost.enabled,
    approval: ghostInstallApprovalToken(ghost.approval),
  };
}

function isUserProvider(id: string): boolean {
  if (isByokProviderId(id) || isManagedSidecarProviderId(id)) return false;
  return !getActiveCatalog().providers.some(
    (provider) => provider.id === id && isOrganizationManagedProvider(provider),
  );
}

function pluginSetupMissing(instanceKey: string): string[] | null {
  const assessment = getGhostSetupAssessment(instanceKey);
  if (assessment.state === 'ready') return null;
  const labels = assessment.groups.flatMap((group) =>
    group.items.some((item) => item.state === 'satisfied')
      ? []
      : group.items.filter((item) => item.state !== 'satisfied').map((item) => item.label),
  );
  return [...new Set(labels)];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

function broadcastSkillsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('skillhub:local-state-changed');
    } catch {
      // Window closed.
    }
  }
}

export function registerSetupMigration(options: RegisterSetupMigrationOptions): void {
  const rendererHost = registerSetupMigrationRendererHost();
  const market = () => getPluginMarketService();

  const globalSkills = async (): Promise<Skill[]> => {
    const result = await scanAllSkills(
      { projects: [] },
      options.getMaker(),
      options.getManagedSkillRoots(),
      options.getBuiltInSkills(),
    );
    const byName = new Map<string, Skill>();
    for (const skill of result.skills) {
      if (skill.scope !== 'global' || skill.kind !== 'skill' || skill.builtIn || skill.managedByPlugin) continue;
      const name = skill.registrySkillName ?? skill.name;
      if (!byName.has(name)) byName.set(name, skill);
    }
    return [...byName.values()];
  };

  const service = createSetupMigrationService({
    platform: process.platform,
    now: () => Date.now(),
    ownerKey,
    listDevices: async () => {
      const { devices } = await handleListDevices(deviceDirectoryDeps());
      return devices.map(
        (device): SetupDeviceFact => ({
          deviceId: device.deviceId,
          name: device.name,
          platform: device.platform ?? '',
          online: device.online,
          remoteControlEnabled: device.remoteControlEnabled,
          controlEnabled: device.controlEnabled,
          isSelf: device.isSelf,
          lastSeenAt: device.lastSeenAt,
        }),
      );
    },
    invokeRemote: async (deviceId: string, request: SetupSnapshotRequest) => {
      const reply = await remoteBackgroundInvoke(deviceId, SETUP_SNAPSHOT_CHANNEL, [request]);
      if (reply.ok) return reply.result;
      throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    },
    targetGhosts: () => listGhosts().map(ghostFact),
    catalog: async (plugins: SetupSnapshotPlugin[]) => {
      const out = new Map<string, TargetCatalogFact>();
      const snapshot = await market().snapshot({ discoveryOnly: true });
      const visible = new Set(snapshot.items.map((item) => item.pluginId));
      const wanted = plugins.filter(
        (plugin) => plugin.pluginId && visible.has(plugin.pluginId) && !findGhost(plugin.ghostId, plugin.namespace),
      );
      await mapLimit(wanted, 4, async (plugin) => {
        try {
          const detail = await market().detail(plugin.pluginId!);
          out.set(plugin.pluginId!, {
            pluginId: plugin.pluginId!,
            releaseId: detail.releaseId,
            version: detail.version,
            consent: evaluateGhostInstallConsent(null, detail.manifest),
          });
        } catch (error) {
          log.warn('setup plugin detail unavailable', {
            ghostId: plugin.ghostId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return out;
    },
    marketNames: async () => new Set((await market().listSources()).map((source) => source.name)),
    localSkills: async () =>
      new Map(
        (await globalSkills()).map((skill) => [
          skill.registrySkillName ?? skill.name,
          { enabled: skill.cindyEnabled !== false },
        ]),
      ),
    mcpIds: async () => new Set((await listCustomMcpServers()).map((server) => server.id)),
    providerIds: async () => new Set((await listCustomProviders()).map((provider) => provider.id)),
    builtinTools: async () => {
      const items = await getPluginRegistry().listPlugins(undefined, true);
      return new Map(
        items
          .filter((item) => !item.essential)
          .map((item) => [
            item.id,
            {
              enabled: item.effectiveEnabled,
              userSet: item.userOverride !== undefined || item.globalOverride !== undefined,
            },
          ]),
      );
    },
    access: () => {
      const settings = readDeviceLinkSettings();
      return { remoteControlEnabled: settings.remoteControlEnabled, keepAwake: settings.keepAwake };
    },
    settingsGroups: SETUP_SETTINGS_GROUPS,
    apply: {
      marketNames: async () => new Set((await market().listSources()).map((source) => source.name)),
      addMarketSource: async (source) => {
        await market().addSource({
          source: source.url,
          ...(source.ref ? { ref: source.ref } : {}),
          sparsePaths: source.sparsePaths,
        });
      },
      pluginDetail: async (pluginId) => {
        const detail = await market().detail(pluginId);
        return { releaseId: detail.releaseId, manifest: detail.manifest };
      },
      installPlugin: async (pluginId, installOptions, prompt) => {
        const result = await market().install(
          pluginId,
          { ...installOptions, allowSourceReplacement: false },
          { consent: { prompt, initiator: 'user' } },
        );
        return ghostRef(result.ghost);
      },
      findGhost: (ghostId, namespace) => {
        const ghost = findGhost(ghostId, namespace);
        return ghost ? ghostRef(ghost) : null;
      },
      setPluginEnabled: async (ghost, enabled) => {
        await setGhostEnabledForUser(ghost.instanceKey, enabled, ghost.approval);
      },
      installSkill: async (name, catalogScope) => {
        const result = await skillInstallService.install(
          { name, ...(catalogScope ? { catalogScope } : {}) },
          () => {},
        );
        if (!result.success) {
          throw Object.assign(new Error(result.errorCode), { code: `SKILL_${result.errorCode}` });
        }
        broadcastSkillsChanged();
        return { absolutePath: result.absolutePath };
      },
      setSkillEnabled: async (absolutePath, enabled) => {
        const name = absolutePath.split(/[\\/]/).filter(Boolean).pop() ?? absolutePath;
        const release = tryAcquireSkillInstallLock(name, 'market-uninstall');
        if (!release) throw Object.assign(new Error('Skill busy'), { code: 'SKILL_BUSY' });
        try {
          await setCindySkillEnabled(absolutePath, enabled);
        } finally {
          release();
        }
        broadcastSkillsChanged();
      },
      findSkill: async (name) => {
        const skill = (await globalSkills()).find(
          (candidate) => (candidate.registrySkillName ?? candidate.name) === name,
        );
        return skill ? { absolutePath: skill.absolutePath, enabled: skill.cindyEnabled !== false } : null;
      },
      pluginSetupMissing,
    },
    readState: () => stateFile.read(),
    writeState: (next) => stateFile.writePatchAtomic(next, { preserveDefaults: true }),
    checklistItemDone: (item) => {
      switch (item.kind) {
        case 'plugin-setup': {
          if (!item.ref || !listGhosts().some((ghost) => installedGhostStoragePart(ghost) === item.ref)) {
            return null;
          }
          return pluginSetupMissing(item.ref) === null;
        }
        case 'provider-key':
          return item.ref
            ? CUSTOM_PROVIDER_AGENTS.some((agent) => readCustomProviderKey(item.ref!, agent) !== null)
            : null;
        case 'mcp-token':
          return item.ref ? readCustomMcpToken(item.ref) !== null : null;
        case 'builtin-key':
          return item.ref && (PROVIDER_SECRET_IDS as readonly string[]).includes(item.ref)
            ? getProviderSecretStore().has(item.ref as ProviderSecretId)
            : null;
        default:
          return null;
      }
    },
    looksNew: async () => {
      const ghosts = listGhosts().filter((ghost) => ghost.builtin !== true);
      if (ghosts.length > 0) {
        const snapshot = await market().snapshot({ discoveryOnly: true });
        const defaults = new Set(
          snapshot.items.filter((item) => item.defaultInstall).map((item) => item.ghostId),
        );
        if (ghosts.some((ghost) => !defaults.has(ghost.manifest.id))) return false;
      }
      if ((await listCustomProviders()).some((provider) => isUserProvider(provider.id))) return false;
      return (await listCustomMcpServers()).length === 0;
    },
    source: {
      platform: process.platform,
      now: () => Date.now(),
      settingsGroups: SETUP_SETTINGS_GROUPS,
      readRendererPrefs: () => rendererHost.read(),
      readPlugins: async () => {
        const snapshot = await market().snapshot({ discoveryOnly: true });
        return {
          ghosts: listGhosts().map((ghost) => ({
            ...ghostFact(ghost),
            name: ghost.manifest.name,
            version: ghost.manifest.version,
          })),
          market: snapshot.items.map((item) => ({
            pluginId: item.pluginId,
            ghostId: item.ghostId,
            ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
            installed: item.installState === 'installed' || item.installState === 'update-available',
            sourceType: item.sourceType,
            sourceMarketName: item.sourceMarketName,
            defaultInstall: item.defaultInstall,
          })),
        };
      },
      pluginSetupReady: (instanceKey) => getGhostSetupAssessment(instanceKey).state === 'ready',
      readMarketSources: async () =>
        (await market().listSources()).map((summary) => ({ name: summary.name, source: summary.source })),
      readSkills: async (): Promise<SetupSnapshotSkill[]> =>
        (await globalSkills()).map((skill) => ({
          name: skill.registrySkillName ?? skill.name,
          version: skill.registryEntry?.version ?? null,
          catalogScope: skill.registryEntry?.catalogScope ?? null,
          origin: skill.registryEntry?.origin ?? null,
          enabled: skill.cindyEnabled !== false,
        })),
      readMcpServers: async () =>
        (await listCustomMcpServers()).map((server) => ({
          ...server,
          hasToken: readCustomMcpToken(server.id) !== null,
        })),
      readProviders: async () =>
        (await listCustomProviders()).map((config) => ({ ...config }) as SourceProviderFact),
      isUserProvider,
      readBuiltinToolOverrides: async () => {
        const items = await getPluginRegistry().listPlugins(undefined, true);
        return items.flatMap((item) => {
          if (item.essential) return [];
          const override = item.globalOverride ?? item.userOverride;
          return override ? [{ id: item.id, enabled: override.enabled }] : [];
        });
      },
      readAccess: () => {
        const settings = readDeviceLinkSettings();
        return {
          remoteControlEnabled: settings.remoteControlEnabled,
          remoteDesktopEnabled: settings.remoteDesktopEnabled === true,
          keepAwake: settings.keepAwake,
        };
      },
      readHints: async () => {
        const secretStore = getProviderSecretStore();
        const builtinKeys = PROVIDER_SECRET_IDS.filter((id) => id !== 'xd' && secretStore.has(id));
        const imChannels = IM_CHANNEL_SECRETS.flatMap(([channel, key]) =>
          ownerScopedImSecrets.readResult?.(key).kind === 'value' ? [channel] : [],
        );
        let sshHostCount = 0;
        try {
          sshHostCount = (await getRemoteSshPoolHydrated()).list().length;
        } catch {
          sshHostCount = 0;
        }
        return { builtinKeys, imChannels, sshHostCount };
      },
    },
  });

  setSetupSnapshotRemoteHandler({ handle: (raw) => service.handleRemote(raw) });

  ipcMain.handle(SETUP_MIGRATION_IPC.SOURCES, (event) => {
    assertTrustedAppRendererEvent(event);
    return service.sources();
  });
  ipcMain.handle(SETUP_MIGRATION_IPC.PREVIEW, (event, deviceId: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 200) {
      throwIpcError('INVALID_PARAMS', 'deviceId required');
    }
    return service.preview(deviceId, event.sender.id);
  });
  ipcMain.handle(SETUP_MIGRATION_IPC.APPLY, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseApplyRequest(raw);
    const sender = event.sender;
    return service.apply(
      request,
      sender.id,
      createWindowGhostInstallConsentPrompt(sender),
      (progress) => {
        if (!sender.isDestroyed()) sender.send(SETUP_MIGRATION_IPC.PROGRESS, progress);
      },
    );
  });
  ipcMain.handle(SETUP_MIGRATION_IPC.STATE, (event) => {
    assertTrustedAppRendererEvent(event);
    return service.state();
  });
  ipcMain.handle(SETUP_MIGRATION_IPC.DISMISS, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return service.dismiss(parseDismissRequest(raw));
  });
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) throwIpcError('INVALID_PARAMS', 'Invalid setup selection');
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 600)
    .slice(0, max);
}

export function parseApplyRequest(raw: unknown): SetupMigrationApplyRequest {
  if (!raw || typeof raw !== 'object') throwIpcError('INVALID_PARAMS', 'Invalid setup selection');
  const value = raw as Record<string, unknown>;
  if (typeof value.planId !== 'string' || value.planId.length === 0 || value.planId.length > 64) {
    throwIpcError('INVALID_PARAMS', 'Invalid setup selection');
  }
  return {
    planId: value.planId,
    keys: stringList(value.keys, 2000),
    approvedPluginKeys: stringList(value.approvedPluginKeys, 400),
  };
}

export function parseDismissRequest(raw: unknown): SetupMigrationDismissRequest {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (value.kind === 'suggestion' || value.kind === 'checklist') return { kind: value.kind };
  if (value.kind === 'checklist-item' && typeof value.id === 'string' && value.id.length <= 600) {
    return { kind: 'checklist-item', id: value.id };
  }
  throwIpcError('INVALID_PARAMS', 'Invalid dismiss request');
}

