import type { AgentKind } from '@cindy/maker-core';


export { readRemoteProviderRoute as readImRemoteProviderRoute } from '../remote-agent/controller/deviceCatalog';

/** 权限档也取执行端能力，发起电脑可能没有安装该引擎。 */
export async function readImRemotePermissionModes(agentDeviceId: string, agentKind: AgentKind): Promise<string[]> {
  const { remoteBackgroundInvoke } = await import('../device-link');
  const response = await remoteBackgroundInvoke(agentDeviceId, 'maker:get-capabilities', [agentKind]);
  if (!response.ok) throw new Error(response.error?.message ?? 'Remote agent capabilities unavailable');
  const modes = (response.result as { permissionModes?: unknown } | null)?.permissionModes;
  if (!Array.isArray(modes) || !modes.length || !modes.every((mode) =>
    mode && typeof mode === 'object' && typeof mode.id === 'string' && mode.id.length > 0)) {
    throw new Error('Invalid remote agent permission modes');
  }
  return modes.map((mode) => mode.id);
}
