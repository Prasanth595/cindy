import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../../appSessionState.js';
import { createLogger } from '../../logger.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { captureProviderManagementScope } from '../../provider-group/managementScope.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import {
  DEFAULT_REMOTE_AGENT_IDLE_RELEASE,
  isRemoteAgentIdleRelease,
  type RemoteAgentIdleRelease,
  type RemoteAgentIdleReleaseView,
} from '../../../shared/remoteAgentIdleRelease.js';

const log = createLogger('remote-agent:idle-release');

/** 按账号存在这台电脑上，只记用户改过的值；没改过的随版本跟默认值。 */
const store = createOverrideSettingsFile<RemoteAgentIdleRelease>({
  filePath: () => ownerScopedUserDataPath('remote-agent-idle-release.json'),
  scopeKey: () => activeOwnerScopeKey(),
  defaults: DEFAULT_REMOTE_AGENT_IDLE_RELEASE,
  normalize: raw => isRemoteAgentIdleRelease(raw) ? { idleMinutes: raw.idleMinutes } : { ...DEFAULT_REMOTE_AGENT_IDLE_RELEASE },
  log,
  label: 'remote-agent-idle-release',
  preserveUnreadableFile: true,
});

export function readRemoteAgentIdleReleaseState(): RemoteAgentIdleReleaseView {
  store.invalidateIfChanged();
  const { value, defaults, isCustomized } = store.readState();
  return { value, defaults, isCustomized };
}

/** 连接池每次判断时读：读不到(切换账号途中等)按不让出名额处理。 */
export function readRemoteAgentIdleReleaseMinutes(): number {
  try {
    return readRemoteAgentIdleReleaseState().value.idleMinutes;
  } catch (error) {
    log.warn('idle release setting unavailable; not releasing', { error: String(error) });
    return 0;
  }
}

export async function saveRemoteAgentIdleRelease(value: RemoteAgentIdleRelease | null): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  if (value === null) await store.resetAtomic();
  else {
    if (!isRemoteAgentIdleRelease(value)) throwIpcError('INVALID_PARAMS', 'Invalid idle release minutes');
    // 显式保存默认值也是用户选择；恢复默认才删除 overrides。
    await store.writePatchAtomic({ idleMinutes: value.idleMinutes }, { preserveDefaults: true });
  }
  assertCurrent();
}
