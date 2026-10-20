import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detect, isMissingOrEmptyTextFile, isNonEmptyTextFile } from '../detector.js';
import { claudeReadsAgentsMd } from '../native-instructions.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-detect-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('isMissingOrEmptyTextFile / isNonEmptyTextFile', () => {
  it('missing file → missing=true, nonEmpty=false', async () => {
    const p = path.join(tmpDir, 'gone.md');
    expect(await isMissingOrEmptyTextFile(p)).toBe(true);
    expect(await isNonEmptyTextFile(p)).toBe(false);
  });

  it('empty file → missing=true, nonEmpty=false', async () => {
    const p = path.join(tmpDir, 'empty.md');
    await fs.writeFile(p, '   \n  \t  \n');
    expect(await isMissingOrEmptyTextFile(p)).toBe(true);
    expect(await isNonEmptyTextFile(p)).toBe(false);
  });

  it('non-empty file → missing=false, nonEmpty=true', async () => {
    const p = path.join(tmpDir, 'real.md');
    await fs.writeFile(p, '# title');
    expect(await isMissingOrEmptyTextFile(p)).toBe(false);
    expect(await isNonEmptyTextFile(p)).toBe(true);
  });
});

describe('detect — agents-md kind', () => {
  // Regression: native AGENTS.md support must remove only the redundant forward
  // conversion, not unrelated migration work. Existing tests cover file presence only.
  // Production entry: detect; minimal input: AGENTS.md + a native-reading runtime; unit.
  it('keeps other migrations when the runtime already reads AGENTS.md', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# agents');
    await fs.mkdir(path.join(tmpDir, '.codex', 'hooks'), { recursive: true });
    const result = await detect({ workingDir: tmpDir, agentKind: 'claude-code', readsAgentsMd: true });
    expect(result.items.map((item) => item.kind)).toEqual(['hooks']);
  });

  it('native AGENTS.md support does not suppress CLAUDE.md to AGENTS.md', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '# claude');
    const result = await detect({ workingDir: tmpDir, agentKind: 'codex', readsAgentsMd: true });
    expect(result.items.map((item) => item.kind)).toEqual(['agents-md']);
  });
  it('claude-code session: AGENTS.md non-empty + CLAUDE.md missing → 1 item to-claude', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# agents');
    const r = await detect({ workingDir: tmpDir, agentKind: 'claude-code' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      kind: 'agents-md',
      direction: 'to-claude',
      label: 'AGENTS.md → CLAUDE.md',
    });
  });

  it('codex session: CLAUDE.md non-empty + AGENTS.md missing → 1 item to-codex', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '# claude');
    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'agents-md', direction: 'to-codex' });
  });

  it('双端齐全 → 0 items（不打扰）', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '# x');
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# y');
    expect((await detect({ workingDir: tmpDir, agentKind: 'claude-code' })).items).toHaveLength(0);
    expect((await detect({ workingDir: tmpDir, agentKind: 'codex' })).items).toHaveLength(0);
  });

  it('双端皆无 → 0 items', async () => {
    expect((await detect({ workingDir: tmpDir, agentKind: 'claude-code' })).items).toHaveLength(0);
    expect((await detect({ workingDir: tmpDir, agentKind: 'codex' })).items).toHaveLength(0);
  });

  it('AGENTS.md 是空文件，对 claude session 来说 source 不算"有内容" → 0 items', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '   \n');
    expect((await detect({ workingDir: tmpDir, agentKind: 'claude-code' })).items).toHaveLength(0);
  });

  it('CLAUDE.md 是空文件 + AGENTS.md 非空 → 仍然推（codex 语义：目标 trim 为空算缺失）', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '\n  ');
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# real');
    const r = await detect({ workingDir: tmpDir, agentKind: 'claude-code' });
    expect(r.items).toHaveLength(1);
  });

  it('empty workingDir → 0 items', async () => {
    expect((await detect({ workingDir: '', agentKind: 'claude-code' })).items).toHaveLength(0);
  });
});

// Production capability resolver. The former file-only detector had no version,
// disable-setting or fallback checks; an unknown/disabled runtime must keep the
// suggestion. All inputs and files here are isolated (unit tier, no CLI/network).
describe('native instruction capability', () => {
  const check = (overrides: Partial<Parameters<typeof claudeReadsAgentsMd>[0]> = {}) => claudeReadsAgentsMd({
    version: '2.1.296', workingDir: tmpDir,
    userSettingsPath: path.join(tmpDir, 'user-settings.json'), env: {},
    managedPolicyPresent: false, instructionRoot: tmpDir, ...overrides,
  });

  it.each([null, 'unknown', '2.1.276', '2.1.277', '2.1.280', '2.1.281-beta.1'])('keeps the suggestion for unproven version %s', async (version) => {
    expect(await check({ version })).toBe(false);
  });

  it('recognizes a native-reading release without depending on a model', async () => {
    expect(await check({ version: '2.1.281' })).toBe(true);
  });

  it.each([
    { enabledPlugins: { 'cc-plugin-agents-md@builtin': false } },
    { enabledPlugins: { 'agents-md@builtin': false } },
    { pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md' } } } },
    { pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'managed-only' } } } },
    { pluginConfigs: { 'agents-md@builtin': { options: { projectInstructions: 'claude' } } } },
    { pluginConfigs: { 'agents-md@builtin': { options: { projectInstructions: 'unknown' } } } },
    { claudeMdExcludes: ['**/AGENTS.md'] },
    { permissions: { deny: ['Read(./AGENTS.md)'] } },
    { env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } },
    { env: { CLAUDE_CODE_SAFE_MODE: '1' } },
    { env: { CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/alternate-policy.json' } },
  ])('does not claim native loading for disabled or unproven settings %j', async (settings) => {
    await fs.writeFile(path.join(tmpDir, 'user-settings.json'), JSON.stringify(settings));
    expect(await check()).toBe(false);
  });

  it('rereads settings and honors both mode while project plugin options are ignored', async () => {
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.local.md'), '# local');
    expect(await check()).toBe(false);
    await fs.writeFile(path.join(tmpDir, 'user-settings.json'), JSON.stringify({
      pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'claude-md-and-agents-md', projectInstructions: 'none' } } },
    }));
    await fs.mkdir(path.join(tmpDir, '.claude'));
    await fs.writeFile(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
      pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md' } } },
    }));
    expect(await check()).toBe(true);
    expect(await check({ version: '2.1.281' })).toBe(false); // New plugin ID was not recognized yet.
    await fs.writeFile(path.join(tmpDir, 'user-settings.json'), JSON.stringify({
      pluginConfigs: {
        'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'claude-md-or-agents-md' } },
        'agents-md@builtin': { options: { instructionFiles: 'claude-md-and-agents-md' } },
      },
    }));
    expect(await check()).toBe(false); // Conflicting aliases must not claim "load both".
    await fs.writeFile(path.join(tmpDir, 'user-settings.json'), '{bad json');
    expect(await check()).toBe(false);
  });

  it('keeps detection for environment opt-outs and unresolved managed policy', async () => {
    expect(await check({ env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } })).toBe(false);
    expect(await check({ managedPolicyPresent: true })).toBe(false);
    expect(await check({ env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' } })).toBe(true);
  });
});

