/** Native E2E tier: real Pi + production bridge/dispatcher/store/native helper.
 * Fake model and fake executable only. No approval model, real credentials or
 * source configs. Missing binaries are explicitly skipped, not a passing E2E.
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PiAgent, type AgentDeps } from '@cindy/maker-core';
import { createCommandRulesEvaluator } from '../command-rules';
import { runLocalCommandRules } from '../command-rules-runtime';

const pi = process.env.CINDY_TEST_PI_BINARY ?? '';
const helper = process.env.CINDY_TEST_RULES_BINARY ?? '';
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };

function stream(calls: string[] | null): string {
  const events: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: {
    id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  } }]];
  if (calls) calls.forEach((name, index) => {
    events.push(['content_block_start', { type: 'content_block_start', index,
      content_block: { type: 'tool_use', id: `probe-${name}`, name: 'bash', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `./approval-probe ${name}` }) } }],
    ['content_block_stop', { type: 'content_block_stop', index }]);
  });
  else events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'finished' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

describe.skipIf(!existsSync(pi) || !existsSync(helper) || process.platform === 'win32')('native command rule execution', () => {
  it('enforces trusted project rules before any side effect despite an empty fallback home', { timeout: 30_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-rule-e2e-'));
    const cwd = path.join(root, 'work'); const home = path.join(root, 'codex'); const agentHome = path.join(root, 'pi');
    const externalHome = path.join(root, 'external');
    const projectRules = path.join(cwd, '.codex', 'rules');
    for (const dir of [cwd, home, externalHome, projectRules, path.join(cwd, '.git'), agentHome]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(cwd, '.codex', 'config.toml'), '');
    writeFileSync(path.join(home, 'config.toml'), `[projects.${JSON.stringify(realpathSync(cwd))}]\ntrust_level = "trusted"\n`);
    writeFileSync(path.join(cwd, 'approval-probe'), '#!' + path.posix.join('/', 'bin', 'sh') + '\nprintf executed > "$1.marker"\n', { mode: 0o700 });
    writeFileSync(path.join(projectRules, 'fixture.rules'), [
      'def register(name, decision):', '    prefix_rule(pattern=["./approval-probe", name], decision=decision)',
      'register("allow", "allow")', 'register("ask-allow", "prompt")', 'register("ask-deny", "prompt")',
      'register("forbidden", "forbidden")', '',
    ].join('\n'));
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume(); req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(stream(requests++ === 0 ? ['allow', 'ask-allow', 'ask-deny', 'forbidden', 'unmatched'] : null));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = root; process.env.USERPROFILE = root;
    const reviewer = vi.fn(async () => ({ verdict: 'allow' as const, reason: 'unmatched fixture' }));
    const deps: AgentDeps = {
      auth: { getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' }),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'fake-local-only' }) },
      runtimeConfig: { endpoint: `http://127.0.0.1:${address.port}` }, binaryPath: pi, logger,
      capabilityAdditions: { availableModels: [{ id: 'fixture', displayName: 'Fixture', contextWindow: 32000, efforts: [], defaultEffort: null }] },
      resolvePiAgentHome: () => agentHome, resolvePiGlobalContextHome: () => path.join(root, 'global'),
      resolvePiGatewayModelApi: () => 'anthropic-messages', reviewAutoPermissionAction: reviewer,
      evaluatePiCommandRules: createCommandRulesEvaluator({ ownerScope: () => 'fixture-owner',
        storageDirectory: () => path.join(root, 'packages'), sourceHomes: async () => [home, externalHome],
        runner: async () => (request) => runLocalCommandRules(helper, request) }),
    };
    let handle: Awaited<ReturnType<PiAgent['startSession']>> | undefined;
    try {
    handle = await new PiAgent(deps).startSession({ sessionId: 'native-rules', workingDir: cwd, model: 'fixture', permissionMode: 'auto' });
    const asked: string[] = [];
    handle.setInteractionResolver(async (request) => {
      if (request.kind !== 'permission') throw new Error('Unexpected fixture interaction');
      const command = String(request.input.command);
      asked.push(command);
      expect(existsSync(path.join(cwd, command.split(' ').at(-1)! + '.marker'))).toBe(false);
      return { kind: 'permission', behavior: command.endsWith('ask-allow') ? 'allow' : 'deny' };
    });
      const events: unknown[] = [];
      const done = (async () => { for await (const event of handle.events()) {
        events.push(event); if (event.type === 'done') break;
      } })();
      await handle.send({ type: 'user', content: 'Execute the fixture probes.' });
      await done;
      expect(['allow', 'ask-allow', 'unmatched'].map((n) => existsSync(path.join(cwd, n + '.marker'))), JSON.stringify(events)).toEqual([true, true, true]);
      expect(['ask-deny', 'forbidden'].map((n) => existsSync(path.join(cwd, n + '.marker')))).toEqual([false, false]);
      expect(asked.sort()).toEqual(['./approval-probe ask-allow', './approval-probe ask-deny']);
      expect(reviewer).toHaveBeenCalledOnce();
    } finally {
      await handle?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
