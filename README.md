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

## Releasing

Packages release independently through `.github/workflows/publish.yml`. A GitHub Release tag must
use `<plugin>-v<version>`, for example `codex-v0.1.1`. The tag version must match both the package's
`package.json` and `plugin.json`.

npm Trusted Publishing must authorize the `publish.yml` workflow in the
`zclaudia/zclaudia-plugins` repository for each package.
