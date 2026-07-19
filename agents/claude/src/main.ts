import type { PluginContext } from '@zclaudia/plugin-sdk/runtime';
import { ClaudeAgentAdapter } from './adapter.js';

export async function activate(context: PluginContext): Promise<void> {
  if (!context.agentRuntimes) {
    context.log.error('provider.register permission missing; cannot register claude runtime');
    return;
  }
  const adapter = new ClaudeAgentAdapter(req => context.agentRuntimes!.createToolBridge(req));
  context.agentRuntimes.register(adapter);
}

export async function deactivate(): Promise<void> {
  // Adapter + descriptor are removed by the loader's unregisterContributions.
}
