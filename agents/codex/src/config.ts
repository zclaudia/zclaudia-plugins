import {
  appendFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readFileSync,
  realpathSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderToolBridgeEntry } from '@zclaudia/plugin-sdk/providers';

// File-based debug log (stdout may be captured by host runtime)
export const DEBUG_LOG = '/tmp/codex-app-server-debug.log';
export function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    appendFileSync(DEBUG_LOG, line);
  } catch {
    /* ignore */
  }
  console.log(msg);
}

// ── claudia-plugins MCP tool name normalization ─────────────
// Plan mode tools are registered as MCP tools (snake_case) but run-handler
// expects PascalCase names matching Claude SDK's native tools.
export const CLAUDIA_TOOL_NAME_MAP: Record<string, string> = {
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
};

export function normalizeClaudiaToolName(namespace: string | undefined, name: string): string {
  if (namespace === 'claudia-plugins') {
    const mapped = CLAUDIA_TOOL_NAME_MAP[name];
    if (mapped) return mapped;
  }
  return namespace ? `mcp:${namespace}:${name}` : name || 'Unknown';
}

// ── Codex AppServer plan-mode semantics ──────────────────────
//
// Plan-mode is routed through the claudia-plugins MCP bridge above, but the
// downstream runtime and UI should not know that. The codex AppServer SDK
// tags its outgoing tool_use messages with the shared `toolSemantic` and
// emits a `mode_transition` event for the runtime to consume.

export function detectCodexToolSemantic(
  toolName: string
): 'plan_enter' | 'plan_proposal' | undefined {
  if (toolName === 'EnterPlanMode') return 'plan_enter';
  if (toolName === 'ExitPlanMode') return 'plan_proposal';
  return undefined;
}

export function deriveCodexModeTransition(
  toolName: string,
  input: unknown,
  sourceToolUseId: string | undefined
): { mode: string; reason: 'enter' | 'exit'; plan?: string; sourceToolUseId?: string } | undefined {
  if (toolName === 'EnterPlanMode') {
    return { mode: 'plan', reason: 'enter', sourceToolUseId };
  }
  if (toolName === 'ExitPlanMode') {
    const record =
      input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
    const plan = typeof record?.plan === 'string' ? (record.plan as string) : undefined;
    return { mode: 'default', reason: 'exit', plan, sourceToolUseId };
  }
  return undefined;
}

// ── Mode → sandbox/approval config args ──────────────────────
//
// NOTE: `sandbox_permissions` via `-c` has no effect in app-server mode
// (sandbox is always workspaceWrite). Keep approval requests enabled for every
// mode and make the decision in handleServerRequest so dynamic mode switches
// (for example EnterPlanMode during a bypass run) take effect immediately.

export function mapModeToConfigArgs(mode?: string): string[] {
  const args: string[] = [];
  switch (mode) {
    case 'plan':
      // Keep on-request; our approval handler will decline all writes
      args.push('-c', 'approval_policy="on-request"');
      break;
    case 'bypassPermissions':
      // Keep requests enabled; our handler auto-approves while this mode is active.
      args.push('-c', 'approval_policy="on-request"');
      break;
    case 'acceptEdits':
    case 'default':
    default:
      // Standard mode: approval requests forwarded to user
      args.push('-c', 'approval_policy="on-request"');
      break;
  }
  return args;
}

// ── Input preparation (phase 1: text-only) ───────────────────

export interface AppServerInputBlock {
  type: 'text';
  text: string;
}

export function prepareAppServerInput(rawInput: string): AppServerInputBlock[] {
  return [{ type: 'text', text: rawInput }];
}

// ── Inherited provider env sanitization (inlined from server) ──

const INHERITED_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'MODEL',
  'CLAUDE_MODEL',
  'CLAUDE_CODE_MODEL',
  'CODEX_MODEL',
  'CURSOR_MODEL',
  'KIMI_MODEL',
  'MINIMAX_MODEL',
  'MOONSHOT_MODEL',
] as const;

function sanitizeInheritedProviderEnv(env: Record<string, string>): void {
  for (const key of INHERITED_PROVIDER_ENV_KEYS) {
    delete env[key];
  }
}

// ── MCP config via stable app data cwd ───────────────────────

export function getCodexConfigDir(): string {
  const dataDir = process.env.ZCLAUDIA_DATA_DIR
    ? join(process.env.ZCLAUDIA_DATA_DIR)
    : join(homedir(), '.zclaudia');
  return join(dataDir, 'codex-config');
}

