import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateRuntimeManifest } from './runtime-conformance.mjs';

export const RUNTIME_COMPATIBILITY_FILE = 'runtime-compatibility.json';
export const RUNTIME_COMPATIBILITY_SCHEMA_VERSION = 1;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const MANAGED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
]);

function assert(condition, message) {
  if (!condition) throw new Error(`Runtime compatibility configuration is invalid: ${message}`);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(entry => typeof entry === 'string' && entry.length > 0)
  );
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match)
    throw new Error(`Cannot compare unrecognized CLI version ${JSON.stringify(version)}.`);
  return match.slice(1).map(Number);
}

function assertSafeRelativePath(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} must be a string.`);
  assert(!value.includes('\\') && !value.includes('\0'), `${label} is unsafe.`);
  assert(!path.posix.isAbsolute(value), `${label} must be relative.`);
  const parts = value.split('/');
  assert(
    parts.every(part => part !== '' && part !== '.' && part !== '..'),
    `${label} is unsafe.`
  );
  assert(!/^[A-Za-z]:/.test(parts[0]), `${label} is unsafe.`);
}

function validateAuthProbe(authProbe, label) {
  assert(
    authProbe && typeof authProbe === 'object' && !Array.isArray(authProbe),
    `${label} must be an object.`
  );
  assert(isStringArray(authProbe.args), `${label}.args must be a string array.`);
  if (authProbe.timeoutMs !== undefined) {
    assert(
      Number.isSafeInteger(authProbe.timeoutMs) && authProbe.timeoutMs > 0,
      `${label}.timeoutMs must be a positive integer.`
    );
  }
  if (authProbe.successExitCodes !== undefined) {
    assert(
      Array.isArray(authProbe.successExitCodes) &&
        authProbe.successExitCodes.length > 0 &&
        authProbe.successExitCodes.every(Number.isSafeInteger),
      `${label}.successExitCodes must be a non-empty integer array.`
    );
  }
  for (const key of ['authenticatedPattern', 'unauthenticatedPattern']) {
    if (authProbe[key] === undefined) continue;
    assert(typeof authProbe[key] === 'string', `${label}.${key} must be a string.`);
    try {
      new RegExp(authProbe[key]);
    } catch {
      throw new Error(
        `Runtime compatibility configuration is invalid: ${label}.${key} is invalid.`
      );
    }
  }
}

function validateManagedUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Runtime compatibility configuration is invalid: ${label} is invalid.`);
  }
  assert(!url.username && !url.password, `${label} may not contain credentials.`);
  assert(
    url.protocol === 'https:' || url.protocol === 'http:',
    `${label} must use HTTPS or an enterprise HTTP mirror.`
  );
}

function validateManagedArtifact(artifact, label) {
  assert(
    artifact && typeof artifact === 'object' && !Array.isArray(artifact),
    `${label} must be an object.`
  );
  assert(typeof artifact.url === 'string' && artifact.url.length > 0, `${label}.url is required.`);
  validateManagedUrl(artifact.url, `${label}.url`);
  assert(
    typeof artifact.sha256 === 'string' && SHA256_PATTERN.test(artifact.sha256),
    `${label}.sha256 must be a 64-character SHA-256 digest.`
  );
  assert(
    ['raw', 'zip', 'tar.gz'].includes(artifact.archiveFormat),
    `${label}.archiveFormat must be raw, zip, or tar.gz.`
  );
  assertSafeRelativePath(artifact.executablePath, `${label}.executablePath`);
  if (artifact.size !== undefined) {
    assert(
      Number.isSafeInteger(artifact.size) && artifact.size > 0,
      `${label}.size must be a positive integer.`
    );
  }
  if (artifact.signature !== undefined) {
    const signature = artifact.signature;
    assert(
      signature && typeof signature === 'object' && !Array.isArray(signature),
      `${label}.signature must be an object.`
    );
    assert(signature.algorithm === 'ed25519', `${label}.signature.algorithm must be ed25519.`);
    assert(
      typeof signature.publicKey === 'string' && signature.publicKey.length > 0,
      `${label}.signature.publicKey is required.`
    );
    assert(
      typeof signature.value === 'string' && signature.value.length > 0,
      `${label}.signature.value is required.`
    );
  }
  if (artifact.provenance !== undefined) {
    const provenance = artifact.provenance;
    assert(
      provenance && typeof provenance === 'object' && !Array.isArray(provenance),
      `${label}.provenance must be an object.`
    );
    assert(
      typeof provenance.url === 'string' && provenance.url.length > 0,
      `${label}.provenance.url is required.`
    );
    validateManagedUrl(provenance.url, `${label}.provenance.url`);
    assert(
      typeof provenance.sha256 === 'string' && SHA256_PATTERN.test(provenance.sha256),
      `${label}.provenance.sha256 must be a 64-character SHA-256 digest.`
    );
    if (provenance.predicateType !== undefined) {
      assert(
        typeof provenance.predicateType === 'string',
        `${label}.provenance.predicateType must be a string.`
      );
    }
  }
}

