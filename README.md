# ZClaudia Plugins

Official agent runtime plugins for [ZClaudia](https://github.com/zclaudia/zclaudia).

## Packages

| Directory       | npm package               | Runtime          |
| --------------- | ------------------------- | ---------------- |
| `agents/claude` | `@zclaudia/plugin-claude` | Claude Agent SDK |
| `agents/codex`  | `@zclaudia/plugin-codex`  | Codex app-server |
| `agents/cursor` | `@zclaudia/plugin-cursor` | Cursor Agent CLI |

Each package contains its ZClaudia `plugin.json`, compiled runtime entrypoint, and provider-specific
adapter. Public host contracts come exclusively from `@zclaudia/plugin-sdk`; packages in this
repository must not import application-monorepo modules.

## Development

```bash
pnpm install
pnpm check
```

Run a command for one plugin with a workspace filter:

```bash
pnpm --filter @zclaudia/plugin-codex test
pnpm --filter @zclaudia/plugin-codex build
```

After building, add the absolute package directory (for example
`/path/to/zclaudia-plugins/agents/codex`) to ZClaudia's plugin directories and rediscover plugins.

Agent plugins can also be loaded and exercised without starting ZClaudia:

```bash
pnpm agent:dev inspect agents/codex
pnpm agent:dev run agents/codex --cwd /path/to/project --input "Summarize this repository"
pnpm agent:dev chat agents/claude --cwd /path/to/project --bridge debug
```

The standalone host uses the same `plugin.json` entrypoint and `ExternalAgentAdapter` contract as
ZClaudia. It supports raw/JSONL traces, resumable provider sessions, terminal permission prompts,
abort handling, and an optional authenticated MCP debug bridge. See
[Standalone Agent Runtime](docs/standalone-agent-runtime.md).

## Runtime compatibility

Each plugin declares how to probe and certify its host CLI in
`runtime-compatibility.json`. Run a safe local probe for every discovered runtime with:

```bash
pnpm compat:test all --report artifacts/compatibility-report.json
```

The optional `--live` mode performs a real provider turn in a temporary directory and may consume
provider quota:

```bash
pnpm compat:test all --live
```

See [Runtime Compatibility Testing](docs/runtime-compatibility.md) for result states, report
format, managed installation metadata, and how to add future agent runtimes.

## Distribution

The end-user distribution format is a versioned `.zplugin` archive published through GitHub
Releases, not the npm registry. Build-time dependencies may still be installed with pnpm; they are
either compiled away or vendored into the final archive.

Build one plugin or all discovered plugins:

```bash
pnpm pack:plugin claude
pnpm pack:plugin codex
pnpm pack:plugin cursor
pnpm pack:plugins
```

Artifacts, SHA-256 sidecars, and machine-readable metadata are written under `artifacts/release/`.
Validate either a staged directory or an archive independently with:

```bash
pnpm validate:plugin path/to/plugin-or-archive
```

See [Plugin Distribution Design](docs/plugin-distribution.md) for the artifact format, Claude CLI
strategy, release workflow, catalog schema, security requirements, and implementation phases.

The reusable host packages now live in the independent
[`zclaudia-agent-runtime`](https://github.com/zclaudia/zclaudia-agent-runtime) and
[`zclaudia-agent-tool-bridge`](https://github.com/zclaudia/zclaudia-agent-tool-bridge)
repositories. This repository consumes their public npm releases through semver dependencies.

## Release workflow

Plugins release independently through the manually triggered `.github/workflows/publish.yml`.
Open the workflow in GitHub Actions, choose **Run workflow**, select the source branch, and enter a
version such as `0.1.0`. Leave **plugin** set to `all` to package and publish Claude, Codex, and
Cursor together, or select one plugin for an individual release. The version must match the
selected packages' `package.json` and `plugin.json`; the workflow verifies, packages,
smoke-imports, creates the agent-specific tags and GitHub Releases when needed, and uploads each
`.zplugin`, checksum, and metadata.
