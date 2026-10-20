import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { REMOTE_INSTALL_ROOT, type RemoteHost } from '@cindy/maker-remote-ssh';
import type { AgentDeps } from '@cindy/maker-core';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createCommandRulesEvaluator, type NativeRuleRunner } from './command-rules.js';

const MAX_OUTPUT = 12 * 1024 * 1024;
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
function helperPath(platform = process.platform, arch = process.arch): string {
  const name = platform === 'win32' ? 'cindy-command-rules.exe' : 'cindy-command-rules';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'command-rules', `${platform}-${arch}`, name)
    : path.join(app.getAppPath(), 'resources', 'tools', 'command-rules', `${platform}-${arch}`, name);
}

let runningHelpers = 0;
const helperWaiters: Array<() => void> = [];
export async function runLocalCommandRules(binary: string, request: Record<string, unknown>): Promise<unknown> {
  if (runningHelpers >= 2) await new Promise<void>((resolve) => helperWaiters.push(resolve));
  else runningHelpers++;
  try { return await new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('RULES_PROTOCOL_ERROR')); }
    };
    const timer = setTimeout(() => finish(new Error('RULES_HELPER_TIMEOUT')), 15_000);
    child.once('error', () => finish(new Error('RULES_HELPER_UNAVAILABLE')));
    child.stdin.on('error', () => finish(new Error('RULES_HELPER_UNAVAILABLE')));
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX_OUTPUT) { finish(new Error('RULES_PROTOCOL_ERROR')); return; }
      chunks.push(data);
    });
    child.once('close', (code) => finish(code === 0 ? undefined : new Error('RULES_HELPER_FAILED')));
    child.stdin.end(JSON.stringify(request));
  }); } finally {
    const next = helperWaiters.shift();
    if (next) next(); else runningHelpers--;
  }
}

/** Install the build-time binary on the execution host; no compiler on user machines. */
async function sshRuntime(host: RemoteHost): Promise<{ run: NativeRuleRunner; homes: string[] }> {
  const probe = await host.exec('uname -sm && printf "\\n%s\\n%s\\n" "$HOME" "${CODEX_HOME:-}"',
    { timeoutMs: 10_000, maxOutputBytes: 8192, label: 'command rules platform' });
  if (probe.exitCode !== 0 || probe.truncated) throw new Error('RULES_EXECUTION_HOST_UNAVAILABLE');
  const [machine, , home, override] = probe.stdout.trimEnd().split('\n');
  const platform = machine?.startsWith('Darwin ') ? 'darwin' : machine?.startsWith('Linux ') ? 'linux' : null;
  const arch = /(?:arm64|aarch64)$/.test(machine ?? '') ? 'arm64' : /(?:x86_64|amd64)$/.test(machine ?? '') ? 'x64' : null;
  if (!platform || !arch || !home?.startsWith('/')) throw new Error('RULES_EXECUTION_PLATFORM_UNSUPPORTED');
  const binary = await fs.readFile(helperPath(platform, arch));
  const hash = createHash('sha256').update(binary).digest('hex');
  const installRoot = REMOTE_INSTALL_ROOT.replace('$HOME', home);
  const folder = `${installRoot}/command-rules/${hash}`;
  const destination = `${folder}/cindy-command-rules`;
  const checkScript = `test -x ${quote(destination)} && (sha256sum ${quote(destination)} 2>/dev/null || shasum -a 256 ${quote(destination)})`;
  const checked = await host.exec(checkScript, { timeoutMs: 10_000, maxOutputBytes: 8192, label: 'command rules integrity' });
  if (checked.exitCode !== 0 || checked.stdout.split(/\s/)[0] !== hash) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const uploaded = await host.exec(`umask 077; mkdir -p ${quote(folder)} && cat > ${quote(temporary)} && chmod 700 ${quote(temporary)} && mv ${quote(temporary)} ${quote(destination)}`,
      { input: binary, timeoutMs: 30_000, maxOutputBytes: 8192, label: 'command rules provision' });
    if (uploaded.exitCode !== 0) throw new Error('RULES_HELPER_PROVISION_FAILED');
    const verified = await host.exec(checkScript, { timeoutMs: 10_000, maxOutputBytes: 8192, label: 'command rules integrity' });
    if (verified.exitCode !== 0 || verified.stdout.split(/\s/)[0] !== hash) throw new Error('RULES_HELPER_INTEGRITY_FAILED');
  }
  return {
    homes: override ? [override] : [`${installRoot}/codex-home`, `${home}/.codex`],
    run: async (request) => {
      const result = await host.exec(quote(destination), { input: JSON.stringify(request),
        timeoutMs: 15_000, maxOutputBytes: MAX_OUTPUT, label: 'native command rules' });
      if (result.exitCode !== 0 || result.truncated) throw new Error('RULES_HELPER_FAILED');
      return JSON.parse(result.stdout);
    },
  };
}

export function desktopCommandRulesEvaluator(
  getRemoteHost?: (id: string) => RemoteHost | undefined,
): NonNullable<AgentDeps['evaluatePiCommandRules']> {
  const runtimeOwner = activeOwnerScopeKey();
  return async (request) => {
    const owner = activeOwnerScopeKey();
    const directory = ownerScopedUserDataPath('command-approval-rules');
    const ownerId = getActiveAppSession().dataOwnerId;
    try {
      if (owner !== runtimeOwner || isAppSessionBoundaryPending()) throw new Error('RULES_OWNER_CHANGED');
      let runtime: { run: NativeRuleRunner; homes: string[] };
      if (request.remoteHostId) {
        const host = getRemoteHost?.(request.remoteHostId);
        if (!host) throw new Error('RULES_EXECUTION_HOST_UNAVAILABLE');
        runtime = await sshRuntime(host);
      } else {
        const override = process.env.CODEX_HOME;
        runtime = {
          homes: override ? [path.resolve(override)] : [path.join(app.getPath('userData'), 'codex-home'), path.join(os.homedir(), '.codex')],
          run: (value) => runLocalCommandRules(helperPath(), value),
        };
      }
      return createCommandRulesEvaluator({
        ownerScope: () => ownerId && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner ? ownerId : null,
        storageDirectory: () => directory,
        sourceHomes: async () => runtime.homes,
        runner: async () => runtime.run,
      })(request);
    } catch {
      return { decision: 'error', revision: '', reason: '命令规则组件暂不可用，请重试或回到 Codex 执行。', isCurrent: async () => false };
    }
  };
}
