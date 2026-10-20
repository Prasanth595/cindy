# Cindy native command rules helper

PR1 imports only Codex `.rules` command policies into Pi **Auto** approval.
The helper uses the pinned Codex 0.145.0 commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`: native effective-config/trust
loading, complete Starlark files, native executable matching and native shell
analysis. It does not start Codex AI or execute the command being checked.
Hooks, scripts, system prompts, other permission modes and reviewer policy are
outside this change. Unmatched commands retain the existing reviewer.

## Build and package

Install the Rust toolchain declared in `rust-toolchain.toml`, and repository
Node/pnpm dependencies following `docs/dev-rules/environment-setup.md`.
From the repository root, build each asset on a matching build machine (or a
configured cross compiler):

```
node apps/desktop/scripts/build-command-rules.mjs darwin-arm64
node apps/desktop/scripts/build-command-rules.mjs darwin-x64
node apps/desktop/scripts/build-command-rules.mjs linux-arm64
node apps/desktop/scripts/build-command-rules.mjs linux-x64
node apps/desktop/scripts/build-command-rules.mjs win32-x64
```

Each output directory under `apps/desktop/resources/tools/command-rules/`
contains its executable, pinned-version/SHA-256 manifest and generated
third-party notices. Existing notice collection/audit is reused. Generated
binary assets are not source files and must not be committed.

Forge builds its own target, then requires **all four macOS/Linux SSH assets**
(and Windows x64 for Windows packaging). Missing, damaged or wrong-version
assets stop packaging. Collect matching build outputs in a directory with
`<platform>-<arch>/` children and supply that directory through the build-only
`CINDY_COMMAND_RULES_ASSETS_DIR` environment variable. No runtime download or
Rust installation is required. This does not supply or certify cross-platform
build outputs: those must be produced and tested on the target platforms.

## Runtime and compatibility

Owner-scoped packages live outside the repository and harness homes under
`command-approval-rules`, keyed by owner/execution host/effective cwd/configured
home candidates. The selected Codex home remains in the package scope; switching
fallback homes is a source change, never another first import. The first home
with native effective rules wins, including trusted project/system layers; only
an entirely empty native source falls back. Native files,
boundaries, order, source-layer versions and trust are
preserved. Publication is locked and atomic. Parse/version/read failures block
this Auto command instead of becoming unmatched. Deleted packages retain a
marker. Changed source packages retain the previous snapshot and record a
pending digest; stale allows stop. PR1 provides no settings editor: resolving
pending source changes requires deliberate package reconciliation; restoring
the previous source also permits retry. Original Codex files are never changed.

Main and durable child approvals share the existing interaction lifecycle.
After approval/review awaits, owner/source/package revisions are revalidated.
The bridge rejects command or native shell-configuration changes after approval.
Device-hosted Pi uses the existing tunnel's `pi.commandrules` operation and
passes an optional revision on `exec.run`; the execution computer rechecks the
actual shell immediately before spawn. Other executor clients are unaffected.
An older execution computer without this operation returns an explicit update
error. An old Agent computer cannot execute a newly matched rule without its
revision; unmatched legacy calls remain compatible.

## Verification

```
cargo test --locked --manifest-path apps/desktop/native/command-rules/Cargo.toml
pnpm test:unit:related
pnpm --filter desktop run --if-present typecheck
pnpm --filter @cindy/maker-core exec tsc --noEmit
```

The native E2E tier uses temporary homes, a local fake model service and a fake
executable, through real Pi, bridge, dispatcher, package store and helper:

```
CINDY_TEST_PI_BINARY=/absolute/path/to/pi \
CINDY_TEST_RULES_BINARY=/absolute/path/to/cindy-command-rules \
pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/command-rules.e2e.test.ts
```

Missing binaries explicitly skip this manual tier. Local E2E success does not
verify Windows PowerShell, other architectures, an actual SSH computer, mobile
permission-card presentation, packaging, signing or production deployment.
