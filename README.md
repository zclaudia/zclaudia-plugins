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

## Distribution

The end-user distribution format is a versioned `.zplugin` archive published through GitHub
Releases, not the npm registry. Build-time dependencies may still be installed with pnpm; they are
either compiled away or vendored into the final archive.

Build one plugin or all three:

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

## Release workflow

Plugins release independently through the manually triggered `.github/workflows/publish.yml`.
Open the workflow in GitHub Actions, choose **Run workflow**, select the source branch, and enter a
version such as `0.1.0`. Leave **plugin** set to `all` to package and publish Claude, Codex, and
Cursor together, or select one plugin for an individual release. The version must match the
selected packages' `package.json` and `plugin.json`; the workflow verifies, packages,
smoke-imports, creates the agent-specific tags and GitHub Releases when needed, and uploads each
`.zplugin`, checksum, and metadata.
