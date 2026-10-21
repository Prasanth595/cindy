import type { MobileHomePresentation } from './mobileHome';

export interface HomeProjectMachineIdentity {
  displayLabel: string;
  disconnected: boolean;
  hideLabel: boolean;
}

type HomeMachineIdentitySource = Pick<MobileHomePresentation, 'projects' | 'deviceFilters' | 'selectedDeviceId'>
  & Partial<Pick<MobileHomePresentation, 'chats' | 'pinned'>>;
type DeviceFilter = MobileHomePresentation['deviceFilters'][number];

interface SessionDeviceFields {
  canonicalDeviceId?: string | null;
  deviceLinkDeviceId?: string | null;
  deviceLinkDeviceName?: string | null;
}

/** Display device of a task: same precedence as openSession (canonical first). */
export function homeSessionDeviceId(session: object): string | null {
  const { canonicalDeviceId, deviceLinkDeviceId } = session as SessionDeviceFields;
  return canonicalDeviceId ?? deviceLinkDeviceId ?? null;
}

/**
 * Visible machine names shared by project and chat rows, so one computer gets
 * the same label on both. Chats only count when their device is a known device
 * filter: shared-task peers and stale shards are not computers of this account.
 */
function collectMachineNames(home: HomeMachineIdentitySource, filters: ReadonlyMap<string | null, DeviceFilter>) {
  const projectName = (project: MobileHomePresentation['projects'][number]) =>
    (filters.get(project.deviceId)?.label ?? project.deviceName).trim();
  const chatName = (session: object) => {
    const deviceId = homeSessionDeviceId(session);
    const label = deviceId ? filters.get(deviceId)?.label : undefined;
    return label === undefined
      ? null
      : (label.trim() || ((session as SessionDeviceFields).deviceLinkDeviceName ?? '').trim());
  };
  const idsByName = new Map<string, Set<string>>();
  const chatNames = new Map<string, string>();
  const note = (deviceId: string | null, name: string) => {
    if (!deviceId || !name) return;
    const ids = idsByName.get(name.toLowerCase()) ?? new Set<string>();
    ids.add(deviceId);
    idsByName.set(name.toLowerCase(), ids);
  };
  for (const project of home.projects) note(project.deviceId, projectName(project));
  for (const item of [...(home.chats ?? []), ...(home.pinned ?? [])]) {
    const deviceId = homeSessionDeviceId(item.session);
    const name = chatName(item.session);
    if (!deviceId || name === null) continue;
    if (!chatNames.get(deviceId)) chatNames.set(deviceId, name);
    note(deviceId, name);
  }
  return { chatNames, idsByName, projectName };
}

function machineIdentity(
  deviceId: string,
  name: string,
  idsByName: ReadonlyMap<string, ReadonlySet<string>>,
  device: DeviceFilter | undefined,
  home: HomeMachineIdentitySource,
  connectionStates: Readonly<Record<string, string>>,
): HomeProjectMachineIdentity {
  const ambiguous = name && (idsByName.get(name.toLowerCase())?.size ?? 0) > 1;
  return {
    displayLabel: ambiguous ? `${name} · ${deviceId}` : name || deviceId,
    disconnected: !device?.available || connectionStates[deviceId] === 'failed',
    // As on Desktop, an explicit device heading makes the inline label redundant.
    hideLabel: home.selectedDeviceId === deviceId,
  };
}

/** Mirrors Desktop remoteProjectIdentity: only visible, distinct devices disambiguate names. */
export function buildHomeProjectMachineIdentities(
  home: HomeMachineIdentitySource,
  connectionStates: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, HomeProjectMachineIdentity> {
  const filters = new Map(home.deviceFilters.map((device) => [device.deviceId, device]));
  const { idsByName, projectName } = collectMachineNames(home, filters);
  const identities = new Map<string, HomeProjectMachineIdentity>();
  for (const project of home.projects) {
    if (!project.deviceId) continue;
    identities.set(project.key, machineIdentity(
      project.deviceId, projectName(project), idsByName, filters.get(project.deviceId), home, connectionStates,
    ));
  }
  return identities;
}

/**
 * Machine identity keyed by the device a task belongs to, for rows that have no
 * project header (top-level chats, pinned). Same names as project rows; only
 * known computers get one, so shared-task peers and stale shards never show a
 * false "disconnected" icon. Deliberately independent of
 * `sessionAgentRunsOnOtherComputer`: that says where the Agent runs, this says
 * where the task lives.
 */
export function buildHomeDeviceMachineIdentities(
  home: HomeMachineIdentitySource,
  connectionStates: Readonly<Record<string, string>> = {},
): Readonly<Record<string, HomeProjectMachineIdentity>> {
  const filters = new Map(home.deviceFilters.map((device) => [device.deviceId, device]));
  const { chatNames, idsByName } = collectMachineNames(home, filters);
  const identities: Record<string, HomeProjectMachineIdentity> = {};
  for (const [deviceId, name] of chatNames) {
    identities[deviceId] = machineIdentity(deviceId, name, idsByName, filters.get(deviceId), home, connectionStates);
  }
  return identities;
}
