/**
 * cross-agent-convert / IPC
 *
 * Channels:
 *   maker:cross-agent:detect(workingDir, agentKind) → DetectResult
 *   maker:cross-agent:convert(items)               → ConvertSummary（同时 push 进度事件）
 *   maker:cross-agent:step (push)                  → MigrationStepEvent
 *
 * Prompt preferences are local to this Desktop profile and only cover AGENTS.md → CLAUDE.md.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { detect, type DetectInput } from './detector.js';
import { convertAll } from './converter.js';
import type { AgentKind, DetectResult, MigrationItem, MigrationStepEvent } from './types.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createMigrationPromptPreferences } from './prompt-preferences.js';

const log = createLogger('cross-agent-convert:ipc');

export const CROSS_AGENT_CHANNELS = {
  DETECT: 'maker:cross-agent:detect',
  CONVERT: 'maker:cross-agent:convert',
  STEP: 'maker:cross-agent:step',
  PREFERENCES: 'maker:cross-agent:prompt-preferences',
} as const;

const promptPreferences = createMigrationPromptPreferences(() =>
  path.join(app.getPath('userData'), 'cross-agent-prompt-preferences.json'),
);

function broadcastStep(ev: MigrationStepEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(CROSS_AGENT_CHANNELS.STEP, ev);
    } catch (e) {
      log.warn(`broadcast step failed: ${String(e)}`);
    }
  }
}

export function registerCrossAgentConvertIpc(): void {
  log.info('registering maker:cross-agent:* IPC handlers');

  ipcMain.handle(
    CROSS_AGENT_CHANNELS.DETECT,
    async (event, workingDir: unknown, agentKind: unknown): Promise<DetectResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof workingDir !== 'string' || !workingDir) return { items: [] };
      if (agentKind !== 'claude-code' && agentKind !== 'codex') return { items: [] };
      const result = await detect({
        workingDir,
        agentKind: agentKind as AgentKind,
      } satisfies DetectInput);
      if (agentKind === 'claude-code' && (await promptPreferences.isSuppressed(workingDir))) {
        result.items = result.items.filter((item) => item.kind !== 'agents-md');
      }
      return result;
    },
  );

  // This prompt is only shown by local Desktop drafts. SSH, hosted drafts and
  // Mobile do not run this migration flow; do not expose preference writes remotely.
  ipcMain.handle(
    CROSS_AGENT_CHANNELS.PREFERENCES,
    async (event, action: unknown, workingDir: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (action === 'list') return promptPreferences.list();
      if (
        (action !== 'suppress' && action !== 'restore') ||
        typeof workingDir !== 'string' ||
        workingDir.length > 32768 ||
        workingDir.includes('\0') ||
        !path.isAbsolute(workingDir)
      ) {
        throwIpcError('INVALID_ARGUMENT', 'Invalid migration prompt preference');
      }
      try {
        return await promptPreferences.setSuppressed(workingDir as string, action === 'suppress');
      } catch {
        throwIpcError('INTERNAL', 'Could not save migration prompt preference');
      }
    },
  );

  ipcMain.handle(CROSS_AGENT_CHANNELS.CONVERT, async (_e, items: unknown) => {
    if (!Array.isArray(items)) {
      throw new Error('[INVALID_ITEMS]');
    }
    // 信任 renderer 传回来的 items（结构由 detector 产出）。converter 内部仍做安全二次校验。
    return convertAll(items as MigrationItem[], broadcastStep);
  });

  log.info('maker:cross-agent:* IPC handlers registered');
}