describe('detect — shared skills', () => {
  it('does not offer conversion for a Claude project skill', async () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'a');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: a\ndescription: a\n---\n');

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });

    expect(r.items).toEqual([]);
  });

  it('does not offer conversion for a shared Codex project skill', async () => {
    const skillDir = path.join(tmpDir, '.agents', 'skills', 'a');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: a\ndescription: a\n---\n');

    const r = await detect({ workingDir: tmpDir, agentKind: 'claude-code' });

    expect(r.items).toEqual([]);
  });

  it('target skill is a directory symlink → no skills item', async () => {
    const claudeSkill = path.join(tmpDir, '.claude', 'skills', 'a');
    const agentsSkills = path.join(tmpDir, '.agents', 'skills');
    await fs.mkdir(claudeSkill, { recursive: true });
    await fs.mkdir(agentsSkills, { recursive: true });
    await fs.symlink(
      claudeSkill,
      path.join(agentsSkills, 'a'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    expect(r.items).toEqual([]);
  });
});

describe('detect — agents', () => {
  it('to-codex: .claude/agents/foo.md → 1 sub item', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.claude', 'agents', 'foo.md'), '---\nname: foo\n---\nbody');
    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    const agents = r.items.find((i) => i.kind === 'agents');
    expect(agents).toBeDefined();
    expect(agents!.subItems).toHaveLength(1);
    expect(agents!.subItems![0].targetPath).toMatch(/\.codex[\\/]agents[\\/]foo\.toml$/);
  });

  it('to-codex: 普通 Markdown 不应被误报为可迁移 agent', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.claude', 'agents', 'codebase-explorer.md'),
      '# 代码库探索代理',
    );

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });

    expect(r.items.find((i) => i.kind === 'agents')).toBeUndefined();
  });

  it('to-codex: 缺少 name 元数据的 Claude agent 不应被误报', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.claude', 'agents', 'without-name.md'),
      '---\ndescription: only description\n---\nbody',
    );

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });

    expect(r.items.find((i) => i.kind === 'agents')).toBeUndefined();
  });

  it('to-codex: name 不是字符串的 Claude agent 不应被误报', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.claude', 'agents', 'numeric-name.md'),
      '---\nname: 1\n---\nbody',
    );

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });

    expect(r.items.find((i) => i.kind === 'agents')).toBeUndefined();
  });

  it('to-codex: name 只有空白的 Claude agent 不应被误报', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.claude', 'agents', 'blank-name.md'),
      '---\nname: "   "\n---\nbody',
    );

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });

    expect(r.items.find((i) => i.kind === 'agents')).toBeUndefined();
  });

  it('to-codex: frontmatter YAML 无法解析的 Claude agent 不应被误报', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.claude', 'agents', 'invalid-frontmatter.md'),
      '---\nname: [unterminated\n---\nbody',
    );

    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });

    expect(r.items.find((i) => i.kind === 'agents')).toBeUndefined();
  });
});

describe('detect — mcp', () => {
  it('to-codex: .mcp.json with mcpServers + no codex config.toml → 1 mcp item', async () => {
    await fs.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'a' } } }));
    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    expect(r.items.find((i) => i.kind === 'mcp')).toBeDefined();
  });

  it('to-codex: target config.toml already has [mcp_servers] → 0 mcp item (detector level skip)', async () => {
    await fs.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'a' } } }));
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.codex', 'config.toml'), '[mcp_servers.existing]\ncommand = "y"\n');
    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    expect(r.items.find((i) => i.kind === 'mcp')).toBeUndefined();
  });
});

describe('detect — hooks', () => {
  it('to-codex: claude has hooks dir + settings.json hooks → 1 hooks item', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.claude', 'hooks', 'p.sh'), 'x');
    await fs.writeFile(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    expect(r.items.find((i) => i.kind === 'hooks')).toBeDefined();
  });

  it('双端齐全 → 0 hooks item', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    await fs.mkdir(path.join(tmpDir, '.codex', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.codex', 'hooks.json'), '{}');
    const r = await detect({ workingDir: tmpDir, agentKind: 'codex' });
    expect(r.items.find((i) => i.kind === 'hooks')).toBeUndefined();
  });
});
