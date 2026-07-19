# @zclaudia/plugin-cursor

Cursor Agent CLI runtime plugin for ZClaudia.

The plugin contributes the `cursor` runtime and a ready-to-use Cursor agent profile. It connects
to the local `cursor-agent` executable and injects the ZClaudia MCP bridge into the project.

## Development

```bash
pnpm --filter @zclaudia/plugin-cursor test
pnpm --filter @zclaudia/plugin-cursor build
```

Add this package directory to ZClaudia's plugin directories after building it.
