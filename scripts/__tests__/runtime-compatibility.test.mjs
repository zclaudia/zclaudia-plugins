import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareCliVersions,
  discoverRuntimePlugins,
  evaluateVersionPolicy,
  testRuntimeCompatibility,
  validateRuntimeCompatibility,
} from '../runtime-compatibility.mjs';
import { runAdapterConformanceSuite, validateRuntimeManifest } from '../runtime-conformance.mjs';

const capabilityIds = ['chat.stream', 'tool.call', 'permission.mode', 'session.abort'];

function fixtureManifest() {
  return {
    id: 'com.zclaudia.fixture',
    name: 'Fixture Agent',
    version: '1.0.0',
    contributes: {
      agentRuntimes: [
        {
          type: 'fixture',
          manifest: {
            capabilities: capabilityIds.map(id => ({ id, supported: true })),
          },
        },
      ],
    },
  };
}

function fixtureCompatibility() {
  return {
    schemaVersion: 1,
    runtime: 'fixture',
    executable: { command: 'node', versionArgs: ['--version'] },
    probe: { kind: 'command', args: ['--version'] },
    live: {
      kind: 'stream-json',
      args: ['--version'],
      completionTypes: ['result'],
    },
    distribution: { vendorDependencies: false },
  };
}

function fixtureManagedInstall() {
  return {
    recommendedVersion: '2.0.0',
    authProbe: {
      args: ['auth', 'status'],
      successExitCodes: [0],
      unauthenticatedPattern: 'login required',
    },
    versions: [
      {
        version: '1.9.0',
        artifacts: {
          'linux-x64': {
            url: 'https://downloads.example.invalid/fixture-1.9.0-linux-x64',
            sha256: '1'.repeat(64),
            archiveFormat: 'raw',
            executablePath: 'fixture',
          },
        },
      },
      {
        version: '2.0.0',
        authProbe: { args: ['whoami'], authenticatedPattern: 'fixture-user' },
        artifacts: Object.fromEntries(
          ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].map(platform => [
            platform,
            {
              url: `https://downloads.example.invalid/fixture-2.0.0-${platform}.zip`,
              sha256: '2'.repeat(64),
              archiveFormat: 'zip',
              executablePath: platform.startsWith('win32') ? 'bin/fixture.exe' : 'bin/fixture',
              size: 4096,
              signature: {
                algorithm: 'ed25519',
                publicKey: 'fixture-public-key',
                value: 'fixture-signature',
              },
              provenance: {
                url: `https://downloads.example.invalid/fixture-2.0.0-${platform}.intoto.jsonl`,
                sha256: '3'.repeat(64),
                predicateType: 'https://slsa.dev/provenance/v1',
              },
            },
          ])
        ),
      },
    ],
  };
}

