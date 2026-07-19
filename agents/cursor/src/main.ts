import type { PluginContext } from '@zclaudia/plugin-sdk/runtime';
import { CursorAgentAdapter } from './adapter.js';

export async function activate(context: PluginContext): Promise<void> {
  if (!context.agentRuntimes) {
    context.log.error('provider.register permission missing; cannot register cursor runtime');
    return;
  }
  const adapter = new CursorAgentAdapter(req => context.agentRuntimes!.createToolBridge(req));
  context.agentRuntimes.register(adapter);
}

export async function deactivate(): Promise<void> {
  // Loader unregisters contributions.
}