function validateManagedInstall(managedInstall) {
  assert(
    managedInstall && typeof managedInstall === 'object' && !Array.isArray(managedInstall),
    'managedInstall must be an object.'
  );
  assert(Array.isArray(managedInstall.versions), 'managedInstall.versions must be an array.');
  const versions = new Set();
  for (const [index, entry] of managedInstall.versions.entries()) {
    const label = `managedInstall.versions[${index}]`;
    assert(
      entry && typeof entry === 'object' && !Array.isArray(entry),
      `${label} must be an object.`
    );
    assert(
      typeof entry.version === 'string' && VERSION_PATTERN.test(entry.version),
      `${label}.version must be semver.`
    );
    assert(!versions.has(entry.version), `${label}.version is duplicated.`);
    versions.add(entry.version);
    assert(
      entry.artifacts && typeof entry.artifacts === 'object' && !Array.isArray(entry.artifacts),
      `${label}.artifacts must be an object.`
    );
    for (const [platform, artifact] of Object.entries(entry.artifacts)) {
      assert(MANAGED_PLATFORM_KEYS.has(platform), `${label}.artifacts.${platform} is unsupported.`);
      validateManagedArtifact(artifact, `${label}.artifacts.${platform}`);
    }
    if (entry.authProbe !== undefined) {
      validateAuthProbe(entry.authProbe, `${label}.authProbe`);
    }
  }
  if (managedInstall.recommendedVersion !== undefined) {
    assert(
      typeof managedInstall.recommendedVersion === 'string' &&
        VERSION_PATTERN.test(managedInstall.recommendedVersion),
      'managedInstall.recommendedVersion must be semver.'
    );
    assert(
      versions.has(managedInstall.recommendedVersion),
      'managedInstall.recommendedVersion must name a declared version.'
    );
  }
  if (managedInstall.authProbe !== undefined) {
    validateAuthProbe(managedInstall.authProbe, 'managedInstall.authProbe');
  }
}

