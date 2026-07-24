import path from 'node:path';
import type { StreamEndPolicy } from '@zclaudia/agent-runtime';

export type AgentDevCommand = 'inspect' | 'run' | 'chat' | 'conformance' | 'help';
export type PermissionMode = 'ask' | 'allow' | 'deny';
export type BridgeMode = 'none' | 'debug';

export interface AgentDevOptions {
  command: AgentDevCommand;
  pluginDirectory?: string;
  runtimeType?: string;
  cwd: string;
  input?: string;
  hostSessionId?: string;
  mode?: string;
  model?: string;
  cliPath?: string;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  bridgeMode: BridgeMode;
  includeRawEvents: boolean;
  jsonl: boolean;
  stateDirectory: string;
  streamEndPolicy: StreamEndPolicy;
  recordPath?: string;
}

const VALUE_FLAGS = new Set([
  '--runtime',
  '--cwd',
  '--input',
  '--session',
  '--mode',
  '--model',
  '--cli-path',
  '--system-prompt',
  '--permission',
  '--bridge',
  '--state-dir',
  '--end-policy',
  '--record',
]);

export function parseAgentDevOptions(argv: string[], processCwd = process.cwd()): AgentDevOptions {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return defaults('help', processCwd);
  }
  const command = argv[0] as AgentDevCommand;
  if (!['inspect', 'run', 'chat', 'conformance'].includes(command)) {
    throw new Error(`Unknown command "${argv[0]}".`);
  }
  const result = defaults(command, processCwd);
  let index = 1;
  if (argv[index] && !argv[index].startsWith('-')) {
    result.pluginDirectory = path.resolve(processCwd, argv[index]);
    index += 1;
  }

  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--raw') {
      result.includeRawEvents = true;
      index += 1;
      continue;
    }
    if (flag === '--jsonl') {
      result.jsonl = true;
      index += 1;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown option "${flag}".`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value.`);
    applyValue(result, flag, value, processCwd);
    index += 2;
  }

  if (!result.pluginDirectory) {
    throw new Error(`${command} requires a plugin directory.`);
  }
  if ((command === 'run' || command === 'conformance') && !result.input) {
    throw new Error(`${command} requires --input.`);
  }
  return result;
}

function defaults(command: AgentDevCommand, processCwd: string): AgentDevOptions {
  return {
    command,
    cwd: processCwd,
    permissionMode: 'ask',
    bridgeMode: 'none',
    includeRawEvents: false,
    jsonl: false,
    stateDirectory: path.join(processCwd, '.agent-dev'),
    streamEndPolicy: 'fail',
  };
}

function applyValue(
  options: AgentDevOptions,
  flag: string,
  value: string,
  processCwd: string
): void {
  switch (flag) {
    case '--runtime':
      options.runtimeType = value;
      break;
    case '--cwd':
      options.cwd = path.resolve(processCwd, value);
      break;
    case '--input':
      options.input = value;
      break;
    case '--session':
      options.hostSessionId = value;
      break;
    case '--mode':
      options.mode = value;
      break;
    case '--model':
      options.model = value;
      break;
    case '--cli-path':
      options.cliPath = path.resolve(processCwd, value);
      break;
    case '--system-prompt':
      options.systemPrompt = value;
      break;
    case '--permission':
      if (!['ask', 'allow', 'deny'].includes(value)) {
        throw new Error('--permission must be ask, allow, or deny.');
      }
      options.permissionMode = value as PermissionMode;
      break;
    case '--bridge':
      if (!['none', 'debug'].includes(value)) {
        throw new Error('--bridge must be none or debug.');
      }
      options.bridgeMode = value as BridgeMode;
      break;
    case '--state-dir':
      options.stateDirectory = path.resolve(processCwd, value);
      break;
    case '--end-policy':
      if (!['fail', 'complete'].includes(value)) {
        throw new Error('--end-policy must be fail or complete.');
      }
      options.streamEndPolicy = value as StreamEndPolicy;
      break;
    case '--record':
      options.recordPath = path.resolve(processCwd, value);
      break;
  }
}

export function agentDevUsage(): string {
  return `Usage:
  pnpm agent:dev inspect <plugin-directory>
  pnpm agent:dev run <plugin-directory> --input <prompt> [options]
  pnpm agent:dev chat <plugin-directory> [options]
  pnpm agent:dev conformance <plugin-directory> --input <prompt> [options]

Options:
  --runtime <type>          Select a runtime when a plugin registers more than one
  --cwd <path>              Provider working directory (default: current directory)
  --session <id>            Stable host session key for resume (default: "default")
  --mode <mode>             Provider mode
  --model <model>           Provider-native model override
  --cli-path <path>         Provider CLI executable
  --system-prompt <text>    Additional system prompt
  --permission <mode>       ask, allow, or deny (default: ask)
  --bridge <mode>           none or debug (default: none)
  --state-dir <path>        Session/config state directory (default: .agent-dev)
  --end-policy <policy>     fail or complete for non-terminal stream end
  --raw                     Include raw provider events
  --jsonl                   Emit versioned runtime events as JSON lines
  --record <path>           Record runtime events as JSON lines
`;
}
