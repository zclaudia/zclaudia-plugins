import { existsSync } from 'fs';
import path from 'path';

/**
 * Resolve the codex CLI executable.
 * If an explicit path is provided, it is returned.
 * Otherwise, it searches for 'codex' (or 'codex.exe' on Windows) in the PATH.
 */
export function resolveCodexCli(explicitPath?: string): string | undefined {
  if (explicitPath) {
    return explicitPath;
  }

  const pathEnv = process.env.PATH ?? '';
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, executableName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
