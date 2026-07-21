# Plugin Distribution Design

Status: phases 1 and 2 and the phase 3 local-file host installer are implemented; catalog, URL
installation, and signing remain

This document defines how the official ZClaudia agent plugins are built and distributed without
publishing them to the npm registry. It is intentionally owned by the `zclaudia-plugins`
repository so packaging work can proceed independently from the ZClaudia application repository.

## Goals

- Publish installable, immutable plugin artifacts without requiring users to use npm.
- Keep Claude, Codex, and Cursor independently versioned and releasable.
- Produce archives that the existing ZClaudia directory-based loader can load after extraction.
- Reuse agent CLIs installed and authenticated on the host machine.
- Support integrity verification, compatibility checks, upgrades, and rollback.
- Keep npm/pnpm as build-time tooling only; it is not an end-user distribution channel.

## Non-goals for the first release

- A general third-party marketplace.
- Delta updates.
- Background auto-update without user confirmation.
- Running untrusted plugins in a stronger sandbox than the current plugin execution mode.
- Reimplementing the Claude Agent SDK protocol directly on top of Claude CLI JSON streams.

## Distribution model

The canonical distribution channel is GitHub Releases in
`zclaudia/zclaudia-plugins`. Each release contains one or more `.zplugin` archives and matching
SHA-256 files.

Release tags remain agent-specific:

```text
claude-v0.1.0
codex-v0.1.0
cursor-v0.1.0
```

Recommended artifact names:

```text
zclaudia-agent-claude-0.1.0-any.zplugin
zclaudia-agent-codex-0.1.0-any.zplugin
zclaudia-agent-cursor-0.1.0-any.zplugin
```

`any` means the plugin JavaScript is platform-neutral and invokes an agent CLI supplied by the
host machine. If a future plugin carries native code, replace `any` with a target such as
`darwin-arm64`, `linux-x64`, or `win32-x64`.

## Archive layout

A `.zplugin` file is a ZIP archive. The archive root is the plugin root; it must not contain an
extra top-level directory.

Codex and Cursor require only compiled code and metadata:

```text
plugin.json
dist/
  main.js
  ...
README.md
LICENSE
```

Claude also carries the platform-neutral JavaScript portion of the Claude Agent SDK:

```text
plugin.json
dist/
  main.js
  ...
node_modules/
  @anthropic-ai/claude-agent-sdk/
  @anthropic-ai/sdk/
  @modelcontextprotocol/sdk/
  ...transitive runtime dependencies...
README.md
LICENSE
THIRD_PARTY_LICENSES.txt
```

The exact Claude dependency set must be derived from the lockfile during packaging rather than
maintained manually. Platform-specific optional Claude Agent SDK packages must be omitted.

Source files, tests, TypeScript configuration, workspace metadata, caches, and development
dependencies must not be included.

## Runtime prerequisites

| Agent  | Required host executable | Included in `.zplugin`                     | Artifact target |
| ------ | ------------------------ | ------------------------------------------ | --------------- |
| Claude | `claude`                 | Claude Agent SDK JavaScript, no native CLI | `any`           |
| Codex  | `codex`                  | Adapter only                               | `any`           |
| Cursor | `cursor-agent`           | Adapter only                               | `any`           |

Users install and authenticate each CLI using its upstream installation process. ZClaudia does
not copy credentials into plugin archives.

## Claude host CLI strategy

The Claude plugin continues to use `@anthropic-ai/claude-agent-sdk` as its protocol and control
library, but it always points the SDK at a Claude CLI installed on the host.

Resolution order:

1. An explicit `cliPath` supplied by the ZClaudia agent profile.
2. A `claude` executable resolved from the effective `PATH`.
3. Fail with an actionable installation/configuration error.

There is no fallback to the native binary bundled as an optional dependency of the Agent SDK.

Target runtime behavior:

```ts
const cliPath = options.cliPath ?? resolveClaudeCliFromPath(effectiveEnv.PATH);

if (!cliPath) {
  throw new Error(
    'Claude Code CLI is required. Install Claude Code or configure its executable path.'
  );
}

sdkOptions.pathToClaudeCodeExecutable = cliPath;
```

The SDK remains necessary because it owns the Claude Code control protocol, streaming message
handling, sessions, permission callbacks, MCP configuration, abort behavior, and typed events.
Removing the SDK would require ZClaudia to implement and maintain that protocol itself.

### Claude packaging requirements