describe('runtime compatibility configuration', () => {
  it('discovers and validates every repository runtime descriptor', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const runtimes = await discoverRuntimePlugins(repoRoot);
    const names = runtimes.map(runtime => runtime.runtime);
    expect(names).toEqual(expect.arrayContaining(['claude', 'codex', 'cursor']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('validates the extensible runtime descriptor', () => {
    expect(validateRuntimeCompatibility(fixtureCompatibility(), 'fixture').runtime).toBe('fixture');
  });

  it('requires a live test declaration', () => {
    const descriptor = fixtureCompatibility();
    delete descriptor.live;
    expect(() => validateRuntimeCompatibility(descriptor, 'fixture')).toThrow(
      /live must be an object/i
    );
  });

  it('accepts backward-compatible managed install metadata with multiple platforms', () => {
    const descriptor = fixtureCompatibility();
    descriptor.managedInstall = fixtureManagedInstall();
    expect(validateRuntimeCompatibility(descriptor, 'fixture').managedInstall).toEqual(
      descriptor.managedInstall
    );
  });

  it('rejects unsafe or unverifiable managed artifacts', () => {
    const invalidHash = fixtureCompatibility();
    invalidHash.managedInstall = fixtureManagedInstall();
    invalidHash.managedInstall.versions[0].artifacts['linux-x64'].sha256 = 'not-a-sha';
    expect(() => validateRuntimeCompatibility(invalidHash, 'fixture')).toThrow(/sha256/i);

    const traversal = fixtureCompatibility();
    traversal.managedInstall = fixtureManagedInstall();
    traversal.managedInstall.versions[0].artifacts['linux-x64'].executablePath = '../fixture';
    expect(() => validateRuntimeCompatibility(traversal, 'fixture')).toThrow(/unsafe/i);

    const unknownPlatform = fixtureCompatibility();
    unknownPlatform.managedInstall = fixtureManagedInstall();
    unknownPlatform.managedInstall.versions[0].artifacts['freebsd-x64'] =
      unknownPlatform.managedInstall.versions[0].artifacts['linux-x64'];
    expect(() => validateRuntimeCompatibility(unknownPlatform, 'fixture')).toThrow(/unsupported/i);

    const unsafeUrl = fixtureCompatibility();
    unsafeUrl.managedInstall = fixtureManagedInstall();
    unsafeUrl.managedInstall.versions[0].artifacts['linux-x64'].url = 'file:///tmp/fixture';
    expect(() => validateRuntimeCompatibility(unsafeUrl, 'fixture')).toThrow(/must use HTTPS/i);
  });

  it('requires recommendedVersion to select a declared managed version', () => {
    const descriptor = fixtureCompatibility();
    descriptor.managedInstall = fixtureManagedInstall();
    descriptor.managedInstall.recommendedVersion = '9.0.0';
    expect(() => validateRuntimeCompatibility(descriptor, 'fixture')).toThrow(
      /must name a declared version/i
    );
  });

  it('compares versions and flags future untested versions', () => {
    expect(compareCliVersions('2.1.140', '2.1.141')).toBeLessThan(0);
    expect(evaluateVersionPolicy('2.1.181', { testedMaximum: '2.1.141' }).status).toBe('warning');
    expect(evaluateVersionPolicy('2.1.100', { minimum: '2.1.140' }).status).toBe('failed');
  });
});

describe('shared runtime conformance suite', () => {
  it('validates public capability declarations', () => {
    expect(validateRuntimeManifest(fixtureManifest(), 'fixture')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'manifest.capabilities', status: 'passed' }),
      ])
    );
  });

  it('accepts a complete normalized adapter stream', async () => {
    const adapter = {
      async *run() {
        yield { type: 'init', sessionId: 'fixture-session' };
        yield { type: 'assistant_delta', content: 'hello' };
        yield { type: 'provider_turn_finished', isComplete: true };
      },
    };
    const suite = await runAdapterConformanceSuite({
      adapter,
      input: 'hello',
      context: { cwd: '/fixture' },
    });
    expect(suite.passed).toBe(true);
  });

  it('rejects output after completion', async () => {
    const adapter = {
      async *run() {
        yield { type: 'init', sessionId: 'fixture-session' };
        yield { type: 'provider_turn_finished', isComplete: true };
        yield { type: 'assistant', content: 'too late' };
      },
    };
    const suite = await runAdapterConformanceSuite({
      adapter,
      input: 'hello',
      context: { cwd: '/fixture' },
    });
    expect(suite.passed).toBe(false);
    expect(suite.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'stream.ordering', status: 'failed' })])
    );
  });
});

describe('non-network compatibility probe', () => {
  it('reports a discovered CLI as probed without claiming live certification', async () => {
    const manifest = fixtureManifest();
    const compatibility = fixtureCompatibility();
    const result = await testRuntimeCompatibility(
      { directory: '/fixture', manifest, compatibility, runtime: 'fixture' },
      { executable: process.execPath }
    );
    expect(result.state).toBe('probed');
    expect(result.cli.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'live.turn', status: 'skipped' })])
    );
  });

  it('certifies a deterministic stream-json live turn', async () => {
    const manifest = fixtureManifest();
    const compatibility = fixtureCompatibility();
    compatibility.live.args = [
      '--input-type=module',
      '--eval',
      "console.log(JSON.stringify({ type: 'result' }));",
    ];
    const result = await testRuntimeCompatibility(
      { directory: '/fixture', manifest, compatibility, runtime: 'fixture' },
      { executable: process.execPath, live: true }
    );
    expect(result.state).toBe('certified');
    expect(result.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'live.turn', status: 'passed' })])
    );
  });

  it('certifies a deterministic JSON-RPC live turn', async () => {
    const manifest = fixtureManifest();
    const jsonRpcFixture = [
      "process.stdin.setEncoding('utf8');",
      "let remainder = '';",
      "process.stdin.on('data', chunk => {",
      '  remainder += chunk;',
      '  const lines = remainder.split(/\\n/);',
      "  remainder = lines.pop() ?? '';",
      '  for (const line of lines) {',
      '    if (!line) continue;',
      '    const message = JSON.parse(line);',
      "    if (message.method === 'initialize') {",
      '      console.log(JSON.stringify({ id: message.id, result: {} }));',
      "    } else if (message.method === 'thread/start') {",
      "      console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'fixture-thread' } } }));",
      "    } else if (message.method === 'turn/start') {",
      '      console.log(JSON.stringify({ id: message.id, result: {} }));',
      "      console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));",
      '    }',
      '  }',
      '});',
    ].join('\n');
    const compatibility = fixtureCompatibility();
    compatibility.probe = {
      kind: 'json-rpc',
      args: ['--input-type=module', '--eval', jsonRpcFixture],
    };
    compatibility.live = {
      kind: 'json-rpc-turn',
      args: ['--input-type=module', '--eval', jsonRpcFixture],
      prompt: 'fixture prompt',
    };
    const result = await testRuntimeCompatibility(
      { directory: '/fixture', manifest, compatibility, runtime: 'fixture' },
      { executable: process.execPath, live: true }
    );
    expect(result.state).toBe('certified');
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'cli.protocol', status: 'passed' }),
        expect.objectContaining({ id: 'live.turn', status: 'passed' }),
      ])
    );
  });
});
