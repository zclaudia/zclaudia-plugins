import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CursorMcpBridge {
  name: string;
  config: unknown;
}

export type InjectResult =
  | { ok: true; cleanup: () => void; injected: boolean; injectedNames: string[] }
  | { ok: false; reason: string };

export function injectCursorMcpBridge(cwd: string, bridge: CursorMcpBridge): InjectResult {
  const mcpJsonPath = path.join(cwd, '.cursor', 'mcp.json');
  const fileExisted = existsSync(mcpJsonPath);
  let originalRaw: string | undefined;
  let config: Record<string, unknown> = {};
  try {
    if (fileExisted) {
      originalRaw = readFileSync(mcpJsonPath, 'utf8');
      config = JSON.parse(originalRaw) as Record<string, unknown>;
    }
  } catch {
    config = {};
  }

  const mcpServers = {
    ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}),
  };
  if (mcpServers[bridge.name]) {
    // User (or prior) entry wins.
    return { ok: true, cleanup: () => {}, injected: false, injectedNames: [] };
  }
  mcpServers[bridge.name] = bridge.config;
  config.mcpServers = mcpServers;

  try {
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    const injectedRaw = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(mcpJsonPath, injectedRaw);
    return {
      ok: true,
      injected: true,
      injectedNames: [bridge.name],
      cleanup: () => {
        cleanupInjectedBridge({
          bridge,
          fileExisted,
          injectedRaw,
          mcpJsonPath,
          originalRaw,
        });
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

function cleanupInjectedBridge(input: {
  bridge: CursorMcpBridge;
  fileExisted: boolean;
  injectedRaw: string;
  mcpJsonPath: string;
  originalRaw?: string;
}): void {
  try {
    if (!existsSync(input.mcpJsonPath)) return;
    const currentRaw = readFileSync(input.mcpJsonPath, 'utf8');
    if (currentRaw === input.injectedRaw) {
      if (input.fileExisted && input.originalRaw !== undefined) {
        writeFileSync(input.mcpJsonPath, input.originalRaw);
      } else {
        unlinkSync(input.mcpJsonPath);
      }
      return;
    }

    // Preserve changes made by Cursor or the user during the run. Remove only
    // the exact bridge entry that this invocation injected.
    const current = JSON.parse(currentRaw) as Record<string, unknown>;
    const servers = {
      ...((current.mcpServers as Record<string, unknown> | undefined) ?? {}),
    };
    if (JSON.stringify(servers[input.bridge.name]) !== JSON.stringify(input.bridge.config)) return;
    delete servers[input.bridge.name];
    current.mcpServers = servers;
    writeFileSync(input.mcpJsonPath, `${JSON.stringify(current, null, 2)}\n`);
  } catch (error) {
    console.error(
      `[Cursor SDK] Failed to clean up MCP bridge: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Approve injected servers in cursor-agent's per-project approved list.
 * Servers in `.cursor/mcp.json` are not loaded until approved, and the
 * approval is keyed on the server config, so a changed bridge URL (the
 * daemon mints a new capability secret per lifetime) must be re-approved.
 * Only the entries this run injected are approved — a user's own servers
 * keep their existing approval state. Failures are non-fatal: the run
 * proceeds without the bridge tools, matching today's unapproved behavior.
 */
export async function approveCursorMcpServers(input: {
  binary: string;
  cwd: string;
  names: string[];
}): Promise<void> {
  await Promise.all(
    input.names.map(async name => {
      try {
        await execFileAsync(input.binary, ['mcp', 'enable', name], {
          cwd: input.cwd,
          timeout: 15_000,
        });
      } catch (error) {
        console.error(
          `[Cursor SDK] Failed to approve MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );
}