- Install or deploy production dependencies without optional dependencies.
- Verify no package matching `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` is present.
- Verify the extracted plugin imports successfully without a bundled Claude binary.
- Run an integration smoke test against a host-installed `claude` executable when CI credentials
  and environment allow it; otherwise run a deterministic spawn fixture test.
- Produce a third-party dependency/license inventory before public distribution.

### CLI and SDK compatibility

Agent SDK releases track Claude Code protocol changes. The plugin must detect the host CLI version
and compare it with a tested compatibility range.

Initial policy:

- Missing CLI: block activation with installation instructions.
- CLI below the tested minimum: block activation.
- CLI above the tested range: warn and allow initially, while recording the detected version.
- Known-incompatible versions: block activation with an upgrade/downgrade message.

The tested range should live in one source of truth and be surfaced in release metadata. Until
the ZClaudia plugin manifest schema supports executable requirements, enforce it in the Claude
adapter and document it in the catalog.

Proposed future manifest contribution:

```json
{
  "requires": {
    "executables": [
      {
        "name": "claude",
        "version": ">=2.1.140",
        "pathSetting": "cliPath"
      }
    ]
  }
}
```

Do not add this field to production manifests until `@zclaudia/plugin-sdk` and the host validator
define it.

## Packaging pipeline

Add a repository-owned packaging command with the following interface:

```bash
pnpm pack:plugin claude
pnpm pack:plugin codex
pnpm pack:plugin cursor
pnpm pack:plugins
```

The implementation should:

1. Clean previous build and staging directories.
2. Validate package and `plugin.json` versions match.
3. Run boundary checks, type checks, tests, and build.
4. Create a fresh staging directory for the selected agent.
5. Copy only allowlisted files into staging.
6. Vendor production runtime dependencies when required.
7. Validate the staging directory as an installable plugin.
8. Create a deterministic ZIP with a `.zplugin` extension.
9. Generate `<artifact>.sha256`.
10. Extract the archive into a temporary directory and smoke-import its `main` entrypoint.
11. Emit machine-readable artifact metadata for the release workflow.

Suggested generated paths, all ignored by Git:

```text
artifacts/
  staging/<agent>/
  release/<artifact>.zplugin
  release/<artifact>.zplugin.sha256
  release/<artifact>.metadata.json
```

### Deterministic archive rules

- Sort archive entries lexicographically.
- Normalize path separators to `/`.
- Normalize file timestamps to a fixed release timestamp.
- Preserve executable bits only where required.
- Do not include symlinks that resolve outside the archive root.
- Use ZIP store mode (no deflate compression) so local and CI output is independent of the
  installed Node/zlib version.

## Package validation

Packaging must fail when any of these conditions is true:

- `plugin.json` is missing or invalid.
- The package version and plugin manifest version differ.
- `main` is absolute, escapes the archive root, or does not exist.
- The archive contains `src`, tests, secrets, environment files, or development caches.
- The archive contains a `workspace:` dependency.
- Runtime JavaScript imports `@zclaudia/shared`.
- An unexpected native binary is present in an `any` artifact.
- Claude contains a platform-specific Agent SDK optional package.
- A ZIP entry uses path traversal, an absolute path, or an unsafe symlink.
- The unpacked size, file count, or individual file size exceeds configured limits.

The validator should be usable independently:

```bash
pnpm validate:plugin path/to/plugin-directory
pnpm validate:plugin path/to/plugin.zplugin
```

## Release workflow

Replace the temporary npm publish workflow with a GitHub Release artifact workflow.

The manually triggered workflow accepts a version and an `all|claude|codex|cursor` selector. Given
version `0.1.0` and selector `claude`, for example, it should:

1. Construct and validate the agent-specific release tag `claude-v0.1.0`.
2. Verify both `agents/claude/package.json` and `agents/claude/plugin.json` use `0.1.0`.
3. Install dependencies from the frozen lockfile.
4. Run the complete repository check.
5. Run `pnpm pack:plugin claude`.
6. Verify the produced artifact metadata.
7. Upload `.zplugin`, `.sha256`, and metadata files to the GitHub Release.
8. Publish provenance/signature information when signing is enabled.

The workflow must not run `npm publish` and does not require npm Trusted Publishing.

## Catalog

The repository will eventually publish a signed or integrity-protected `catalog.json` that the
ZClaudia plugin UI can consume.

