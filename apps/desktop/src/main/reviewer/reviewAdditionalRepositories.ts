import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';

import { readReviewBranchDiff } from '../git-review/ipc.js';
import { runGit } from '../git-review/gitRunner.js';
import { withSessionReviewWorkspace } from '../git-review/scopeResolver.js';
import {
  loadReviewBranchEvidence,
  readReviewWorkspaceSnapshot,
  reviewBranchBaselineIsCurrent,
  reviewWorkspaceFingerprintIsCurrent,
} from './reviewEvidence.js';
import { repositoryHasChanges, type ReviewRepositoryEvidence } from './reviewPrompt.js';

const MAX_ADDITIONAL_REPOSITORIES = 4;
const MAX_ADDITIONAL_REPOSITORY_PROBES = 12;

export interface LoadedReviewRepository extends ReviewRepositoryEvidence {
  fingerprint: string | null;
}

/** The repository root containing an existing local directory, or null. */
export async function resolveReviewRepoRoot(dir: string): Promise<string | null> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    const root = stdout.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

/**
 * Other repositories or worktrees the task changed besides the primary one,
 * newest first. Only repositories with uncommitted work or branch commits are
 * evidence: a checkout the task merely read must not pull unrelated edits in.
 * Each one is read through the same pinned-workspace path as the primary, so
 * redaction, caps and fingerprints are identical.
 */
export async function loadAdditionalReviewRepositories(input: {
  sourceSessionId: string;
  primaryRoot: string | null;
  touchedDirs: readonly string[];
  resolveRepoRoot?: (dir: string) => Promise<string | null>;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}): Promise<LoadedReviewRepository[]> {
  const resolveRoot = input.resolveRepoRoot ?? resolveReviewRepoRoot;
  const primary = input.primaryRoot ? path.resolve(input.primaryRoot) : null;
  const seenRoots = new Set<string>(primary ? [primary] : []);
  const repos: LoadedReviewRepository[] = [];
  let probes = 0;
  for (const dir of input.touchedDirs) {
    if (repos.length >= MAX_ADDITIONAL_REPOSITORIES || probes >= MAX_ADDITIONAL_REPOSITORY_PROBES) break;
    if (isReviewSensitiveCredentialPath(dir)) continue;
    const root = await resolveRoot(dir);
    if (!root || seenRoots.has(root) || isReviewSensitiveCredentialPath(root)) continue;
    seenRoots.add(root);
    probes += 1;
    try {
      const repo = await withSessionReviewWorkspace(input.sourceSessionId, root, async () => {
        const snapshot = await readReviewWorkspaceSnapshot(input.sourceSessionId);
        const workspace = snapshot?.workspace ?? null;
        if (!snapshot || !workspace || workspace.disabledReason) return null;
        const branchEvidence = await loadReviewBranchEvidence(
          input.sourceSessionId,
          readReviewBranchDiff,
        );
        const loaded: LoadedReviewRepository = {
          root,
          workspace,
          branch: branchEvidence.branch,
          fingerprint: snapshot.fingerprint,
          ...(branchEvidence.unavailableReason
            ? { branchUnavailableReason: branchEvidence.unavailableReason }
            : {}),
        };
        return loaded;
      });
      if (repo && repositoryHasChanges(repo)) repos.push(repo);
    } catch (error) {
      // Additional repositories widen coverage; one unreadable checkout must not
      // abort the review of the primary deliverable.
      input.warn?.('review additional repository skipped', {
        root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return repos;
}

/** Freshness for additional repositories, with the same rules as the primary. */
export async function additionalReviewRepositoriesAreCurrent(
  sourceSessionId: string,
  repos: readonly LoadedReviewRepository[],
): Promise<boolean> {
  for (const repo of repos) {
    const current = await withSessionReviewWorkspace(sourceSessionId, repo.root, async () =>
      (await reviewWorkspaceFingerprintIsCurrent(sourceSessionId, repo.fingerprint)) &&
      (await reviewBranchBaselineIsCurrent(sourceSessionId, repo.branch)),
    ).catch(() => false);
    if (!current) return false;
  }
  return true;
}
