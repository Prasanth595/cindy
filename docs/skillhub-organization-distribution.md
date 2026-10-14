# Organization Skill distribution

The enterprise Console manages visibility and automatic installation audiences for organization-owned native skills.
The desktop reads `GET /api/skills-hub/auto-install` from the existing `cindySkillHubApiBaseUrl` after login or identity changes.
The additive response is `{ skills: [{ name, version, catalogScope: "team" }], nextCursor }`; each page contains at most 100 skills.
For automatic installation, department IDs are never submitted by the desktop. The server selects candidates using authenticated membership and both audiences.

Organization candidates take precedence over same-slug product defaults. Existing installers, digest verification, local registry,
conflict protection, ignore preferences and cancellation cleanup remain in use. Policy changes do not uninstall existing files.
A transient error or old server returning 404 does not clear stored preferences or prevent product defaults from being processed.
Users can sign out and back in (or restart Cindy) to pick up changed policies; no live policy polling is introduced.
Older desktop versions retain manual installation but do not consume the new automatic distribution endpoint.

Deploy the server and its migration first, then release the desktop consumer. New endpoint failures are isolated from manual installation.

## Department visibility in Desktop publishing and management

Organization authors and administrators can choose all members or selected departments when first publishing or editing visibility. Department choices come from `GET /api/skills-hub/users/departments`; the server derives the organization from the authenticated identity. `audienceSupported: true` enables the new UI. An old server without this capability cannot silently save a selected scope as organization-wide visibility.

First publication adds `visibilityDepartmentIds` and `audienceMode` (`all` or `departments`) to the existing commit request. Existing-version publication does not modify the scope. Visibility management reads `GET /api/skills-hub/skills/:name/visibility` and sends the returned `updatedAt` as `expectedUpdatedAt` to the existing set-visibility endpoint. A 409 preserves the draft and requires an explicit reload. Empty department selection cannot be saved; cancel makes no mutation.

Selecting a parent includes descendants and removes redundant selected descendants. Selecting all children does not promote the selection to their parent. The server validates live department ownership and canonicalizes the submitted selection. Authors retain management access outside their audience; organization administrators can manage organization skills. Editing visibility leaves automatic-install settings intact, and public-review transitions preserve the existing audience until approval.

Deploy Auth department discovery, then Skill Hub API and worker, then Desktop. The server requires an additive upload-queue enum migration before deploying its API and worker, so old workers cannot claim department-scoped jobs. No Desktop migration or new environment variables are required. Existing clients retain their previous request semantics.
