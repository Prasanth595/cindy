import path from 'node:path';
import { gitExec, GitExecError } from './gitExec';
import { boundedNetworkGitOpts } from './freshBase';
import type {
  BranchSyncRequest,
  BranchSyncResult,
  BranchSyncStatus,
} from '../../shared/worktreeBranchSync';

const localOpts = { timeoutMs: 5_000, extraEnv: { LC_ALL: 'C' } };
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitExec(args, cwd, localOpts)).stdout.trim();
}
async function optional(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, ...args);
  } catch (error) {
    if (error instanceof GitExecError && !error.timedOut && error.exitCode !== null)
      return undefined;
    throw error;
  }
}

/** Local refs only: a dangling origin/HEAD must not hide the main/master fallback. */
export async function readOriginDefaultBranch(cwd: string): Promise<string | undefined> {
  const symbolic = await optional(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD');
  for (const ref of [symbolic, 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (
      ref?.startsWith('refs/remotes/origin/') &&
      (await optional(cwd, 'rev-parse', '--verify', `${ref}^{commit}`))
    )
      return ref;
  }
  return undefined;
}

function dirtyPaths(porcelain: string): { paths: string[]; files: number } {
  const fields = porcelain.split('\0');
  const paths: string[] = [];
  let files = 0;
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i];
    if (!row) continue;
    files++;
    paths.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
  }
  return { paths, files };
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Validate refs even for direct main callers; never pass an option-shaped ref to Git. */
async function validate(req: BranchSyncRequest): Promise<void> {
  if (
    !req ||
    typeof req.baseRepo !== 'string' ||
    !path.isAbsolute(req.baseRepo) ||
    typeof req.branch !== 'string' ||
    req.branch.length > 1024 ||
    req.branch.startsWith('-')
  ) {
    throw new Error('Invalid branch sync request');
  }
  await git(
    req.baseRepo,
    'check-ref-format',
    req.branch.startsWith('refs/remotes/origin/') ? req.branch : `refs/heads/${req.branch}`,
  );
}

export async function readBranchSyncStatus(req: BranchSyncRequest): Promise<BranchSyncStatus> {
  await validate(req);
  const { baseRepo, branch } = req;
  const remoteOnly = branch.startsWith('refs/remotes/origin/');
  const status: BranchSyncStatus = { branch, remoteOnly, ahead: 0, behind: 0, dirtyFiles: 0 };
  const remotes = (await git(baseRepo, 'remote')).split(/\r?\n/).filter(Boolean);
  let remote = 'origin';
  let remoteBranch = remoteOnly ? branch.slice('refs/remotes/origin/'.length) : branch;
  const localRef = `refs/heads/${branch}`;
  if (!remoteOnly) {
    if (!(await optional(baseRepo, 'rev-parse', '--verify', `${localRef}^{commit}`)))
      return { ...status, blocked: 'not-local' };
    const configuredRemote = await optional(baseRepo, 'config', '--get', `branch.${branch}.remote`);
    const configuredRef = await optional(baseRepo, 'config', '--get', `branch.${branch}.merge`);
    if (configuredRemote && configuredRef?.startsWith('refs/heads/')) {
      remote = configuredRemote;
      remoteBranch = configuredRef.slice('refs/heads/'.length);
    }
    // -z preserves checkout paths containing newlines and non-ASCII characters.
    const worktrees = (
      await gitExec(['worktree', 'list', '--porcelain', '-z'], baseRepo, localOpts)
    ).stdout;
    for (const block of worktrees.split('\0\0')) {
      const fields = block.split('\0');
      if (fields.includes(`branch ${localRef}`)) {
        status.checkoutPath = fields.find((s) => s.startsWith('worktree '))?.slice(9);
        break;
      }
    }
  }
  const dirty = status.checkoutPath
    ? dirtyPaths(
        (
          await gitExec(
            ['status', '--porcelain', '-z', '--untracked-files=all'],
            status.checkoutPath,
            localOpts,
          )
        ).stdout,
      )
    : { paths: [], files: 0 };
  status.dirtyFiles = dirty.files;
  if (!remotes.includes(remote)) return { ...status, blocked: 'no-remote' };
  Object.assign(status, {
    remote,
    remoteBranch,
    remoteRef: `refs/remotes/${remote}/${remoteBranch}`,
  });
  // A missing local tracking ref is unknown, not evidence the remote branch is absent.
  if (!(await optional(baseRepo, 'rev-parse', '--verify', `${status.remoteRef}^{commit}`)))
    return status;
  if (remoteOnly) return status;
  const counts = (
    await git(baseRepo, 'rev-list', '--left-right', '--count', `${localRef}...${status.remoteRef}`)
  )
    .split(/\s+/)
    .map(Number);
  [status.ahead, status.behind] = counts;
  if (status.ahead && status.behind) return { ...status, blocked: 'diverged' };
  if (status.behind && dirty.paths.length) {
    const changes = (
      await gitExec(['diff', '--name-only', '-z', localRef, status.remoteRef!], baseRepo, localOpts)
    ).stdout
      .split('\0')
      .filter(Boolean);
    if (dirty.paths.some((p) => changes.some((other) => overlaps(p, other))))
      return { ...status, blocked: 'conflict' };
  }
  return status;
}

// Serialize this UI's mutations per repository; no coupling to task creation or sends.
const syncing = new Map<string, Promise<BranchSyncResult>>();
export async function syncBranch(req: BranchSyncRequest): Promise<BranchSyncResult> {
  await validate(req);
  const key = await git(req.baseRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (syncing.has(key)) throw new Error('A branch update is already running');
  const operation = syncBranchOnce(req);
  syncing.set(key, operation);
  try {
    return await operation;
  } finally {
    syncing.delete(key);
  }
}
async function syncBranchOnce(req: BranchSyncRequest): Promise<BranchSyncResult> {
  let status = await readBranchSyncStatus(req);
  if (status.blocked) return { status, updated: 0 };
  const { remote, remoteBranch, remoteRef } = status;
  const oldRemote = await optional(req.baseRepo, 'rev-parse', '--verify', `${remoteRef}^{commit}`);
  try {
    await gitExec(
      [
        'fetch',
        '--no-tags',
        '--recurse-submodules=no',
        '--',
        remote!,
        `+refs/heads/${remoteBranch}:${remoteRef}`,
      ],
      req.baseRepo,
      {
        ...boundedNetworkGitOpts(30_000),
        extraEnv: { ...boundedNetworkGitOpts(30_000).extraEnv, LC_ALL: 'C' },
      },
    );
  } catch (error) {
    if (
      error instanceof GitExecError &&
      /couldn't find remote ref|could not find remote ref/i.test(error.stderr)
    ) {
      return { status: { ...status, blocked: 'missing-remote' }, updated: 0 };
    }
    throw error;
  }
  status = await readBranchSyncStatus(req);
  if (status.blocked) return { status, updated: 0 };
  if (status.remoteOnly) {
    const updated = Number(
      await git(
        req.baseRepo,
        'rev-list',
        '--count',
        oldRemote ? `${oldRemote}..${remoteRef}` : remoteRef!,
      ),
    );
    return { status, updated };
  }
  if (!status.behind) return { status, updated: 0 };
  const old = await git(req.baseRepo, 'rev-parse', '--verify', `refs/heads/${req.branch}^{commit}`);
  const next = await git(req.baseRepo, 'rev-parse', '--verify', `${remoteRef}^{commit}`);
  await git(req.baseRepo, 'merge-base', '--is-ancestor', old, next);
  const updated = status.behind;
  if (status.checkoutPath) {
    if ((await git(status.checkoutPath, 'symbolic-ref', 'HEAD')) !== `refs/heads/${req.branch}`)
      throw new Error('The checked-out branch changed; retry');
    try {
      await git(status.checkoutPath, 'merge', '--ff-only', '--no-autostash', next);
    } catch (error) {
      const refreshed = await readBranchSyncStatus(req);
      if (refreshed.blocked) return { status: refreshed, updated: 0 };
      if (error instanceof GitExecError && /would be overwritten|local changes/i.test(error.stderr))
        return { status: { ...refreshed, blocked: 'conflict' }, updated: 0 };
      throw error;
    }
  } else {
    await git(req.baseRepo, 'update-ref', `refs/heads/${req.branch}`, next, old);
  }
  return { status: await readBranchSyncStatus(req), updated };
}