export function compareCliVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function validateRuntimeCompatibility(config, expectedRuntime) {
  assert(config && typeof config === 'object' && !Array.isArray(config), 'root must be an object.');
  assert(
    config.schemaVersion === RUNTIME_COMPATIBILITY_SCHEMA_VERSION,
    `schemaVersion must be ${RUNTIME_COMPATIBILITY_SCHEMA_VERSION}.`
  );
  assert(
    typeof config.runtime === 'string' && /^[a-zA-Z0-9_.-]+$/.test(config.runtime),
    'runtime must be a safe identifier.'
  );
  if (expectedRuntime)
    assert(config.runtime === expectedRuntime, 'runtime does not match the plugin id.');

  const executable = config.executable;
  assert(executable && typeof executable === 'object', 'executable must be an object.');
  assert(
    typeof executable.command === 'string' && /^[a-zA-Z0-9_.-]+$/.test(executable.command),
    'executable.command must be a safe command name.'
  );
  assert(
    isNonEmptyStringArray(executable.versionArgs),
    'executable.versionArgs must be a non-empty string array.'
  );
  if (executable.versionPattern !== undefined) {
    assert(
      typeof executable.versionPattern === 'string',
      'executable.versionPattern must be a string.'
    );
    try {
      new RegExp(executable.versionPattern);
    } catch {
      throw new Error(
        'Runtime compatibility configuration is invalid: executable.versionPattern is invalid.'
      );
    }
  }

  const probe = config.probe;
  assert(probe && typeof probe === 'object', 'probe must be an object.');
  assert(['command', 'json-rpc'].includes(probe.kind), 'probe.kind must be command or json-rpc.');
  assert(isNonEmptyStringArray(probe.args), 'probe.args must be a non-empty string array.');

  const policy = config.versionPolicy;
  if (policy !== undefined) {
    assert(
      policy && typeof policy === 'object' && !Array.isArray(policy),
      'versionPolicy must be an object.'
    );
    for (const key of ['minimum', 'testedMaximum']) {
      if (policy[key] !== undefined) {
        assert(
          typeof policy[key] === 'string' && VERSION_PATTERN.test(policy[key]),
          `versionPolicy.${key} must be semver.`
        );
      }
    }
    if (policy.knownIncompatible !== undefined) {
      assert(
        Array.isArray(policy.knownIncompatible) &&
          policy.knownIncompatible.every(version => VERSION_PATTERN.test(version)),
        'versionPolicy.knownIncompatible must contain semver versions.'
      );
    }
    if (policy.minimum && policy.testedMaximum) {
      assert(
        compareCliVersions(policy.minimum, policy.testedMaximum) <= 0,
        'versionPolicy.minimum must not exceed versionPolicy.testedMaximum.'
      );
    }
  }

  if (config.managedInstall !== undefined) validateManagedInstall(config.managedInstall);

  const distribution = config.distribution;
  assert(distribution && typeof distribution === 'object', 'distribution must be an object.');
  assert(
    typeof distribution.vendorDependencies === 'boolean',
    'distribution.vendorDependencies must be boolean.'
  );
  if (distribution.requiredRuntimePackages !== undefined) {
    assert(
      isNonEmptyStringArray(distribution.requiredRuntimePackages),
      'distribution.requiredRuntimePackages must be a non-empty string array.'
    );
  }

  const live = config.live;
  assert(live && typeof live === 'object', 'live must be an object.');
  assert(
    ['stream-json', 'json-rpc-turn'].includes(live.kind),
    'live.kind must be stream-json or json-rpc-turn.'
  );
  if (live.kind === 'stream-json') {
    assert(isStringArray(live.args), 'live.args must be a string array for stream-json.');
    assert(isStringArray(live.completionTypes), 'live.completionTypes must be a string array.');
  } else {
    assert(isStringArray(live.args), 'live.args must be a string array for json-rpc-turn.');
    assert(
      typeof live.prompt === 'string' && live.prompt.length > 0,
      'live.prompt must be a string for json-rpc-turn.'
    );
  }

  return config;
}

export async function readRuntimeCompatibility(pluginDirectory) {
  const file = path.join(pluginDirectory, RUNTIME_COMPATIBILITY_FILE);
  const config = JSON.parse(await readFile(file, 'utf8'));
  return validateRuntimeCompatibility(config);
}

export async function discoverRuntimePlugins(repoRoot) {
  const agentsRoot = path.join(repoRoot, 'agents');
  const entries = await readdir(agentsRoot, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(agentsRoot, entry.name);
    try {
      await access(path.join(directory, RUNTIME_COMPATIBILITY_FILE), constants.R_OK);
    } catch {
      continue;
    }
    const manifest = JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8'));
    const runtime = String(manifest.id || '').replace(/^com\.zclaudia\./, '');
    const compatibility = await readRuntimeCompatibility(directory);
    validateRuntimeCompatibility(compatibility, runtime);
    plugins.push({ directory, manifest, compatibility, runtime });
  }
  return plugins;
}

export function findExecutable(command, pathEnv = process.env.PATH, platform = process.platform) {
  if (!pathEnv) return undefined;
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const candidates =
    platform === 'win32'
      ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
      : [command];
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const executable = pathModule.join(directory, candidate);
      if (existsSync(executable)) return executable;
    }
  }
  return undefined;
}

async function resolveExecutable(command, explicitPath, pathEnv = process.env.PATH) {
  if (explicitPath) {
    try {
      await access(explicitPath, constants.X_OK);
      return explicitPath;
    } catch {
      return undefined;
    }
  }
  if (!pathEnv) return undefined;
  const candidates =
    process.platform === 'win32'
      ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
      : [command];
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const executable = path.join(directory, candidate);
      try {
        // eslint-disable-next-line no-await-in-loop
        await access(executable, constants.X_OK);
        return executable;
      } catch {
        // Try the next entry in PATH.
      }
    }
  }
  return undefined;
}

