import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

// 把 CindyMcpGateway 从 bridge 源码里切出来，在 VM 中用桩件驱动。断言都走真实入口
// （register 后的 cindy_mcp_call_tool），不直接调内部方法：披露门、自愈放行、MCP
// 请求次数、落盘与重载都在同一条路径上被验证。
const source = CINDY_BRIDGE_EXTENSION_SOURCE;
// 从工具名常量切到 CindyMcpGateway 类结束：register() 用到的常量与 helper 都在这段里，
// 因此 register 后的 cindy_mcp_call_tool 走的是与生产同一条代码路径。
const sliceStart = source.indexOf("const CINDY_MCP_LIST_TOOLS = 'cindy_mcp_list_tools'");
const classStart = source.indexOf('class CindyMcpGateway {');
const classEnd = source.indexOf('\n}\n', classStart) + 3;
if (sliceStart < 0 || classStart < sliceStart || classEnd <= classStart) {
  throw new Error('CindyMcpGateway slice not found in bridge source');
}
const GATEWAY_SOURCE = source.slice(sliceStart, classEnd);

type DisclosedFile = { version: number; entries: Record<string, string> };
type ToolDescriptor = { name: string; description?: string; inputSchema?: unknown };

const TOOL: ToolDescriptor = {
  name: 'send_to_worker',
  description: '向指定 worker 投递消息',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
};
const TOOL_CHANGED: ToolDescriptor = { ...TOOL, description: '向指定 worker 投递消息（v2）' };

function fingerprint(tool: ToolDescriptor): string {
  const description = typeof tool.description === 'string' && tool.description.length > 0
    ? tool.description
    : 'MCP tool ' + tool.name + ' from cindy_orca';
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {}, additionalProperties: true };
  return createHash('sha256').update(JSON.stringify([tool.name, description, inputSchema])).digest('hex');
}

