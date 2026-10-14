/**
 * pluginModelPrefsIpc.test.ts — 插件详情「模型与任务」的读通道:沿用 ghosts:errand-prefs,
 * 额外带出系统辅助模型显示名;旧的逐能力 ghosts:cindy-prefs 通道已移除。
 * 回调取自生产 index.ts 源码(同 ghostLocalFileIpc 的抽取方式)。
 */

import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

type SyncHandler = (event: { returnValue?: unknown }, ...args: unknown[]) => void;

const createCallbacks = createGhostProductionCallbacks<{ errandPrefs: SyncHandler }>({
  callbacks: { errandPrefs: ['ipcMain.on', 'ghosts:errand-prefs'] },
});

function read(deps: Record<string, unknown>, ghostId: unknown): unknown {
  const event: { returnValue?: unknown } = {};
  createCallbacks(deps).errandPrefs(event, ghostId);
  return event.returnValue;
}

describe('ghosts:errand-prefs (plugin model & tasks)', () => {
  it('returns the stored config and the current auxiliary model label, read fresh each time', () => {
    const readPluginTaskConfig = vi.fn(() => ({ permissionMode: 'auto' }));
    let refs = ['cat:xai:codex:grok-4.6'];
    const deps = {
      readPluginTaskConfig,
      getEffectiveAuxiliaryModelChain: () => ({ refs }),
      formatAuxiliaryModelRefLabel: (ref: string) => (ref.endsWith('grok-4.6') ? 'Grok 4.6' : 'GPT-5.5'),
    };
    expect(read(deps, 'writer')).toEqual({
      config: { permissionMode: 'auto' },
      auxiliaryModelLabel: 'Grok 4.6',
    });
    expect(readPluginTaskConfig).toHaveBeenCalledWith('writer');
    // 系统辅助模型改了:不缓存,下次打开详情页即跟随。
    refs = ['cat:openai:codex:gpt-5.5'];
    expect(read(deps, 'writer')).toMatchObject({ auxiliaryModelLabel: 'GPT-5.5' });
  });

  it('reports no auxiliary model when the chain is empty and ignores malformed ids', () => {
    const readPluginTaskConfig = vi.fn();
    expect(read({
      readPluginTaskConfig,
      getEffectiveAuxiliaryModelChain: () => ({ refs: [] }),
      formatAuxiliaryModelRefLabel: vi.fn(),
    }, 42)).toEqual({ config: {}, auxiliaryModelLabel: null });
    expect(readPluginTaskConfig).not.toHaveBeenCalled();
  });

  it('no longer registers the per-ability cindy-prefs channels', () => {
    const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("'ghosts:cindy-prefs'");
    expect(source).not.toContain("'ghosts:cindy-prefs:set'");
  });
});
