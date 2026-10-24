import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  type MobileAuthOwnerGeneration,
} from '@/auth/authOwnerGeneration';

/** Shared tasks keep the same ID for every participant; drafts belong to the
 * authenticated account, never to that task ID alone. Callbacks retain their
 * original generation so a late edit cannot be attributed to a new account. */
export function mobileDraftScopeKey(
  id: string,
  owner: MobileAuthOwnerGeneration = getMobileAuthOwner(),
): string {
  const normalized = id.trim();
  return normalized && owner.accountKey && isMobileAuthOwnerCurrent(owner)
    ? JSON.stringify([owner.accountKey, normalized])
    : '';
}