function testResult(id, status, message, details = {}) {
  return { id, status, message, ...details };
}

function boundedCollector(limit = 1024 * 1024) {
  let value = '';
  let truncated = false;
  return {
    append(chunk) {
      if (value.length >= limit) {
        truncated = true;
        return;
      }
      value += chunk.toString();
      if (value.length > limit) {
        value = value.slice(0, limit);
        truncated = true;
      }
    },
    value: () => value,
    truncated: () => truncated,
  };
}

export async function runCommand(executable, args, { cwd, env, timeoutMs = 5_000 } = {}) {
  return new Promise(resolve => {
    const stdout = boundedCollector();
    const stderr = boundedCollector();
    let settled = false;
    let timedOut = false;
    let child;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: stdout.value(),
        stderr: stderr.value(),
        outputTruncated: stdout.truncated() || stderr.truncated(),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGTERM');
      setTimeout(() => child?.kill('SIGKILL'), 500).unref();
    }, timeoutMs);
    try {
      child = spawn(executable, args, {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', stdout.append);
      child.stderr?.on('data', stderr.append);
      child.once('error', error => finish({ exitCode: null, error: error.message, timedOut }));
      child.once('close', (exitCode, signal) => finish({ exitCode, signal, timedOut }));
    } catch (error) {
      finish({
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
        timedOut,
      });
    }
  });
}

function extractVersion(config, output) {
  const pattern = config.executable.versionPattern
    ? new RegExp(config.executable.versionPattern, 'm')
    : /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;
  return pattern.exec(output)?.[1];
}

export function evaluateVersionPolicy(version, policy = {}) {
  if (!version) return { status: 'warning', message: 'The CLI version could not be parsed.' };
  if (policy.knownIncompatible?.includes(version)) {
    return { status: 'failed', message: `${version} is marked as known incompatible.` };
  }
  if (policy.minimum && compareCliVersions(version, policy.minimum) < 0) {
    return {
      status: 'failed',
      message: `${version} is older than required minimum ${policy.minimum}.`,
    };
  }
  if (policy.testedMaximum && compareCliVersions(version, policy.testedMaximum) > 0) {
    return {
      status: 'warning',
      message: `${version} is newer than tested maximum ${policy.testedMaximum}.`,
    };
  }
  return { status: 'passed', message: 'Version satisfies the declared policy.' };
}

