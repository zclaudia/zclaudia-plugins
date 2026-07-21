import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { evaluateClaudeCliVersion, type ClaudeCliCompatibilityResult } from './compatibility.js';

export interface ResolveClaudeCliOptions {
  /** Platform to resolve for; defaults to the current process platform. */
  platform?: NodeJS.Platform;
  /** File-existence predicate; injectable for testing. Defaults to fs.existsSync. */
  exists?: (candidate: string) => boolean;
}

/**
 * Locate a `claude` executable on the given PATH string, mimicking how a shell
 * would resolve the command: scan directories in order and return the first
 * matching executable. Returns undefined when none is found; the runtime must
 * then report that the host CLI is required.
 */
export function resolveClaudeCliFromPath(
  pathEnv: string | undefined,
  options: ResolveClaudeCliOptions = {}
): string | undefined {
  if (!pathEnv) return undefined;

  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const isWindows = platform === 'win32';
  // Resolve joins/delimiters for the target platform, not the host running this code.
  const pathMod = isWindows ? path.win32 : path.posix;
  const delimiter = isWindows ? ';' : ':';
  // On Windows a bare `claude` may be shipped as .exe/.cmd/.bat; prefer .exe.
  const candidates = isWindows ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      const full = pathMod.join(dir, name);
      if (exists(full)) return full;
    }
  }

  return undefined;
}

interface VersionCommandResult {
  error?: Error;
  status: number | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
}

export interface InspectClaudeCliOptions {
  env?: NodeJS.ProcessEnv;
  run?: (executable: string, args: string[]) => VersionCommandResult;
}

const compatibilityCache = new Map<string, ClaudeCliCompatibilityResult>();

export function parseClaudeCliVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/.exec(output)?.[1];
}

export function inspectClaudeCli(
  executable: string,
  options: InspectClaudeCliOptions = {}
): ClaudeCliCompatibilityResult {
  if (!options.run) {
    const cached = compatibilityCache.get(executable);
    if (cached) return cached;
  }
  const result = options.run
    ? options.run(executable, ['--version'])
    : spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        env: options.env ?? process.env,
        timeout: 5_000,
      });
  if (result.error) {
    throw new Error(`Unable to run Claude Code CLI at ${executable}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = String(result.stderr ?? result.stdout ?? '').trim();
    throw new Error(
      `Unable to read the Claude Code CLI version at ${executable}${details ? `: ${details}` : '.'}`
    );
  }
  const version = parseClaudeCliVersion(
    `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
  );
  if (!version) {
    throw new Error(`Claude Code CLI at ${executable} returned an unrecognized version.`);
  }
  const compatibility = evaluateClaudeCliVersion(version);
  if (!options.run) compatibilityCache.set(executable, compatibility);
  return compatibility;
}
