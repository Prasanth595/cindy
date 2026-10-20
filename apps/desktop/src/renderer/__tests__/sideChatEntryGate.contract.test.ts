/**
 * 侧聊入口门槛契约（guard tier）。
 *
 * 普通单测不得读取源码文本（test-hygiene sourceReads 规则），纯跨文件契约
 * 按规则放入 guard tier（scripts/test-workspaces.config.mjs 的
 * desktopGuardInclude）。本文件断言 CCAgentSessionView 的两处侧聊入口
 * （选区气泡 onAskInSideChat 与 /side 命令处理器）一律走权威门槛
 * canOpenSideChat，不再出现第三份松散的本地条件副本。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../features/cc-agent/CCAgentSessionView.tsx',
  ),
  'utf8',
);

describe('side-chat entry gate consistency (selection pill + /side)', () => {
  it('gates both side-chat entries with the authoritative canOpenSideChat check', () => {
    expect(source).toContain(
      'onAskInSideChat={!readOnly && canNavigateSession && sessionId && canOpenSideChat(session)',
    );
    expect(source).toMatch(
      /payload\.command === 'side'[\s\S]{0,200}!canOpenSideChat\(session\)/,
    );
    // 旧的松散条件（漏 review 来源与共享任务访客）不得再出现。
    expect(source).not.toContain("session?.source !== 'side-chat' && session?.source !== 'bot'");
  });
});