async function probeJsonRpc(executable, args, timeoutMs) {
  return new Promise(resolve => {
    const stdout = boundedCollector();
    const stderr = boundedCollector();
    let child;
    let done = false;
    let timer;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.kill('SIGTERM');
      resolve({ ...result, stdout: stdout.value(), stderr: stderr.value() });
    };
    try {
      child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      let remainder = '';
      child.stdout?.on('data', chunk => {
        stdout.append(chunk);
        remainder += chunk.toString();
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message.id === 1 && message.result !== undefined) {
              finish({ ok: true, message: 'JSON-RPC initialize completed.' });
              return;
            }
            if (message.id === 1 && message.error) {
              finish({
                ok: false,
                message: `JSON-RPC initialize failed: ${message.error.message ?? 'unknown error'}.`,
              });
              return;
            }
          } catch {
            // app-server diagnostics may share stdout; ignore non-JSON lines.
          }
        }
      });
      child.stderr?.on('data', stderr.append);
      child.once('error', error => finish({ ok: false, message: error.message }));
      child.once('close', (exitCode, signal) =>
        finish({
          ok: false,
          message: `Process exited before initialize (code=${exitCode}, signal=${signal}).`,
        })
      );
      child.stdin?.write(
        `${JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'zclaudia-runtime-compat', version: '1' } },
        })}\n`
      );
      timer = setTimeout(
        () => finish({ ok: false, message: `JSON-RPC initialize timed out after ${timeoutMs}ms.` }),
        timeoutMs
      );
    } catch (error) {
      finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function runStreamJsonLive(executable, live, timeoutMs, cwd) {
  const result = await runCommand(executable, live.args, { cwd, timeoutMs });
  if (result.timedOut)
    return testResult('live.turn', 'failed', `Live turn timed out after ${timeoutMs}ms.`);
  if (result.error) return testResult('live.turn', 'failed', result.error);
  const events = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  if (result.exitCode !== 0) {
    return testResult('live.turn', 'failed', `Live turn exited ${result.exitCode}.`, {
      stderr: result.stderr,
    });
  }
  if (events.length === 0) {
    return testResult('live.turn', 'failed', 'Live turn produced no JSON stream events.');
  }
  if (!events.some(event => live.completionTypes.includes(event.type))) {
    return testResult(
      'live.turn',
      'failed',
      'Live turn did not produce its declared completion event.'
    );
  }
  return testResult('live.turn', 'passed', 'Live stream-json turn completed.');
}

async function runJsonRpcLiveTurn(executable, live, timeoutMs, cwd) {
  return new Promise(resolve => {
    const stderr = boundedCollector();
    let child;
    let done = false;
    let timer;
    let requestId = 0;
    let threadId;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.kill('SIGTERM');
      resolve(result);
    };
    const send = (method, params) => {
      const id = ++requestId;
      child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
      return id;
    };
    try {
      child = spawn(executable, live.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let remainder = '';
      let initializeId;
      let startThreadId;
      let startTurnId;
      child.stdout?.on('data', chunk => {
        remainder += chunk.toString();
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id === initializeId) {
            if (message.error)
              return finish(
                testResult(
                  'live.turn',
                  'failed',
                  `Initialize failed: ${message.error.message ?? 'unknown error'}.`
                )
              );
            startThreadId = send('thread/start', { cwd });
          } else if (message.id === startThreadId) {
            threadId = message.result?.thread?.id ?? message.result?.threadId;
            if (!threadId)
              return finish(
                testResult('live.turn', 'failed', 'thread/start did not return a thread id.')
              );
            startTurnId = send('turn/start', {
              threadId,
              input: [{ type: 'text', text: live.prompt }],
            });
          } else if (message.id === startTurnId && message.error) {
            return finish(
              testResult(
                'live.turn',
                'failed',
                `turn/start failed: ${message.error.message ?? 'unknown error'}.`
              )
            );
          } else if (message.method === 'turn/completed') {
            const status = message.params?.turn?.status ?? message.params?.status;
            if (status === 'completed') {
              return finish(testResult('live.turn', 'passed', 'Live JSON-RPC turn completed.'));
            }
            return finish(
              testResult(
                'live.turn',
                'failed',
                `Live JSON-RPC turn completed with status ${status ?? 'unknown'}.`
              )
            );
          } else if (message.method === 'turn/failed') {
            return finish(testResult('live.turn', 'failed', 'Live JSON-RPC turn failed.'));
          }
        }
      });
      child.stderr?.on('data', stderr.append);
      child.once('error', error => finish(testResult('live.turn', 'failed', error.message)));
      child.once('close', (exitCode, signal) =>
        finish(
          testResult(
            'live.turn',
            'failed',
            `Process exited before turn completion (code=${exitCode}, signal=${signal}).`,
            { stderr: stderr.value() }
          )
        )
      );
      initializeId = send('initialize', {
        clientInfo: { name: 'zclaudia-runtime-compat', version: '1' },
      });
      timer = setTimeout(
        () =>
          finish(testResult('live.turn', 'failed', `Live turn timed out after ${timeoutMs}ms.`)),
        timeoutMs
      );
    } catch (error) {
      finish(
        testResult('live.turn', 'failed', error instanceof Error ? error.message : String(error))
      );
    }
  });
}

