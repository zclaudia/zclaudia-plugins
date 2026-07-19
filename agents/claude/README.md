# @zclaudia/plugin-claude

Claude Agent SDK runtime plugin for ZClaudia.

The plugin contributes the `claude` runtime and a ready-to-use Claude agent profile. It uses the
Claude Agent SDK and respects ZClaudia permission modes.

## Development

```bash
pnpm --filter @zclaudia/plugin-claude test
pnpm --filter @zclaudia/plugin-claude build
```

Add this package directory to ZClaudia's plugin directories after building it.
