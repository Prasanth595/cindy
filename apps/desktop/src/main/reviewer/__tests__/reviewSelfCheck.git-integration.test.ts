import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ resolveScope: vi.fn(), captured: null as unknown }));
vi.mock('electron-store', () => ({ default: class {} }));
// This fixture is local-only; no SSH transport or agent process is started.
vi.mock('../../git-review/sshReviewBackend.js', () => ({
  withSessionReviewExecution: (_id: string, task: () => unknown) => task(),
  createSshPreviewReaderDeps: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: { select: () => ({ from: () => ({ where: () => ({
    orderBy: () => ({ limit: async () => [] }), limit: async () => [],
  }) }) }) } }),
}));
vi.mock('../../turn-change-set/store.js', () => ({
  listTurnChangeSets: async () => runtime.captured ? [runtime.captured] : [],
  getTurnChangeSets: async () => runtime.captured ? [runtime.captured] : [],
}));
vi.mock('../../git-review/ipc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git-review/ipc.js')>();
  const { readStatus } = await import('../../git-review/statusReader.js');
  const { readDiffs } = await import('../../git-review/diffReader.js');
  return {
    ...actual,
    readReviewData: (id: string) => actual.readReviewData(id, {
      resolveScope: runtime.resolveScope, readStatus, readDiffs, isSessionRunning: () => false,
    }),
    readReviewBranchDiff: (id: string, base: string | null) => actual.readReviewBranchDiff(id, base, {
      resolveScope: runtime.resolveScope,
    }),
  };
});

import { readGitHead } from '../../git-context/headReader.js';
import { collectTouchedDirs, resolveSessionGitDir } from '../../git-context/sessionDirResolver.js';
import { runGit } from '../../git-review/gitRunner.js';
import { resolveReviewScope, withSessionReviewWorkspace } from '../../git-review/scopeResolver.js';
import { loadReviewEvidence, reviewWorkspaceFingerprintIsCurrent } from '../reviewEvidence.js';
import { usableReviewChangeSet } from '../reviewEvidenceSafety.js';
import {
  additionalReviewRepositoriesAreCurrent,
  loadAdditionalReviewRepositories,
} from '../reviewAdditionalRepositories.js';
import { buildReviewPrompt } from '../reviewPrompt.js';
import type { TurnChangeSetDetail } from '../../../shared/turnChangeSet.js';

let fixtureRoot: string | null = null;
afterEach(async () => {
  runtime.captured = null;
  vi.clearAllMocks();
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});

it('reviews real committed and dirty code in the Bash worktree despite an empty partial turn capture', async () => {
  fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-self-review-')));
  const main = path.join(fixtureRoot, 'main');
  const actual = path.join(fixtureRoot, 'actual');
  await fs.mkdir(main);
  const git = (args: string[], cwd = main) => runGit(args, { cwd });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Review Test']);
  await git(['config', 'user.email', 'review@example.test']);
  await fs.writeFile(path.join(main, 'committed.ts'), 'export const committed = 1;\n');
  await fs.writeFile(path.join(main, 'dirty.ts'), 'export const current = 1;\n');
  await git(['add', 'committed.ts', 'dirty.ts']);
  await git(['commit', '--no-gpg-sign', '-s', '-m', 'baseline']);
  await git(['worktree', 'add', '-b', 'integration', actual]);
  await fs.writeFile(path.join(actual, 'committed.ts'), 'export const committed = 0;\n');
  await git(['add', 'committed.ts'], actual);
  await git(['commit', '--no-gpg-sign', '-s', '-m', 'committed change'], actual);
  await fs.writeFile(path.join(actual, 'dirty.ts'), 'export const current = 0;\n');

  let commands = [JSON.stringify({ toolName: 'Bash', input: { command: `cd "${actual}" && git status --short` } })];
  runtime.resolveScope.mockImplementation((sessionId: string) => resolveReviewScope(sessionId, {
    getSessionRow: async () => ({ id: 'source', workingDir: main, worktreePath: null, remoteHostId: null }),
    getManagedWorktreePath: () => null,
    resolveSessionDir: (input) => resolveSessionGitDir(input, {
      recentToolUseContents: async () => commands, probeGitDir: readGitHead,
    }),
    git: runGit,
  }));
  const sourceScope = await runtime.resolveScope('source');
  expect(sourceScope.repoRoot).toBe(actual);

  runtime.captured = {
    id: 'turn', sessionId: 'source', anchorClientId: 'message', provider: 'claude-code',
    providerTurnId: null, cwd: main, state: 'partial', workspaceState: 'applied', isReversible: false,
    incompleteReasons: ['opaque-tool', 'concurrent-workspace'], createdAt: 1, completedAt: 2,
    files: [], diffs: [], fileCount: 0, additions: 0, deletions: 0,
  } satisfies TurnChangeSetDetail;
  await withSessionReviewWorkspace('source', sourceScope.repoRoot, async () => {
    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source', workingDir: actual, attachments: [], focus: '检查代码质量',
      explicitArtifactGrant: { paths: [], pathIdentities: new Map(), inlineAttachmentKeys: [] },
    });
    expect(evidence.workspace?.dirty).toBe(true);
    expect(evidence.branch?.diffs.map((diff) => diff.path)).toContain('committed.ts');
    expect(evidence.workspace?.diffs.unstaged.map((diff) => diff.path)).toContain('dirty.ts');
    evidence.changeSet = usableReviewChangeSet(evidence.changeSet, actual, {
      hasGitBaseline: !!evidence.workspaceFingerprint, hasExplicitArtifacts: false,
    });
    expect(evidence.changeSet).toBeNull();
    const prompt = buildReviewPrompt({ ...evidence, historyCaptureIncomplete: true }).prompt;
    expect(prompt).toContain('committed.ts');
    expect(prompt).toContain('dirty.ts');
    expect(prompt).toContain('历史改动记录不完整');
    expect(evidence.workspaceFingerprint).toBeTruthy();

    // Later task telemetry may point back to main; this Review keeps its tree.
    commands = [JSON.stringify({ toolName: 'exec', input: { cwd: main } })];
    expect(await reviewWorkspaceFingerprintIsCurrent('source', evidence.workspaceFingerprint)).toBe(true);
    await fs.writeFile(path.join(actual, 'dirty.ts'), 'export const current = 2;\n');
    expect(await reviewWorkspaceFingerprintIsCurrent('source', evidence.workspaceFingerprint)).toBe(false);
  });
  expect((await runtime.resolveScope('source')).repoRoot).toBe(main);
}, 30_000);

