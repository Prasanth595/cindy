import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentDeps } from '@cindy/maker-core';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';
import { replaceFile } from '../utils/replaceFile.js';

export const COMMAND_RULE_ENGINE = '0.145.0';
type Evaluation = Awaited<ReturnType<NonNullable<AgentDeps['evaluatePiCommandRules']>>>;
type Request = Parameters<NonNullable<AgentDeps['evaluatePiCommandRules']>>[0];
export type NativeRuleRunner = (request: Record<string, unknown>) => Promise<unknown>;
interface RuleFile { sourceId: string; text: string }
interface Source {
  schemaVersion: 1;
  engineVersion: string;
  codexHome: string;
  cwd: string;
  layers: Array<{ sourceId: string; version: string; enabled: boolean; kind: string }>;
  files: RuleFile[];
}
interface Package {
  schemaVersion: 1;
  format: 'codex-execpolicy-starlark';
  engineVersion: string;
  sourceDomain: 'codex-native-execpolicy';
  targetDomain: 'cindy-pi-auto-command-approval';
  scope: { owner: string; hostId: string; cwd: string; codexHome: string };
  revision: string;
  sourceDigest: string;
  source: Source;
  files: Array<RuleFile & { order: number; sha256: string }>;
  /** Retained even after a user removes the imported policy. */
  deleted?: boolean;
  pendingSourceDigest?: string;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protocol = { schemaVersion: 1, engineVersion: COMMAND_RULE_ENGINE } as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RULES_PROTOCOL_ERROR');
  return value as Record<string, unknown>;
}
function source(value: unknown): Source {
  const v = object(value);
  if (v.error) throw new Error(typeof v.error === 'string' ? v.error : 'RULES_PROTOCOL_ERROR');
  if (v.schemaVersion !== 1 || v.engineVersion !== COMMAND_RULE_ENGINE
    || typeof v.cwd !== 'string' || typeof v.codexHome !== 'string'
    || !Array.isArray(v.files) || !Array.isArray(v.layers)
    || !v.files.every((f) => typeof f?.sourceId === 'string' && typeof f?.text === 'string')
    || !v.layers.every((l) => typeof l?.sourceId === 'string' && typeof l?.version === 'string'
      && typeof l?.enabled === 'boolean' && typeof l?.kind === 'string')) throw new Error('RULES_PROTOCOL_ERROR');
  return v as unknown as Source;
}

/** Dependencies keep tests away from real homes and account state. */
export interface CommandRulesOptions {
  ownerScope(): string | null;
  storageDirectory(): string;
  /** Native effective home first, optional external fallback; never union policies. */
  sourceHomes(request: Request): Promise<string[]>;
  runner(request: Request): Promise<NativeRuleRunner>;
}

