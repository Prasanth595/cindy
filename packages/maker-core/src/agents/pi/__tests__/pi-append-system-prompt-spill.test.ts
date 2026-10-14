/**
 * 超长 host 提示词改走文件通道 —— mock transport / PiRpcProcess(不 spawn 真 pi),
 * 捕获 spawn argv 与 PI_CODING_AGENT_DIR,验证:
 *   1. 超过内联上限的 `--append-system-prompt`(Bot 身份 + profile context +
 *      teammate guide + 记忆索引可达数十 KB)写进会话 configHome,命令行只留路径,
 *      Windows 预算守卫因此仍有余量;
 *   2. 同一提示词若按旧行为内联,断言守卫会拦下 —— 证明该用例本身就在危险区;
 *   3. 小提示词保持内联,普通会话的命令行不变;
 *   4. 文件内容与提示词一致,会话关闭后随 configHome 一并清理。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPiSpawnArgvFitsPlatform } from '../project-resource-cli.js';

const knobs = vi.hoisted(() => ({
  spawnArgs: [] as string[],
  configHome: '',
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: {
    args?: string[];
    env?: Record<string, string>;
  }) => {
    knobs.spawnArgs = opts.args ?? [];
    knobs.configHome = opts.env?.PI_CODING_AGENT_DIR ?? '';
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    async request(cmd: Record<string, unknown>): Promise<{ success: boolean; data?: unknown }> {
      if (cmd.type === 'get_state') {
        return {
          success: true,
          data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } },
        };
      }
      return { success: true, data: {} };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
    }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const SPILL_FILE_NAME = 'append-system-prompt.md';

describe('PiAgent oversized --append-system-prompt file channel', () => {
  let agentHome = '';
  let cwd = '';

  beforeEach(() => {
    knobs.spawnArgs = [];
    knobs.configHome = '';
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-prompt-file-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-prompt-file-cwd-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
    };
  }

  function appendPromptValue(): { index: number; value: string | undefined } {
    const index = knobs.spawnArgs.indexOf('--append-system-prompt');
    return { index, value: index >= 0 ? knobs.spawnArgs[index + 1] : undefined };
  }

  it('spills an oversized prompt into configHome and keeps only the path in argv', async () => {
    // 36K 字符:默认伙伴(Bot profile context + teammate guide + 记忆索引)量级,
    // 内联时估算长度已越过 Windows 预算。
    const hugePrompt = '-- 伙伴上下文 --\n'.repeat(3_000);
    const handle = await new PiAgent(buildDeps()).startSession({
      sessionId: 'spill-large',
      workingDir: cwd,
      model: 'm',
      botProfilePrompt: hugePrompt,
    });
    try {
      const { value } = appendPromptValue();
      expect(value).toBeTruthy();
      expect(knobs.spawnArgs.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
      // argv 里只剩路径:整段提示词不再出现。
      expect(value).not.toContain('伙伴上下文');
      expect(path.resolve(value!)).toBe(path.resolve(knobs.configHome, SPILL_FILE_NAME));
      // 与内联时同源:Bot profile 段经过 trim,落盘内容逐字节等于它。
      expect(readFileSync(value!, 'utf8')).toBe(hugePrompt.trim());
      // 修复后的命令行通过 Windows 预算守卫。
      expect(() => assertPiSpawnArgvFitsPlatform(knobs.spawnArgs, 'win32')).not.toThrow();
      // 旧行为(内联同一提示词)会被守卫拦下,说明该用例确实处在危险区。
      const inlineArgs = knobs.spawnArgs.map((arg) => (arg === value ? hugePrompt : arg));
      expect(() => assertPiSpawnArgvFitsPlatform(inlineArgs, 'win32')).toThrow();
    } finally {
      await handle.close();
    }
    await vi.waitFor(() => expect(existsSync(path.join(knobs.configHome, SPILL_FILE_NAME))).toBe(false));
  });

  it('keeps a small prompt inline without creating a spill file', async () => {
    const handle = await new PiAgent(buildDeps()).startSession({
      sessionId: 'spill-small',
      workingDir: cwd,
      model: 'm',
      botProfilePrompt: 'You are Cindy.',
    });
    try {
      const { value } = appendPromptValue();
      expect(value).toBe('You are Cindy.');
      expect(existsSync(path.join(knobs.configHome, SPILL_FILE_NAME))).toBe(false);
    } finally {
      await handle.close();
    }
  });
});