export function mcpServersToToml(mcpServers: Record<string, unknown>): string {
  return Object.entries(mcpServers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => {
      const cfg = config as Record<string, unknown>;
      const lines: string[] = [`[mcp_servers.${name}]`];
      if (cfg.command) lines.push(`command = ${JSON.stringify(cfg.command)}`);
      if (cfg.args && Array.isArray(cfg.args)) {
        lines.push(`args = ${JSON.stringify(cfg.args)}`);
      }
      if (cfg.env && typeof cfg.env === 'object') {
        lines.push(`[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(cfg.env as Record<string, string>).sort(([a], [b]) =>
          a.localeCompare(b)
        )) {
          lines.push(`${k} = ${JSON.stringify(v)}`);
        }
      }
      if (cfg.url) lines.push(`url = ${JSON.stringify(cfg.url)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function buildMcpConfigToml(bridge: ProviderToolBridgeEntry | null): string {
  if (!bridge) return '';
  return mcpServersToToml({ [bridge.name]: bridge.config });
}

export function upsertTrustedProjectConfig(existing: string, projectPath: string): string {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const sectionPattern = new RegExp(
    `(^|\\n)${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n(?:[^\\[][^\\n]*\\n?)*)?`,
    'm'
  );

  if (!sectionPattern.test(existing)) {
    const trimmed = existing.trimEnd();
    return `${trimmed ? `${trimmed}\n\n` : ''}${header}\ntrust_level = "trusted"\n`;
  }

  return existing.replace(sectionPattern, match => {
    if (/^\s*trust_level\s*=.*$/m.test(match)) {
      return match.replace(/^\s*trust_level\s*=.*$/m, 'trust_level = "trusted"');
    }
    return `${match.trimEnd()}\ntrust_level = "trusted"\n`;
  });
}

export function ensureCodexProjectTrusted(configDir: string): void {
  const userCodexConfigPath = join(homedir(), '.codex', 'config.toml');
  const trustPaths = new Set<string>([configDir]);

  try {
    trustPaths.add(realpathSync(configDir));
  } catch {
    // Best effort only; fall back to the original path.
  }

  let existing = '';
  if (existsSync(userCodexConfigPath)) {
    try {
      existing = readFileSync(userCodexConfigPath, 'utf-8');
    } catch (error) {
      debugLog(`[Codex AppServer] WARN: Failed to read user Codex config: ${error}`);
      return;
    }
  } else {
    mkdirSync(join(homedir(), '.codex'), { recursive: true });
  }

  let next = existing;
  for (const trustPath of trustPaths) {
    next = upsertTrustedProjectConfig(next, trustPath);
  }

  if (next !== existing) {
    try {
      writeFileSync(userCodexConfigPath, next, 'utf-8');
      debugLog(
        `[Codex AppServer] Trusted project for config loading: ${Array.from(trustPaths).join(', ')}`
      );
    } catch (error) {
      debugLog(`[Codex AppServer] WARN: Failed to update user Codex trust config: ${error}`);
    }
  }
}

/** Last written config content — skip redundant writes */
let lastWrittenConfig = '';

export function writeMcpConfig(bridge: ProviderToolBridgeEntry | null): {
  configDir: string;
  configSignature: string;
} {
  const configDir = getCodexConfigDir();
  try {
    mkdirSync(configDir, { recursive: true });
    ensureCodexProjectTrusted(configDir);
    const configToml = buildMcpConfigToml(bridge);

    if (configToml !== lastWrittenConfig) {
      const codexDir = join(configDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      const configPath = join(codexDir, 'config.toml');

      if (configToml) {
        writeFileSync(configPath, configToml, 'utf-8');
        debugLog(`[Codex AppServer] Wrote MCP config: ${configPath}`);
      } else if (existsSync(configPath)) {
        unlinkSync(configPath);
        debugLog(`[Codex AppServer] Removed MCP config: ${configPath}`);
      }
      lastWrittenConfig = configToml;
    }

    return { configDir, configSignature: configToml };
  } catch (error) {
    debugLog(`[Codex AppServer] WARN: Failed to write MCP config: ${error}`);
    return { configDir, configSignature: '' };
  }
}

export function buildEnv(options: {
  env?: Record<string, string>;
  claudiaSessionId?: string;
}): Record<string, string> {
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) mergedEnv[key] = value;
  }
  sanitizeInheritedProviderEnv(mergedEnv);
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      mergedEnv[key] = value;
    }
  }
  if (options.claudiaSessionId) {
    mergedEnv.CLAUDIA_SESSION_ID = options.claudiaSessionId;
    mergedEnv.ZCLAUDIA_SESSION_ID = options.claudiaSessionId;
  }
  return mergedEnv;
}
