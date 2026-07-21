export const CLAUDE_CLI_COMPATIBILITY = Object.freeze({
  minimum: '2.1.140',
  testedMaximum: '2.1.141',
  knownIncompatible: [] as string[],
});

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Invalid Claude Code version: ${version}.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export type ClaudeCliCompatibilityResult =
  | { status: 'supported'; version: string }
  | { status: 'warning'; version: string; message: string }
  | { status: 'blocked'; version: string; message: string };

export function evaluateClaudeCliVersion(version: string): ClaudeCliCompatibilityResult {
  if (CLAUDE_CLI_COMPATIBILITY.knownIncompatible.includes(version)) {
    return {
      status: 'blocked',
      version,
      message: `Claude Code ${version} is known to be incompatible with this plugin. Upgrade or downgrade Claude Code.`,
    };
  }
  if (compareVersions(version, CLAUDE_CLI_COMPATIBILITY.minimum) < 0) {
    return {
      status: 'blocked',
      version,
      message: `Claude Code ${version} is too old. Install version ${CLAUDE_CLI_COMPATIBILITY.minimum} or newer.`,
    };
  }
  if (compareVersions(version, CLAUDE_CLI_COMPATIBILITY.testedMaximum) > 0) {
    return {
      status: 'warning',
      version,
      message: `Claude Code ${version} is newer than the tested maximum ${CLAUDE_CLI_COMPATIBILITY.testedMaximum}; continuing with an untested CLI version.`,
    };
  }
  return { status: 'supported', version };
}