async function runLiveProbe(executable, live, timeoutMs) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zclaudia-runtime-compat-'));
  try {
    if (live.kind === 'stream-json')
      return await runStreamJsonLive(executable, live, timeoutMs, directory);
    return await runJsonRpcLiveTurn(executable, live, timeoutMs, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function testRuntimeCompatibility(
  plugin,
  { executable: explicitPath, timeoutMs = 5_000, live = false } = {}
) {
  const { manifest, compatibility, runtime } = plugin;
  const results = validateRuntimeManifest(manifest, runtime);
  const executable = await resolveExecutable(compatibility.executable.command, explicitPath);
  if (!executable) {
    results.push(
      testResult(
        'cli.resolve',
        'failed',
        `${compatibility.executable.command} was not found on PATH${explicitPath ? ' at the supplied path' : ''}.`
      )
    );
    return buildCompatibilityResult(plugin, undefined, undefined, results, live);
  }
  results.push(
    testResult('cli.resolve', 'passed', `Resolved ${compatibility.executable.command}.`, {
      executable,
    })
  );

  const versionRun = await runCommand(executable, compatibility.executable.versionArgs, {
    timeoutMs,
  });
  if (versionRun.timedOut || versionRun.error || versionRun.exitCode !== 0) {
    results.push(
      testResult(
        'cli.version',
        'failed',
        versionRun.timedOut
          ? `Version command timed out after ${timeoutMs}ms.`
          : versionRun.error || `Version command exited ${versionRun.exitCode}.`,
        { stderr: versionRun.stderr }
      )
    );
    return buildCompatibilityResult(plugin, executable, undefined, results, live);
  }
  const version = extractVersion(compatibility, `${versionRun.stdout}\n${versionRun.stderr}`);
  if (!version) {
    results.push(
      testResult('cli.version', 'warning', 'CLI version could not be parsed.', {
        stdout: versionRun.stdout,
      })
    );
  } else {
    results.push(testResult('cli.version', 'passed', `Detected version ${version}.`, { version }));
    const policy = evaluateVersionPolicy(version, compatibility.versionPolicy);
    results.push(testResult('cli.version-policy', policy.status, policy.message));
  }

  if (compatibility.probe.kind === 'command') {
    const probe = await runCommand(executable, compatibility.probe.args, { timeoutMs });
    if (probe.timedOut || probe.error || probe.exitCode !== 0) {
      results.push(
        testResult(
          'cli.launch',
          'failed',
          probe.timedOut
            ? `CLI launch probe timed out after ${timeoutMs}ms.`
            : probe.error || `CLI launch probe exited ${probe.exitCode}.`,
          { stderr: probe.stderr }
        )
      );
    } else {
      results.push(testResult('cli.launch', 'passed', 'CLI launch probe completed.'));
    }
  } else {
    const probe = await probeJsonRpc(executable, compatibility.probe.args, timeoutMs);
    results.push(
      testResult(
        'cli.protocol',
        probe.ok ? 'passed' : 'failed',
        probe.message,
        probe.ok ? {} : { stderr: probe.stderr }
      )
    );
  }

  if (live) {
    const liveTimeout = Math.max(timeoutMs, 120_000);
    results.push(await runLiveProbe(executable, compatibility.live, liveTimeout));
  } else {
    results.push(
      testResult(
        'live.turn',
        'skipped',
        'Live turn is disabled. Re-run with --live to test authentication, network, and a real model turn.'
      )
    );
  }
  return buildCompatibilityResult(plugin, executable, version, results, live);
}

function buildCompatibilityResult(plugin, executable, version, results, live) {
  const failures = results.filter(result => result.status === 'failed');
  const warnings = results.filter(result => result.status === 'warning');
  const liveResult = results.find(result => result.id === 'live.turn');
  const state = failures.length
    ? 'incompatible'
    : live && liveResult?.status === 'passed'
      ? warnings.length
        ? 'certified-with-warning'
        : 'certified'
      : warnings.length
        ? 'probed-with-warning'
        : 'probed';
  return {
    plugin: {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      runtime: plugin.runtime,
      directory: plugin.directory,
    },
    cli: {
      command: plugin.compatibility.executable.command,
      executable,
      version,
    },
    state,
    certification: {
      live,
      scope: live
        ? 'The CLI completed the declared live turn in an isolated temporary workspace.'
        : 'Static contract, CLI version, and non-network launch/protocol probes only.',
      note: 'This report certifies the tested version/platform/capability envelope, not all future provider behavior.',
    },
    capabilities:
      plugin.manifest.contributes?.agentRuntimes?.find(item => item.type === plugin.runtime)
        ?.manifest?.capabilities ?? [],
    results,
  };
}

export function createCompatibilityReport(results, { live }) {
  const states = Object.fromEntries(
    ['certified', 'certified-with-warning', 'probed', 'probed-with-warning', 'incompatible'].map(
      state => [state, results.filter(result => result.state === state).length]
    )
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    mode: live ? 'live' : 'probe',
    summary: { total: results.length, states },
    results,
  };
}
