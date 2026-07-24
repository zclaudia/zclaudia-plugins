#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentRuntime,
  JsonFileAgentSessionStore,
  loadAgentPlugin,
  type AgentRunHandle,
  type AgentRuntimeEvent,
  type LoadedAgentPlugin,
} from '@zclaudia/agent-runtime';
import {
  createPortableToolBridgeHost,
  type PortableToolBridgeHost,
} from '@zclaudia/agent-tool-bridge';
import type {
  ProviderToolBridgeEntry,
  ProviderToolBridgeRequest,
} from '@zclaudia/plugin-sdk/providers';
import { createDebugToolCatalog } from './debug-tools.js';
import { EventRenderer } from './renderer.js';
import { agentDevUsage, parseAgentDevOptions, type AgentDevOptions } from './options.js';
import { TerminalPrompter } from './terminal.js';

async function main(): Promise<void> {
  let options: AgentDevOptions;
  try {
    options = parseAgentDevOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(agentDevUsage());
    process.exitCode = 2;
    return;
  }
  if (options.command === 'help') {
    process.stdout.write(agentDevUsage());
    return;
  }

  const bridgeManager = new DebugBridgeManager(options);
  let plugin: LoadedAgentPlugin | undefined;
  let prompter: TerminalPrompter | undefined;
  let activeHandle: AgentRunHandle | undefined;
  const onSignal = () => {
    if (activeHandle) {
      void activeHandle.abort('SIGINT');
    }
  };
  process.on('SIGINT', onSignal);

  try {
    if (options.command !== 'inspect') {
      await mkdir(options.stateDirectory, { recursive: true });
      // Set the isolated runtime directory before importing the plugin so
      // providers that resolve configuration at module load time also see it.
      process.env.AGENT_RUNTIME_DATA_DIR = options.stateDirectory;
      // Compatibility for existing plugin releases.
      process.env.ZCLAUDIA_DATA_DIR = options.stateDirectory;
    }

    plugin = await loadAgentPlugin(options.pluginDirectory!, {
      createToolBridge: request => bridgeManager.create(request),
    });
    if (options.command === 'inspect') {
      printInspection(plugin, options.jsonl);
      return;
    }

    const adapter = plugin.getAdapter(options.runtimeType);
    if (adapter.type === 'codex' && options.bridgeMode === 'debug') {
      process.stderr.write(
        '[agent-dev] warning: Codex debug bridge loading may add the isolated config directory to ~/.codex/config.toml trust settings.\n'
      );
    }
    const store = new JsonFileAgentSessionStore(path.join(options.stateDirectory, 'sessions.json'));
    const runtime = new AgentRuntime({ sessionStore: store });
    prompter = new TerminalPrompter();
    const renderer = new EventRenderer({
      jsonl: options.jsonl,
      showRaw: options.includeRawEvents,
      recordPath: options.recordPath,
    });
    const hostSessionId = options.hostSessionId ?? 'default';

    const runTurn = async (
      input: string
    ): Promise<{
      handle: AgentRunHandle;
      events: AgentRuntimeEvent[];
    }> => {
      const handle = runtime.start({
        adapter,
        input,
        cwd: options.cwd,
        hostSessionId,
        mode: options.mode,
        model: options.model,
        cliPath: options.cliPath,
        systemPrompt: options.systemPrompt,
        permissionHandler: prompter!.permissionHandler(options.permissionMode),
        streamEndPolicy: options.streamEndPolicy,
        includeRawEvents: options.includeRawEvents,
      });
      activeHandle = handle;
      const events: AgentRuntimeEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
        await renderer.render(event);
      }
      await handle.done;
      activeHandle = undefined;
      return { handle, events };
    };

    if (options.command === 'chat') {
      process.stderr.write(`[agent-dev] interactive ${adapter.type} chat; type /exit to quit\n`);
      while (true) {
        const input = (await prompter.question('> ')).trim();
        if (!input) continue;
        if (input === '/exit' || input === '/quit') break;
        const result = await runTurn(input);
        if (result.handle.state.status === 'failed') process.exitCode = 1;
      }
      return;
    }

    const result = await runTurn(options.input!);
    if (options.command === 'conformance') {
      const report = buildConformanceReport(result.events);
      const encoded = JSON.stringify(report, null, options.jsonl ? 0 : 2);
      process.stderr.write(`[conformance] ${encoded}\n`);
      if (!report.ok) process.exitCode = 1;
    } else if (result.handle.state.status !== 'completed') {
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', onSignal);
    prompter?.close();
    await plugin?.deactivate().catch(error => {
      process.stderr.write(`[agent-dev] deactivate failed: ${String(error)}\n`);
    });
    await bridgeManager.close();
  }
}

class DebugBridgeManager {
  private host?: PortableToolBridgeHost;

  constructor(private readonly options: AgentDevOptions) {}

  async create(request: ProviderToolBridgeRequest): Promise<ProviderToolBridgeEntry | null> {
    if (this.options.bridgeMode === 'none') return null;
    if (!this.host) {
      this.host = await createPortableToolBridgeHost({
        catalog: createDebugToolCatalog(),
      });
      process.stderr.write(`[agent-dev] debug MCP bridge ${this.host.url}\n`);
    }
    return this.host.createEntry({
      sessionId: request.sessionId ?? 'default',
    });
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    await host?.close();
  }
}

function printInspection(plugin: LoadedAgentPlugin, jsonl: boolean): void {
  const result = {
    plugin: {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      directory: plugin.directory,
    },
    runtimes: plugin.descriptors.map(descriptor => ({
      type: descriptor.type,
      label: descriptor.label,
      runtime: descriptor.manifest.runtime,
      capabilities: descriptor.manifest.capabilities,
      registered: plugin.adapters.has(descriptor.type),
    })),
  };
  process.stdout.write(`${JSON.stringify(result, null, jsonl ? 0 : 2)}\n`);
}

function buildConformanceReport(events: AgentRuntimeEvent[]): {
  ok: boolean;
  checks: Record<string, boolean>;
  errors: string[];
} {
  const terminalEvents = events.filter(
    event =>
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
  );
  const startedTools = new Set(
    events
      .filter(
        (event): event is Extract<AgentRuntimeEvent, { type: 'tool.started' }> =>
          event.type === 'tool.started'
      )
      .map(event => event.toolUseId)
  );
  const orphanFinishedTools = events
    .filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'tool.finished' }> =>
        event.type === 'tool.finished'
    )
    .filter(event => !startedTools.has(event.toolUseId));
  const errors = events
    .filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'runtime.diagnostic' }> =>
        event.type === 'runtime.diagnostic' && event.level === 'error'
    )
    .map(event => event.message);
  const checks = {
    runStarted: events.some(event => event.type === 'run.started'),
    exactlyOneTerminal: terminalEvents.length === 1,
    completed: terminalEvents[0]?.type === 'run.completed',
    providerSessionObserved: events.some(event => event.type === 'provider.session'),
    noUnknownEvents: errors.length === 0,
    toolResultsHaveStarts: orphanFinishedTools.length === 0,
  };
  if (orphanFinishedTools.length > 0) {
    errors.push(
      `Tool results without matching starts: ${orphanFinishedTools.map(event => event.toolUseId).join(', ')}`
    );
  }
  return { ok: Object.values(checks).every(Boolean), checks, errors };
}

void main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
