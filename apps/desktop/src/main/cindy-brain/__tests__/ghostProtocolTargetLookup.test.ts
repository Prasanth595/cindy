/**
 * cindy-ghost:// 请求的目标复核（#5983）：每个面板资源请求前后各复核一次目标，
 * /wake 也要查一次。用生产里接到协议 handler 的回调 + 真实 GhostManager，
 * 装多个插件，断言稳定注册后的目标请求只读目标实例，不因其他插件做全量扫描；
 * 同时守住实例隔离和失效语义。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installedGhostMutationTargetToken } from '../../../shared/pluginIdentity.js';
import { GhostManager, type GhostManagerOptions } from '../GhostManager.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

type TargetStore = {
  captureTarget(ghostId: string): string | null;
  isTargetCurrent(ghostId: string, expectedTarget: string | null): boolean;
};
type WakeHandler = (ghostId: string) => Promise<{ state: string }>;

const TARGET = '_ns__acme__canvas';
const OTHER_PLUGINS = 12;

const mutateSnapshot: NonNullable<GhostManagerOptions['mutateSnapshot']> = async ({ parentDir, ...request }) => {
  await runGhostSnapshotWorkerRequest(request, parentDir);
};

let workDir: string;
let manager: GhostManager;
let owner: string;

async function packageFor(id: string): Promise<string> {
  return writeTestCindyPackage(path.join(workDir, `${id}-${Date.now()}-${Math.random()}.cindy`), {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: 'do' }],
  }, { 'main.js': '// ok\n' });
}

async function installTarget(): Promise<void> {
  await expect(manager.install(await packageFor('canvas'), {
    namespace: 'acme', registrySource: 'market', pluginId: 'plugin-canvas',
  })).resolves.toMatchObject({ ghost: { instanceKey: TARGET } });
}

function productionCallbacks(spawn = vi.fn(async () => ({ ok: true, state: 'running' }))) {
  const callbacks = createGhostProductionCallbacks<{ store: TargetStore; wake: WakeHandler }>({
    functions: ['availableGhosts', 'findGhostForInstanceId', 'ghostInstallMutationTargetFor'],
    callbacks: { store: ['setGhostKvStore'], wake: ['setGhostWakeHandler'] },
  })({
    getGhostManager: () => manager,
    isAppSessionBoundaryPending: () => false,
    isGhostAvailableForActiveSession: () => true,
    activeOwnerScopeKey: () => owner,
    installedGhostMutationTargetToken,
    runtime: { stateOf: () => 'off', spawn },
  });
  return { ...callbacks, spawn };
}

beforeEach(async () => {
  workDir = fs.realpathSync.native(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-protocol-target-')));
  manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts'), mutateSnapshot });
  owner = 'owner-a';
  for (let index = 0; index < OTHER_PLUGINS; index += 1) {
    const id = `other-${index}`;
    await manager.install(await packageFor(id), index % 2 === 0
      ? {}
      : { namespace: 'acme', registrySource: 'market', pluginId: `plugin-${id}` });
  }
  await manager.install(await packageFor('canvas'));
  await installTarget();
  manager.list();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('cindy-ghost:// target lookup', () => {
  it('rechecks a registered panel target without rescanning the other installed plugins', async () => {
    const { store, wake, spawn } = productionCallbacks();
    const expected = store.captureTarget(TARGET);
    expect(expected).not.toBeNull();
    const list = vi.spyOn(manager, 'list');
    const readdir = vi.spyOn(fs, 'readdirSync');
    // A panel open loads dozens of static files; each request checks its
    // target before it runs and again before it answers.
    for (let request = 0; request < 40; request += 1) {
      expect(store.isTargetCurrent(TARGET, expected)).toBe(true);
      expect(store.isTargetCurrent(TARGET, expected)).toBe(true);
    }
    expect(store.captureTarget(TARGET)).toBe(expected);
    await expect(wake(TARGET)).resolves.toEqual({ state: 'running' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ instanceKey: TARGET }));
    expect(list).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it('keeps the root and organization instances of the same plugin apart', () => {
    const { store } = productionCallbacks();
    const rootKey = manager.list().find((ghost) => ghost.manifest.id === 'canvas' && ghost.instanceKey !== TARGET)?.instanceKey;
    expect(rootKey).toBeDefined();
    const organization = store.captureTarget(TARGET);
    const root = store.captureTarget(rootKey!);
    expect(root).not.toBeNull();
    expect(root).not.toBe(organization);
    expect(store.isTargetCurrent(rootKey!, organization)).toBe(false);
    expect(store.isTargetCurrent(TARGET, root)).toBe(false);
    // The bare plugin id names two installs, so it opens neither.
    expect(store.captureTarget('canvas')).toBeNull();
  });

  it('rejects an old target after uninstall, reinstall or an account switch, and accepts the current one', async () => {
    const { store, wake } = productionCallbacks();
    const before = store.captureTarget(TARGET);
    owner = 'owner-b';
    expect(store.isTargetCurrent(TARGET, before)).toBe(false);
    owner = 'owner-a';
    expect(store.isTargetCurrent(TARGET, before)).toBe(true);

    await expect(manager.uninstall('_ns/acme/canvas', { notify: false })).resolves.toEqual({ ok: true });
    expect(store.captureTarget(TARGET)).toBeNull();
    expect(store.isTargetCurrent(TARGET, before)).toBe(false);
    await expect(wake(TARGET)).resolves.toEqual({ state: 'off' });

    await installTarget();
    const after = store.captureTarget(TARGET);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(store.isTargetCurrent(TARGET, before)).toBe(false);
    expect(store.isTargetCurrent(TARGET, after)).toBe(true);
  });

  it('still resolves a bare plugin id through the full list', () => {
    const { store } = productionCallbacks();
    const list = vi.spyOn(manager, 'list');
    expect(store.captureTarget('other-0')).not.toBeNull();
    expect(list).toHaveBeenCalled();
  });
});
