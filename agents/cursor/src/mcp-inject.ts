import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export interface CursorMcpBridge {
  name: string;
  config: unknown;
}

export type InjectResult = { ok: true } | { ok: false; reason: string };

export function injectCursorMcpBridge(cwd: string, bridge: CursorMcpBridge): InjectResult {
  const mcpJsonPath = path.join(cwd, '.cursor', 'mcp.json');
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(mcpJsonPath)) {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    config = {};
  }

  const mcpServers = {
    ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}),
  };
  if (mcpServers[bridge.name]) {
    // User (or prior) entry wins.
    return { ok: true };
  }
  mcpServers[bridge.name] = bridge.config;
  config.mcpServers = mcpServers;

  try {
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    writeFileSync(mcpJsonPath, `${JSON.stringify(config, null, 2)}\n`);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
