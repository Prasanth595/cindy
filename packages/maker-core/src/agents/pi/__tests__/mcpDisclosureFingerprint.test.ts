import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

// 只取 mcpGatewayKey / recordInput / CindyMcpGateway 这段源码，在 VM 里用桩件驱动：
// 披露按 schema 指纹判定、schema 变更自动失效、按会话落盘重载、自愈放行。
const source = CINDY_BRIDGE_EXTENSION_SOURCE;
const sliceStart = source.indexOf('function mcpGatewayKey(');
const classStart = source.indexOf('class CindyMcpGateway {');
const classEnd = source.indexOf('\n}\n', classStart) + 3;
if (sliceStart < 0 || classStart < sliceStart || classEnd <= classStart) {
  throw new Error('CindyMcpGateway slice not found in bridge source');
}

type DisclosedFile = { version: number; entries: Record<string, string> };

function loadGateway(options: { stored?: DisclosedFile | null; writeFails?: boolean } = {}) {
  const writes: DisclosedFile[] = [];
  const runtimeDir = '/runtime';
  const code = ts.transpileModule(
    `${source.slice(sliceStart, classEnd)}\n(globalThis as any).CindyMcpGateway = CindyMcpGateway;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const sandbox: Record<string, unknown> = {
    console: { warn: () => undefined },
    process: {
      env: {
        CINDY_PI_PERMISSION_FILE: `${runtimeDir}/perm-s1.json`,
        CINDY_PI_SESSION_ID: 's1',
      },
    },
    path: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (file: string) => file.slice(0, file.lastIndexOf('/')),
    },
    readFileSync: () => {
      if (options.stored === undefined || options.stored === null) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return JSON.stringify(options.stored);
    },
    writeFileSync: (_file: string, body: string) => {
      if (options.writeFails) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      writes.push(JSON.parse(body) as DisclosedFile);
    },
    createHash,
    CINDY_DIRECT_BOT_TOOLS: new Set<string>(),
  };
  runInNewContext(code, sandbox);
  const Gateway = sandbox.CindyMcpGateway as new () => {
    add(server: string, client: unknown, tools: unknown[]): void;
    resolveCall(input: unknown): { tool: { name: string; description: string; inputSchema: unknown } } | null;
    isSchemaDisclosed(call: unknown): boolean;
    markSchemaDisclosed(call: unknown): boolean;
  };
  const gateway = new Gateway();
  return { gateway, writes };
}

const TOOL = {
  name: 'send_to_worker',
  description: '向指定 worker 投递消息',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
};
const TOOL_CHANGED = { ...TOOL, description: '向指定 worker 投递消息（v2）' };

function seed(gateway: ReturnType<typeof loadGateway>['gateway'], tool: unknown = TOOL) {
  gateway.add('cindy_orca', {}, [tool]);
  const resolved = gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' });
  if (!resolved) throw new Error('tool did not resolve');
  return resolved;
}

describe('MCP gateway schema disclosure', () => {
  it('blocks an undisclosed tool, then self-heals once and records the schema fingerprint', () => {
    const { gateway, writes } = loadGateway();
    const call = seed(gateway);

    expect(gateway.isSchemaDisclosed(call)).toBe(false);
    expect(gateway.markSchemaDisclosed(call)).toBe(true);
    expect(gateway.isSchemaDisclosed(call)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].version).toBe(1);
    expect(Object.keys(writes[0].entries)).toEqual(['cindy_orca\u0000send_to_worker']);
    // 幂等：同 schema 再记不重复落盘。
    expect(gateway.markSchemaDisclosed(call)).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it('reuses a persisted disclosure when the schema is unchanged (pi upgrade must not invalidate)', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([TOOL.name, TOOL.description, TOOL.inputSchema]))
      .digest('hex');
    const { gateway, writes } = loadGateway({
      stored: { version: 1, entries: { 'cindy_orca\u0000send_to_worker': fingerprint } },
    });

    const call = seed(gateway);
    expect(gateway.isSchemaDisclosed(call)).toBe(true);
    expect(gateway.markSchemaDisclosed(call)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('re-arms the gate when the tool schema actually changes', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([TOOL.name, TOOL.description, TOOL.inputSchema]))
      .digest('hex');
    const { gateway } = loadGateway({
      stored: { version: 1, entries: { 'cindy_orca\u0000send_to_worker': fingerprint } },
    });

    const changed = seed(gateway, TOOL_CHANGED);
    expect(gateway.isSchemaDisclosed(changed)).toBe(false);
  });

  it('treats a missing or corrupt disclosure file as undisclosed (fail-closed)', () => {
    for (const stored of [null, { version: 1, entries: { 'cindy_orca\u0000send_to_worker': 'not-a-hash' } }]) {
      const { gateway } = loadGateway({ stored: stored as DisclosedFile | null });
      expect(gateway.isSchemaDisclosed(seed(gateway))).toBe(false);
    }
  });

  it('keeps the in-memory gate working when the disclosure file cannot be written', () => {
    const { gateway, writes } = loadGateway({ writeFails: true });
    const call = seed(gateway);
    expect(gateway.markSchemaDisclosed(call)).toBe(true);
    expect(gateway.isSchemaDisclosed(call)).toBe(true);
    expect(writes).toHaveLength(0);
  });
});