it('reviews every repository a task changed, skipping checkouts it only read', async () => {
  fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-multi-repo-review-')));
  const initRepo = async (dir: string) => {
    await fs.mkdir(dir);
    const git = (args: string[]) => runGit(args, { cwd: dir });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Review Test']);
    await git(['config', 'user.email', 'review@example.test']);
    await fs.writeFile(path.join(dir, 'app.ts'), 'export const value = 1;\n');
    await git(['add', 'app.ts']);
    await git(['commit', '--no-gpg-sign', '-s', '-m', 'baseline']);
    return git;
  };
  const client = path.join(fixtureRoot, 'client');
  const server = path.join(fixtureRoot, 'server');
  const readOnly = path.join(fixtureRoot, 'read-only');
  await initRepo(client);
  const serverGit = await initRepo(server);
  await initRepo(readOnly);
  await fs.writeFile(path.join(client, 'app.ts'), 'export const value = 2;\n');
  await serverGit(['checkout', '-b', 'feature']);
  await fs.writeFile(path.join(server, 'committed.ts'), 'export const removed = true;\n');
  await serverGit(['add', 'committed.ts']);
  await serverGit(['commit', '--no-gpg-sign', '-s', '-m', 'server change']);
  await fs.writeFile(path.join(server, 'app.ts'), 'export const value = 3;\n');

  runtime.resolveScope.mockImplementation((sessionId: string) => resolveReviewScope(sessionId, {
    getSessionRow: async () => ({ id: 'source', workingDir: client, worktreePath: null, remoteHostId: null }),
    getManagedWorktreePath: () => null,
    resolveSessionDir: (input) => resolveSessionGitDir(input, {
      recentToolUseContents: async () => [], probeGitDir: readGitHead,
    }),
    git: runGit,
  }));
  const touchedDirs = collectTouchedDirs([
    JSON.stringify({ toolName: 'exec', input: { cwd: readOnly } }),
    JSON.stringify({ toolName: 'exec', input: { cwd: path.join(server) } }),
    JSON.stringify({ toolName: 'file_change', input: { changes: [{ path: path.join(client, 'app.ts') }] } }),
  ]);

  const repos = await loadAdditionalReviewRepositories({
    sourceSessionId: 'source',
    primaryRoot: client,
    touchedDirs,
  });
  expect(repos.map((repo) => repo.root)).toEqual([server]);
  const [serverRepo] = repos;
  expect(serverRepo?.workspace?.diffs.unstaged.map((diff) => diff.path)).toContain('app.ts');
  expect(serverRepo?.branch?.diffs.map((diff) => diff.path)).toContain('committed.ts');

  const prompt = await withSessionReviewWorkspace('source', client, async () => {
    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source', workingDir: client, attachments: [],
      explicitArtifactGrant: { paths: [], pathIdentities: new Map(), inlineAttachmentKeys: [] },
    });
    return buildReviewPrompt({ ...evidence, primaryRoot: client, additionalRepositories: repos }).prompt;
  });
  expect(prompt).toContain(`## 其它仓库：${server}`);
  expect(prompt).toContain('committed.ts');
  expect(prompt).toContain('export const value = 3;');
  expect(prompt).not.toContain(readOnly);

  expect(await additionalReviewRepositoriesAreCurrent('source', repos)).toBe(true);
  await fs.writeFile(path.join(server, 'app.ts'), 'export const value = 4;\n');
  expect(await additionalReviewRepositoriesAreCurrent('source', repos)).toBe(false);
}, 30_000);