export function createCommandRulesEvaluator(options: CommandRulesOptions): NonNullable<AgentDeps['evaluatePiCommandRules']> {
  return async (request) => {
    const owner = options.ownerScope();
    const fail = (reason: string): Evaluation => ({ decision: 'error', revision: '', reason, isCurrent: async () => false });
    if (!owner) return fail('RULES_OWNER_UNAVAILABLE');
    const currentOwner = (): void => {
      if (options.ownerScope() !== owner) throw new Error('RULES_OWNER_CHANGED');
    };
    try {
      const run = await options.runner(request);
      const homes = await options.sourceHomes(request);
      if (!homes.length) throw new Error('RULES_SOURCE_UNAVAILABLE');
      const cwd = request.evidence?.cwd ?? request.workingDir;
      const discover = async (): Promise<Source> => {
        let selected: Source | undefined;
        for (const home of homes) {
          const next = source(await run({ operation: 'discover', ...protocol, codexHome: home, cwd }));
          // A native effective project/system rule is just as authoritative as
          // a user rule. Fallback only when the entire native source is empty.
          selected = next;
          if (next.files.length) break;
        }
        if (!selected) throw new Error('RULES_SOURCE_UNAVAILABLE');
        currentOwner();
        return selected;
      };
      const discovered = await discover();
      const scope = { owner, hostId: request.remoteHostId ?? 'local', cwd: discovered.cwd, codexHome: discovered.codexHome };
      const storage = options.storageDirectory();
      // A fallback home can change as source files appear/disappear. Keep the
      // migration identity stable so that change cannot bypass the saved package.
      const filename = path.join(storage, digest({ owner, hostId: scope.hostId, cwd: scope.cwd, homes }) + '.json');
      const sourceDigest = digest(discovered);
      await fs.mkdir(storage, { recursive: true, mode: 0o700 });
      const publish = async (value: Package): Promise<void> => {
        currentOwner();
        const temporary = filename + '.' + randomUUID() + '.tmp';
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
          currentOwner();
          await replaceFile(temporary, filename);
        } finally { await fs.rm(temporary, { force: true }); }
      };
      const readPackage = async (): Promise<Package | null> => {
        try {
          const stat = await fs.stat(filename);
          if (stat.size > 12 * 1024 * 1024) throw new Error('RULES_PACKAGE_TOO_LARGE');
          const p = object(JSON.parse(await fs.readFile(filename, 'utf8')));
          const savedScope = object(p.scope);
          if (p.schemaVersion !== 1 || p.engineVersion !== COMMAND_RULE_ENGINE
            || p.format !== 'codex-execpolicy-starlark'
            || typeof savedScope.codexHome !== 'string'
            || digest({ ...savedScope, codexHome: scope.codexHome }) !== digest(scope)
            || p.sourceDomain !== 'codex-native-execpolicy' || p.targetDomain !== 'cindy-pi-auto-command-approval'
            || (p.deleted !== undefined && typeof p.deleted !== 'boolean')
            || typeof p.sourceDigest !== 'string' || typeof p.revision !== 'string'
            || !Array.isArray(p.files) || !p.files.every((f, order) => typeof f?.sourceId === 'string' && typeof f?.text === 'string'
              && f.order === order && f.sha256 === createHash('sha256').update(f.text).digest('hex'))) {
            throw new Error('RULES_PACKAGE_INVALID');
          }
          currentOwner();
          return p as unknown as Package;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      };
      // An absent source is not a completed migration. The first real rule
      // package can still be imported later; existing packages/tombstones win.
      if (!discovered.files.length && !await readPackage()) {
        return { decision: 'unmatched', revision: digest({ scope, sourceDigest }), isCurrent: async () => {
          try {
            const [now, saved] = await Promise.all([discover(), readPackage()]);
            currentOwner();
            return digest(now) === sourceDigest && saved === null;
          }
          catch { return false; }
        } };
      }
      const snapshot = await withSecurityBoundaryLock(filename + '.lock', { label: 'command rules' }, async (lock) => {
        if (!lock.held) throw new Error('RULES_STORAGE_BUSY');
        currentOwner();
        const existing = await readPackage();
        if (existing) {
          if (existing.sourceDigest !== sourceDigest && !existing.deleted) {
            if (existing.pendingSourceDigest !== sourceDigest) await publish({ ...existing, pendingSourceDigest: sourceDigest });
            throw new Error('RULES_SOURCE_CHANGED');
          }
          return existing;
        }
        const next: Package = {
          ...protocol, format: 'codex-execpolicy-starlark', sourceDomain: 'codex-native-execpolicy',
          targetDomain: 'cindy-pi-auto-command-approval', scope, revision: randomUUID(), sourceDigest,
          source: discovered,
          files: discovered.files.map((f, order) => ({ ...f, order, sha256: createHash('sha256').update(f.text).digest('hex') })),
        };
        await publish(next);
        return next;
      });
      const revision = digest(snapshot);
      const isCurrent = async (): Promise<boolean> => {
        try {
          currentOwner();
          const [now, saved] = await Promise.all([discover(), readPackage()]);
          currentOwner();
          return digest(now) === sourceDigest && saved !== null && digest(saved) === revision;
        } catch { return false; }
      };
      if (snapshot.deleted) return { decision: 'unmatched', revision, isCurrent };
      if (!request.evidence || (request.evidence.script ?? (request.evidence.analysisArgv ?? request.evidence.argv).at(-1)) !== request.command) {
        if (snapshot.files.length) return fail('RULES_COMMAND_EVIDENCE_MISSING');
        return { decision: 'unmatched', revision, isCurrent };
      }
      const result = object(await run({ operation: 'evaluate', ...protocol, revision,
        files: snapshot.files.map(({ sourceId, text }) => ({ sourceId, text })), argv: request.evidence.argv,
        ...(request.evidence.analysisArgv ? { analysisArgv: request.evidence.analysisArgv } : {}) }));
      currentOwner();
      if (result.error) return fail(String(result.error));
      if (result.schemaVersion !== 1 || result.engineVersion !== COMMAND_RULE_ENGINE || result.revision !== revision
        || digest(result.argv) !== digest(request.evidence.argv)
        || !['allow', 'prompt', 'forbidden', 'unmatched'].includes(String(result.decision))) return fail('RULES_PROTOCOL_ERROR');
      return { decision: result.decision as Evaluation['decision'], revision, isCurrent,
        ...(result.decision === 'forbidden' ? { reason: 'Codex .rules: forbidden' } : {}) };
    } catch (error) {
      // Neither native diagnostics nor config/rule contents enter logs or UI.
      const code = error instanceof Error && /^RULES_[A-Z_]+$|^(SOURCE|INVALID|UNSUPPORTED)_[A-Z_]+$/.test(error.message)
        ? error.message : 'RULES_UNAVAILABLE';
      return fail(`命令规则暂不可用（${code}）。请修复规则来源后重试，或回到 Codex 执行。`);
    }
  };
}
