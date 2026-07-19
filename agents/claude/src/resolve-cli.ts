import { existsSync } from 'fs';
import path from 'path';

export interface ResolveClaudeCliOptions {
  /** Platform to resolve for; defaults to the current process platform. */
  platform?: NodeJS.Platform;
  /** File-existence predicate; injectable for testing. Defaults to fs.existsSync. */
  exists?: (candidate: string) => boolean;
}

/**
 * Locate a `claude` executable on the given PATH string, mimicking how a shell
 * would resolve the command: scan directories in order and return the first
 * matching executable. Returns undefined when none is found so callers can fall
 * back to the SDK-bundled binary.
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