Initial schema direction:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-21T00:00:00Z",
  "plugins": {
    "com.zclaudia.claude": {
      "name": "Claude Agent",
      "latest": "0.1.0",
      "releases": {
        "0.1.0": {
          "minHostVersion": "0.1.1220",
          "requiredExecutables": {
            "claude": ">=2.1.140"
          },
          "artifacts": {
            "any": {
              "url": "https://github.com/zclaudia/zclaudia-plugins/releases/download/claude-v0.1.0/zclaudia-agent-claude-0.1.0-any.zplugin",
              "sha256": "<sha256>",
              "size": 0
            }
          }
        }
      }
    }
  }
}
```

Do not automatically commit generated catalog changes to `main` from the release workflow. Prefer
a reviewed catalog update or a separate generated publication target such as GitHub Pages.

## Host installation contract

Host-side implementation belongs in the main `zclaudia` repository, but packaging must target the
following contract:

1. Download the archive to a temporary file.
2. Verify the SHA-256 and, when available, its signature/provenance.
3. Safely extract and validate every path before writing it.
4. Validate `plugin.json`, compatibility, and the main entrypoint.
5. Retain the immutable version under the package store:

   ```text
   ~/.zclaudia/plugin-store/com.zclaudia.claude/0.1.0/
   ```

6. Atomically materialize the selected version at the only loader-visible path:

   ```text
   ~/.zclaudia/plugins/com.zclaudia.claude/
   ```

   Historical versions must not live below `plugins/`, because the directory loader recursively
   discovers manifests and would treat them as duplicate plugins.

7. Ask the existing plugin loader to rediscover it, but leave it inactive until the user enables
   it.
8. Keep the previous version available for rollback.

The current loader already supports the extracted directory shape; it does not need to understand
ZIP files directly.

## Security and trust

SHA-256 protects against accidental corruption but does not by itself authenticate a publisher.
The first implementation can rely on GitHub HTTPS plus pinned checksums from the catalog, but the
design must leave room for stronger verification.

Before enabling unattended updates:

- Sign release metadata or use verifiable build provenance.
- Pin the trusted publisher identity in the host.
- Verify archive paths before extraction to prevent ZIP traversal.
- Reject unsafe symlinks and hard links.
- Enforce size and file-count limits before extraction.
- Install into a temporary directory and rename atomically after validation.
- Display requested plugin permissions before activation.

## Implementation phases

### Phase 1: repository packaging

- [x] Add `scripts/pack-plugin.mjs`.
- [x] Add directory and archive validators.
- [x] Add deterministic ZIP generation.
- [x] Add SHA-256 and metadata generation.
- [x] Make Claude require the host CLI and remove the bundled-binary fallback.
- [x] Vendor Claude SDK JavaScript without optional native packages.
- [x] Add extracted-artifact smoke tests for all three agents.
- [x] Add `artifacts/` to `.gitignore`.

Exit criteria: local `pnpm pack:plugins` produces three validated `any` artifacts.

### Phase 2: GitHub Releases

- [x] Replace `.github/workflows/publish.yml` with archive publishing.
- [x] Preserve agent-specific release tags.
- [x] Upload archives, checksums, and metadata.
- [x] Confirm release artifacts can be installed manually into ZClaudia.

Exit criteria: a GitHub Release is the sole official source for an installable plugin version.

### Phase 3: catalog and host installer

- [ ] Define and publish `catalog.json`.
- [x] Add local `.zplugin` file inspection and installation APIs to the host repository.
- [ ] Add catalog-backed URL installation and download APIs.
- [x] Add safe extraction, version selection, uninstall, and rollback.
- [x] Integrate managed source, selected version, CLI status, rollback, and uninstall into the
      plugin UI.
- [ ] Integrate catalog-backed available/update state into the plugin UI.

Exit criteria: users can install and update a plugin without Git, Node.js, pnpm, or npm.

### Phase 4: signing and update hardening

- [ ] Add publisher identity verification and signed metadata/provenance.
- [ ] Add compatibility and revocation information to the catalog.
- [ ] Add recovery tests for interrupted installation and failed activation.
- [ ] Define retention rules for old releases and rollback versions.

Exit criteria: unattended update can be considered without weakening plugin supply-chain safety.

## Decisions recorded

- GitHub Releases, not npm, is the canonical end-user distribution channel.
- `.zplugin` is a ZIP archive containing an extracted plugin directory.
- Agent CLIs are host prerequisites and are not redistributed.
- Claude keeps the Agent SDK JavaScript protocol layer but reuses the host `claude` executable.
- Claude does not fall back to the SDK's platform-specific optional binary.
- The initial three artifacts are platform-neutral and use the `any` target.
- The host loader remains directory-based; installation/extraction is a separate responsibility.
- Catalog and host installation follow artifact generation rather than blocking the first package.
