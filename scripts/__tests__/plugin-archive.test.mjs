import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeterministicZip, readZip } from '../plugin-archive.mjs';
import { validatePlugin } from '../plugin-validation.mjs';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'zclaudia-packaging-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  );
});

async function createFixture() {
  const directory = await temporaryDirectory();
  await mkdir(path.join(directory, 'dist'));
  await writeFile(
    path.join(directory, 'plugin.json'),
    JSON.stringify({
      id: 'com.zclaudia.codex',
      name: 'Codex Agent',
      version: '1.2.3',
      main: 'dist/main.js',
      executionMode: 'main',
    })
  );
  await writeFile(
    path.join(directory, 'runtime-compatibility.json'),
    JSON.stringify({
      schemaVersion: 1,
      runtime: 'codex',
      executable: { command: 'codex', versionArgs: ['--version'] },
      probe: { kind: 'command', args: ['--help'] },
      live: {
        kind: 'json-rpc-turn',
        args: ['app-server', '--listen', 'stdio://'],
        prompt: 'compatibility test',
      },
      distribution: { vendorDependencies: false },
    })
  );
  await writeFile(
    path.join(directory, 'dist', 'main.js'),
    'export default function activate() {}\n'
  );
  await writeFile(path.join(directory, 'README.md'), '# fixture\n');
  await writeFile(path.join(directory, 'LICENSE'), 'MIT\n');
  return directory;
}

describe('plugin archives', () => {
  it('creates byte-for-byte deterministic archives and validates them', async () => {
    const fixture = await createFixture();
    const first = path.join(await temporaryDirectory(), 'first.zplugin');
    const second = path.join(await temporaryDirectory(), 'second.zplugin');
    await createDeterministicZip(fixture, first);
    await createDeterministicZip(fixture, second);
    expect(await readFile(first)).toEqual(await readFile(second));
    const validation = await validatePlugin(first);
    expect(validation.manifest.id).toBe('com.zclaudia.codex');
    expect(validation.fileCount).toBe(5);
  });

  it('rejects an archive with a traversal entry', async () => {
    const fixture = await createFixture();
    const archive = path.join(await temporaryDirectory(), 'fixture.zplugin');
    await createDeterministicZip(fixture, archive);
    const bytes = await readFile(archive);
    const name = Buffer.from('README.md');
    const replacement = Buffer.from('../x/y.md');
    for (let offset = 0; offset <= bytes.length - name.length; offset += 1) {
      if (bytes.subarray(offset, offset + name.length).equals(name))
        replacement.copy(bytes, offset);
    }
    await writeFile(archive, bytes);
    await expect(readZip(archive)).rejects.toThrow('Unsafe archive path');
  });
});
