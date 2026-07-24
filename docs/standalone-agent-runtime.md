# Standalone Agent Runtime

## Goal

Make every agent plugin runnable and debuggable without launching ZClaudia while preserving the
same public plugin entrypoint, adapter contract, provider event stream, permission callback, and
MCP injection path used by the application host.

The reusable runtime and bridge implementations live in independent repositories. This repository
owns the agent plugins and the `agent-dev` executable that consumes them.

## Boundaries

The standalone implementation is split across two independent packages and one workspace package:

| Package                       | Location                                                                               | Responsibility                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@zclaudia/agent-runtime`     | [`zclaudia-agent-runtime`](https://github.com/zclaudia/zclaudia-agent-runtime)         | Plugin activation, provider event normalization, run/session state, permission lifecycle, resume, abort, and traces |
| `@zclaudia/agent-tool-bridge` | [`zclaudia-agent-tool-bridge`](https://github.com/zclaudia/zclaudia-agent-tool-bridge) | Authenticated loopback tool service and provider-launched MCP stdio proxy                                           |
| `@zclaudia/agent-dev`         | This repository                                                                        | Human and JSONL CLI host, file-backed sessions, terminal permissions, debug tools, and conformance checks           |

Agent packages continue to depend only on `@zclaudia/plugin-sdk`. The runtime and tool bridge do
not import ZClaudia application modules.

The portable runtime stops at provider-neutral events and host ports. The following stay in the
application:

- SQLite message and project persistence
- workspace prompt and memory assembly
- compaction and title generation
- permission policy, AI review, and workflow escalation
- WebSocket messages and desktop projections
- notifications and background follow-up coordination

## Runtime flow

```text
plugin.json -> plugin main.activate() -> ExternalAgentAdapter
                                            |
                                            v
                                  ProviderRuntimeEvent
                                            |
                                  canonical normalizer
                                            |
                                            v
                                    AgentRuntimeEvent
                                      /     |      \
                              terminal    JSONL   conformance
```

Legacy provider event names are normalized once at the runtime boundary:

| Legacy        | Canonical                |
| ------------- | ------------------------ |
| `assistant`   | `assistant_delta`        |
| `tool_use`    | `tool_started`           |
| `tool_result` | `tool_finished`          |
| `result`      | `provider_turn_finished` |
| `error`       | `provider_error`         |

An unknown event or a stream that ends without a terminal event fails in strict mode. Compatibility
mode can synthesize completion for providers that intentionally close a stream without a terminal
record.

## Tool bridge

The tool bridge consists of:

1. a host-owned HTTP server bound to `127.0.0.1` on an ephemeral port;
2. a random bearer token required for every request;
3. a provider-launched MCP stdio proxy;
4. a `ToolCatalog` port implemented by the host.

The CLI host exposes harmless debug tools by default. A future ZClaudia host adapter can implement
the same catalog port using its plugin tool registry. The portable bridge does not know about
ZClaudia HTTP routes, databases, or server ports.

Long-lived hosts use one `createPortableToolBridgeHost` instance and call `createEntry` for each
session. The bearer token and loopback listener are shared, while the session ID stays isolated in
the provider process environment.

## CLI

Build and inspect a plugin:

```bash
pnpm agent:dev inspect agents/codex
```

Run one turn:

```bash
pnpm agent:dev run agents/codex \
  --cwd /path/to/project \
  --input "Inspect the current changes" \
  --permission ask \
  --bridge debug
```

Keep a resumable terminal conversation:

```bash
pnpm agent:dev chat agents/claude --cwd /path/to/project
```

Useful flags:

- `--raw`: include raw provider events in the human renderer.
- `--jsonl`: emit only versioned `AgentRuntimeEvent` JSON lines.
- `--permission ask|allow|deny`: choose the permission host.
- `--bridge none|debug`: disable or enable the standalone MCP bridge.
- `--session <id>`: choose the host session key used for provider resume state.
- `--state-dir <path>`: isolate file-backed runtime state.
- `--end-policy fail|complete`: choose behavior for a non-terminal stream end.

## Verification ladder

1. Unit tests use fake adapters and tool catalogs.
2. Plugin loader tests activate a fixture through `plugin.json`.
3. CLI conformance mode checks activation, init, streaming, terminal state, and session persistence.
4. Live provider smoke tests are opt-in because they require installed and authenticated CLIs.

## ZClaudia integration seams

The ZClaudia host consumes the same runtime contracts through these seams:

1. `server/src/infra/providers/external-agent-shim.ts` is the adapter boundary. Normalize external
   plugin events here, or immediately before the application stream consumer, so every downstream
   consumer sees one canonical vocabulary.
2. `server/src/application/conversation/runtime/run-events.ts` currently terminates on legacy
   `result` and `error` events, while `provider-event-translator.ts` already understands both legacy
   and canonical names. Until the host is changed, a canonical `provider_error` can fall through
   and be treated as an ended stream. This must be corrected before switching the application to
   the portable normalizer.
3. `server/src/application/conversation/runtime/consume-provider-stream.ts` currently synthesizes
   success when a stream ends without a terminal event. The standalone runtime deliberately fails
   by default and exposes an opt-in degraded-completion policy. The application must make this
   policy choice explicitly during integration.
4. `server/src/application/plugins/plugin-context.ts` currently creates a ZClaudia-specific MCP
   entry. Adapt `server/src/application/plugins/tool-registry.ts` to the portable `ToolCatalog`
   port, preserving tool scopes, plugin permission checks, and session context.
5. Once that catalog adapter is proven, replace the duplicate bridge launcher and stdio proxy in
   `server/src/utils/mcp-bridge-launch.ts` and
   `server/src/application/plugins/mcp-bridge.ts`.
6. Keep package versions aligned between the application and this repository.
