# @zclaudia/plugin-codex

Codex app-server runtime plugin for ZClaudia.

The plugin contributes the `codex` runtime and a ready-to-use Codex agent profile. It connects to
the local `codex app-server`, forwards runtime events, and bridges permission requests.

## Development

```bash
pnpm --filter @zclaudia/plugin-codex test
pnpm --filter @zclaudia/plugin-codex build
```

Add this package directory to ZClaudia's plugin directories after building it.