function loadGateway(options: {
  stored?: DisclosedFile | null;
  writeFails?: boolean;
  /** 磁盘上已有内容（用于多实例合并场景），优先于 stored。 */
  onDisk?: DisclosedFile | null;
} = {}) {
  const writes: DisclosedFile[] = [];
  const renames: string[] = [];
  const warnings: string[] = [];
  const requests: unknown[] = [];
  const disk: { value: DisclosedFile | null } = { value: options.onDisk ?? options.stored ?? null };
  let lockTaken = false;

  const code = ts.transpileModule(
    `${GATEWAY_SOURCE}\n(globalThis as any).CindyMcpGateway = CindyMcpGateway;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  const sandbox: Record<string, unknown> = {
    console: { warn: (line: string) => warnings.push(line) },
    process: {
      pid: 4242,
      env: {
        CINDY_PI_PERMISSION_FILE: '/runtime/perm-s1.json',
        CINDY_PI_SESSION_ID: 's1',
      },
    },
    path: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (file: string) => file.slice(0, file.lastIndexOf('/')),
    },
    readFileSync: (file: string) => {
      if (file.endsWith('.lock')) {
        if (lockTaken) throw Object.assign(new Error('locked'), { code: 'EEXIST' });
        return '';
      }
      if (disk.value === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify(disk.value);
    },
    writeFileSync: (file: string, body: string) => {
      if (options.writeFails) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (file.endsWith('.tmp')) {
        disk.value = JSON.parse(body) as DisclosedFile;
        writes.push(disk.value);
        return;
      }
      if (file.endsWith('.lock')) {
        lockTaken = true;
        return;
      }
      disk.value = JSON.parse(body) as DisclosedFile;
      writes.push(disk.value);
    },
    renameSync: (from: string, to: string) => { renames.push(`${from} -> ${to}`); },
    rmSync: () => { lockTaken = false; },
    openSync: () => 7,
    closeSync: () => undefined,
    createHash,
    fetch: async (_url: string, init: { body: string } & Record<string, unknown>) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'delivered' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    Response: globalThis.Response,
    URL,
    Headers,
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(code, sandbox);

  const Gateway = sandbox.CindyMcpGateway as new () => {
    add(server: string, client: unknown, tools: ToolDescriptor[]): void;
    register(pi: unknown, options?: unknown): void;
    resolveCall(input: unknown): unknown;
  };
  const gateway = new Gateway();

  // executeResolvedCall 走 tool.client.request；用最小 client 桩替代 HTTP 层，
  // 每次真实调用都会在 requests 里留下一条，正好用来断言“恰好执行一次”。
  const httpClient = {
    request: async (_method: string, params: { name: string; arguments: unknown }) => {
      requests.push(params);
      return { content: [{ type: 'text', text: 'delivered' }] };
    },
  };
  gateway.add('cindy_orca', httpClient, [TOOL]);

  const registered: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] = [];
  gateway.register({ registerTool: (tool: { name: string; execute: unknown }) => registered.push(tool as never) });
  const callTool = registered.find((t) => t.name === 'cindy_mcp_call_tool');
  const listTools = registered.find((t) => t.name === 'cindy_mcp_list_tools');
  if (!callTool || !listTools) throw new Error('gateway tools not registered');

  return {
    gateway,
    httpClient,
    writes,
    renames,
    warnings,
    requests,
    disk,
    call: (args: Record<string, unknown> = { message: 'hi' }) =>
      callTool.execute('call-1', { server: 'cindy_orca', tool: 'send_to_worker', args }),
    list: () => listTools.execute('list-1', { server: 'cindy_orca', tool: 'send_to_worker' }),
  };
}

describe('MCP gateway schema disclosure', () => {
  it('self-heals an uninspected first call: executes exactly once and records the fingerprint', async () => {
    const { gateway, call, requests, warnings, writes, disk } = loadGateway();
    const resolved = gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }) as { tool: unknown };
    // 事前未披露
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(resolved)).toBe(false);

    const result = await call();

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'delivered' }] });
    expect(warnings.some((line) => line.includes('gateway tool auto-disclosed on first call'))).toBe(true);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
    expect(writes).toHaveLength(1);
    // 事后已披露，第二次调用不再记录
    await call();
    expect(requests).toHaveLength(2);
    expect(writes).toHaveLength(1);
  });

  it('reuses a persisted disclosure after a reload when the schema is unchanged', async () => {
    const stored: DisclosedFile = {
      version: 1,
      entries: { 'cindy_orca\u0000send_to_worker': fingerprint(TOOL) },
    };
    const { gateway, call, requests, warnings, writes } = loadGateway({ stored });

    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
    await call();

    expect(requests).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('re-arms the gate and self-heals again when the tool schema actually changes', async () => {
    const stored: DisclosedFile = {
      version: 1,
      entries: { 'cindy_orca\u0000send_to_worker': fingerprint(TOOL) },
    };
    const { gateway, httpClient, call, requests, warnings, disk } = loadGateway({ stored });

    // 同一会话内工具描述变化（MCP 重连后拿到新 schema）
    gateway.add('cindy_orca', httpClient, [TOOL_CHANGED]);
    const changed = gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }) as { tool: unknown };
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(changed)).toBe(false);

    await call();
    expect(requests).toHaveLength(1);
    expect(warnings.some((line) => line.includes('auto-disclosed on first call'))).toBe(true);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL_CHANGED));
  });

  it('merges another instance record instead of overwriting it', async () => {
    const otherKey = 'cindy_other\u0000other_tool';
    const otherFingerprint = fingerprint({ name: 'other_tool', description: '别的工具' });
    const onDisk: DisclosedFile = { version: 1, entries: { [otherKey]: otherFingerprint } };
    const { call, disk, renames } = loadGateway({ onDisk });

    await call();

    expect(disk.value?.entries[otherKey]).toBe(otherFingerprint);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
    // 原子替换：先写 tmp 再 rename
    expect(renames).toHaveLength(1);
    expect(renames[0]).toContain('.tmp');
  });

  it('treats a missing or corrupt disclosure file as undisclosed and still executes', async () => {
    for (const stored of [
      null,
      { version: 1, entries: { 'cindy_orca\u0000send_to_worker': 'not-a-hash' } },
    ] as (DisclosedFile | null)[]) {
      const { gateway, call, requests } = loadGateway({ stored });
      expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
        .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(false);
      await call();
      expect(requests).toHaveLength(1);
    }
  });

  it('keeps the in-memory gate working when the disclosure file cannot be written', async () => {
    const { gateway, call, requests, writes } = loadGateway({ writeFails: true });
    await call();
    expect(requests).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
  });

  it('records disclosure through cindy_mcp_list_tools too', async () => {
    const { gateway, list, requests, disk } = loadGateway();
    await list();
    expect(requests).toHaveLength(0);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
  });
});