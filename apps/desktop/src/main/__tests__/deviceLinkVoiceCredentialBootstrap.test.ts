/**
 * Locks the real Electron desktop path for device-link voice channels.
 *
 * Mobile voice credential sync itself is removed (mobile voice input now uses
 * the managed Cindy voice service); the channel stays matched so old mobile
 * builds get a readable rejection. This source guard prevents a future
 * bootstrap refactor from leaving dispatch unreachable from the running
 * desktop DeviceLinkClient.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const mainRoot = resolve(__dirname, '..');

describe('mobile voice credential sync desktop bootstrap path', () => {
  it('starts device-link service from Electron bootstrap', () => {
    const bootstrap = readFileSync(resolve(mainRoot, 'bootstrap-electron.ts'), 'utf8');

    expect(bootstrap).toMatch(/import \{[^}]*\binitDeviceLinkService\b[^}]*\} from '\.\/device-link';/);
    const serviceInit = bootstrap.search(/\binitDeviceLinkService\s*\(\s*\{/);
    const ipcRegistration = bootstrap.search(/\bregisterDeviceLinkIpc\s*\(\s*\)\s*;/);
    expect(serviceInit).toBeGreaterThanOrEqual(0);
    expect(ipcRegistration).toBeGreaterThanOrEqual(0);
    expect(serviceInit).toBeLessThan(ipcRegistration);
  });

  it('wires the DeviceLinkClient inbound frames into controlled-desktop dispatch', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('wireInboundDispatch,');
    const listenerRegistration = deviceLinkHost.search(
      /\bsetControllersChangedListener\s*\(\s*\(\s*controllers\s*,\s*updateRelaunchControllers\s*\)\s*=>/,
    );
    const inboundWiring = deviceLinkHost.search(/\bwireInboundDispatch\s*\(\s*client\s*\)\s*;/);
    expect(listenerRegistration).toBeGreaterThanOrEqual(0);
    expect(inboundWiring).toBeGreaterThanOrEqual(0);
    expect(listenerRegistration).toBeLessThan(inboundWiring);
  });

  it('replays desktop subscriptions when a remote device becomes controllable again', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('const available = snap.online && snap.remoteControlEnabled;');
    // `!== true` 而非 `=== false`:断线时 availability 视图整体清空,重连后首帧
    // presence(wasAvailable=undefined)同样必须触发重放,接续 DEVICE_OFFLINE
    // 结束的恢复轮次(#1520 review P1)。
    expect(deviceLinkHost).toContain('if (available && wasAvailable !== true)');
    expect(deviceLinkHost).toContain('replayActiveSubscriptions(`presence-online:${snap.deviceId.slice(0, 8)}`, snap.deviceId);');
    expect(deviceLinkHost).toContain('createSubscriptionReplayScheduler({');
    // Preserve unknown after reconnect; only explicit unavailability stops retries.
    expect(deviceLinkHost).toContain(
      'getPresenceAvailability: (deviceId) => presenceAvailableByDevice.get(deviceId)',
    );
    expect(deviceLinkHost).toContain('?? (presenceOnlineByDevice.get(deviceId) === false ? false : undefined)');
    expect(deviceLinkHost).toContain("replayActiveSubscriptions('directory-online', deviceId);");
    expect(deviceLinkHost).toContain('isPermanentSubscriptionReplayError(error, presenceAvailableByDevice.get(deviceId))');
  });

  it('出站 link 被(重)接受时重放该设备订阅：被控端 relay 闪断清注册对本机不可见也能收敛', () => {
    // 失效后果(2026-10-20 线上事故):被控端 relay 探活超时 3s 重连,deactivateAllControllers
    // 清掉它那边本机的活跃订阅注册;本机 relay/presence/熔断全程无感知,传输层 link 经
    // replay 透明恢复,既有的 ws-online/presence/熔断恢复触发器一个都不 firing——push 驱动的
    // 列表 running 转圈与完成未读绿点永久冻结在旧值,新运行的远程任务不显示状态,
    // 而 invoke 与 session 事件流完全正常。onPeerStreamAccepted 是「已验证握手完成、
    // 对端恢复业务帧投递之前」的唯一本地时点,订阅重放必须挂在这里;provider-share
    // guest 只轮询不订阅(协议契约),是唯一被排除的 peer 类型。该接线在 Electron
    // bootstrap 内构造的 client 回调上,无法脱离 Electron 单测隔离,按 guard 锁定
    // (同本文件既有触发器断言)。
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    const handlerStart = deviceLinkHost.indexOf('client.onPeerStreamAccepted((peer, streamId) => {');
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    // provider-share guest 只轮询不订阅(协议契约),不得触发重放;普通设备与
    // shared task peer(guest 对共享宿主持的是普通 session 订阅)都必须覆盖。
    const guard = deviceLinkHost.indexOf('if (!isProviderSharePeer(peer)) {', handlerStart);
    expect(guard).toBeGreaterThan(handlerStart);
    const replay = deviceLinkHost.indexOf(
      'replayActiveSubscriptions(`link-accepted:${peer.slice(0, 8)}`, peer);',
      guard,
    );
    expect(replay).toBeGreaterThan(guard);
    // 重放必须位于 shared-host 早退分支之前:普通设备不能被 return 跳过;
    // shared task peer 同样先经重放,再进入既有 host 流追踪逻辑。
    const sharedHostReturn = deviceLinkHost.indexOf("parseSharedTaskPeer(peer)?.role !== 'host'", replay);
    expect(sharedHostReturn).toBeGreaterThan(replay);
  });

  it('每个 relay 连接代上线时从设备目录补齐展示名与已在线桌面', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain("serverApiFetch<DeviceDirectoryResponse>('/api/device-link/devices'");
    const onlineBranch = deviceLinkHost.indexOf("if (status === 'online') {");
    const seedCachedNames = deviceLinkHost.indexOf(
      'seedControllerDisplayNamesFromLastKnown();',
      onlineBranch,
    );
    const refreshDirectory = deviceLinkHost.indexOf(
      'void refreshControllerDisplayNamesFromDirectory(displayNameGeneration);',
      onlineBranch,
    );
    const replaySubscriptions = deviceLinkHost.indexOf(
      "replayActiveSubscriptions('ws-online');",
      onlineBranch,
    );
    expect(onlineBranch).toBeGreaterThanOrEqual(0);
    expect(seedCachedNames).toBeGreaterThan(onlineBranch);
    expect(refreshDirectory).toBeGreaterThan(seedCachedNames);
    expect(replaySubscriptions).toBeGreaterThan(refreshDirectory);
    expect(deviceLinkHost).toContain(
      'generation !== controllerDisplayNameRefreshGeneration',
    );
    expect(deviceLinkHost).toContain(
      'const directoryRequestSequence = beginControllerDisplayNameDirectoryRefresh();',
    );
    expect(deviceLinkHost).toContain(
      '!isLatestControllerDisplayNameDirectoryRefresh(directoryRequestSequence)',
    );
    expect(deviceLinkHost).toContain(
      'latestControllerDisplayNameDirectoryRefresh = {',
    );
    expect(deviceLinkHost).toContain(
      'const displayNameRequestEpoch = controllerDisplayNameFreshness.epoch;',
    );
    expect(deviceLinkHost).toContain(
      'const presenceRequestEpoch = controllerPresenceFreshness.epoch;',
    );
    expect(deviceLinkHost).toContain(
      'applyControllerDisplayNamePresence({',
    );
    expect(deviceLinkHost).toContain(
      "Object.prototype.hasOwnProperty.call(snap, 'selfName')",
    );
    expect(deviceLinkHost).toContain('applyControllerDisplayNameDirectorySnapshot({');
    expect(deviceLinkHost).toContain('applyControllerPresenceListSnapshot(result.devices ?? [], presenceRequestEpoch);');
    expect(deviceLinkHost).toContain(
      'markControllerPresenceFresh(controllerPresenceFreshness, snap.deviceId);',
    );
    expect(deviceLinkHost).toContain(
      'if (isMobilePlatform(platform)) handleMobilePeerOnline(deviceId);',
    );
  });

  it('presence 展示名统一走协调器，无有效权威名时保留 dispatch 回退链', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8')
      .replace(/\r\n/g, '\n');

    const presenceHandler = deviceLinkHost.indexOf('client.onPresenceChanged');
    const applyPresenceName = deviceLinkHost.indexOf(
      'applyControllerDisplayNamePresence({',
      presenceHandler,
    );
    expect(presenceHandler).toBeGreaterThanOrEqual(0);
    expect(applyPresenceName).toBeGreaterThan(presenceHandler);

    // guard 不写缓存时，dispatch 继续按「数据库名 → 自报名 → 短 ID」回退。
    expect(dispatch).toContain(
      'return controllerDisplayNameByDevice.get(deviceId)\n    ?? normalizedReportedName\n    ?? reportedControllerNameByDevice.get(deviceId);',
    );
    expect(dispatch).toContain(
      'const displayName = normalized\n    ?? reportedControllerNameByDevice.get(deviceId)\n    ?? deviceId.slice(0, 8);',
    );
  });

  it('keeps device-link:voice:credential-sync matched but rejected (feature removed, readable error for old mobile)', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_CREDENTIAL_SYNC_CHANNEL');
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_CREDENTIAL_SYNC_CHANNEL)');
    expect(dispatch).toContain("code: 'VOICE_CREDENTIAL_SYNC_REMOVED'");
    expect(dispatch).not.toContain('syncMobileVoiceCredential');
  });

  it('routes device-link:voice:dictionary-learning to desktop dictionary learning', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_DICTIONARY_LEARNING_CHANNEL');
    expect(dispatch).toContain("import { adviseAndRecordVoiceInputDictionaryLearning } from '../voice-input/index.js';");
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_DICTIONARY_LEARNING_CHANNEL)');
    expect(dispatch).toContain('handleMobileVoiceDictionaryLearning(src, (payload.args ?? [])[0])');
  });
});
