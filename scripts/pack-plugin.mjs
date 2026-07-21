#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { createDeterministicZip, deterministicTimestamp, extractZip } from './plugin-archive.mjs';
import { validatePlugin } from './plugin-validation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts');
const stagingRoot = path.join(artifactsRoot, 'staging');
const releaseRoot = path.join(artifactsRoot, 'release');
const supportedAgents = ['claude', 'codex', 'cursor'];
const runtimeDistExtensions = new Set(['.cjs', '.js', '.json', '.mjs']);
const requiredExecutables = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
};

function usage() {
  console.error('Usage: pnpm pack:plugin <claude|codex|cursor> [--skip-checks]');
  console.error('       pnpm pack:plugins');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}.${details}`
    );
  }
  return result.stdout?.trim() ?? '';
}

function pnpm(args, options) {
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, options);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function assertSourceMetadata(agent, packageJson, manifest) {
  if (packageJson.version !== manifest.version) {
    throw new Error(
      `${agent}: package.json version ${packageJson.version} does not match plugin.json version ${manifest.version}.`
    );
  }
  if (packageJson.name !== `@zclaudia/plugin-${agent}`) {
    throw new Error(`${agent}: unexpected package name ${packageJson.name}.`);
  }
  const packageMain = String(packageJson.main ?? '').replace(/^\.\//, '');
  if (packageMain !== manifest.main) {
    throw new Error(
      `${agent}: package main ${packageJson.main} does not match plugin main ${manifest.main}.`
    );
  }
  for (const section of [
    packageJson.dependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
    packageJson.devDependencies,
  ]) {
    for (const [name, value] of Object.entries(section ?? {})) {
      if (typeof value === 'string' && value.startsWith('workspace:')) {
        throw new Error(`${agent}: dependency ${name} uses forbidden range ${value}.`);
      }
    }
  }
}

async function copyRuntimeDist(source, destination) {
  await mkdir(destination, { recursive: true });
  const children = await readdir(source, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const child of children) {
    const sourcePath = path.join(source, child.name);
    const destinationPath = path.join(destination, child.name);
    if (child.isDirectory()) {
      await copyRuntimeDist(sourcePath, destinationPath);
    } else if (child.isFile() && runtimeDistExtensions.has(path.extname(child.name))) {
      await copyFile(sourcePath, destinationPath);
    } else if (!child.isFile()) {
      throw new Error(`Unsupported dist entry: ${sourcePath}.`);
    }
  }
}

function isPrunableDependencyEntry(name, relativePath) {
  if (name === '.bin' || ['__tests__', 'test', 'tests'].includes(name)) return true;
  if (name === '@zclaudia' || name.startsWith('@zclaudia+')) return true;
  if (/claude-agent-sdk-(?:darwin|linux|win32)-/.test(name)) return true;
  return (
    relativePath === '.modules.yaml' ||
    relativePath === '.pnpm/lock.yaml' ||
    relativePath === '.pnpm-workspace-state-v1.json'
  );
}

async function pruneDependencies(root, directory = root) {
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const absolute = path.join(directory, child.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
    if (isPrunableDependencyEntry(child.name, relative)) {
      await rm(absolute, { force: true, recursive: true });
    } else if (child.isDirectory()) {
      await pruneDependencies(root, absolute);
    }
  }
}

async function vendorClaudeDependencies(packageName, stagingDirectory) {
  const deployDirectory = await mkdtemp(path.join(tmpdir(), 'zclaudia-claude-deploy-'));
  try {
    pnpm(['--filter', packageName, 'deploy', '--prod', '--no-optional', deployDirectory]);
    const deployedModules = path.join(deployDirectory, 'node_modules');
    const stagedModules = path.join(stagingDirectory, 'node_modules');
    await cp(deployedModules, stagedModules, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await pruneDependencies(stagedModules);
  } finally {
    await rm(deployDirectory, { force: true, recursive: true });
  }
}

async function findInstalledPackageRoots(nodeModules) {
  const virtualStore = path.join(nodeModules, '.pnpm');
  const roots = [];
  const virtualPackages = await readdir(virtualStore, { withFileTypes: true });
  for (const virtualPackage of virtualPackages) {
    if (!virtualPackage.isDirectory() || virtualPackage.name === 'node_modules') continue;
    const packageNodeModules = path.join(virtualStore, virtualPackage.name, 'node_modules');
    let children;
    try {
      children = await readdir(packageNodeModules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const childPath = path.join(packageNodeModules, child.name);
      if (child.name.startsWith('@')) {
        const scopedPackages = await readdir(childPath, { withFileTypes: true });
        for (const scopedPackage of scopedPackages) {
          if (scopedPackage.isDirectory()) roots.push(path.join(childPath, scopedPackage.name));
        }
      } else {
        roots.push(childPath);
      }
    }
  }
  return roots;
}

function repositoryUrl(repository) {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return undefined;
}

async function generateLicenseInventory(stagingDirectory) {
  const nodeModules = path.join(stagingDirectory, 'node_modules');
  const packageDirectories = await findInstalledPackageRoots(nodeModules);
  const packages = new Map();
  for (const packageDirectory of packageDirectories) {
    const packageJson = await readJson(path.join(packageDirectory, 'package.json'));
    if (!packageJson.name || !packageJson.version || packageJson.name.startsWith('@zclaudia/')) {
      continue;
    }
    const key = `${packageJson.name}@${packageJson.version}`;
    if (packages.has(key)) continue;
    const licenseFiles = (await readdir(packageDirectory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
    packages.set(key, {
      key,
      license: packageJson.license ?? 'UNSPECIFIED',
      licenseFiles,
      packageDirectory,
      repository: repositoryUrl(packageJson.repository) ?? packageJson.homepage,
      version: packageJson.version,
      name: packageJson.name,
    });
  }

  const inventory = [...packages.values()].sort((left, right) =>
    left.key.localeCompare(right.key, 'en')
  );
  const chunks = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '============================',
    '',
    'This artifact vendors the production dependencies listed below.',
    '',
  ];
  for (const item of inventory) {
    chunks.push(item.key, '-'.repeat(item.key.length), `Declared license: ${item.license}`);
    if (item.repository) chunks.push(`Source: ${item.repository}`);
    if (item.licenseFiles.length === 0) {
      chunks.push('License file: not included by the upstream package', '');
      continue;
    }
    for (const licenseFile of item.licenseFiles) {
      chunks.push(
        '',
        `[${licenseFile}]`,
        await readFile(path.join(item.packageDirectory, licenseFile), 'utf8')
      );
    }
    chunks.push('');
  }
  await writeFile(
    path.join(stagingDirectory, 'THIRD_PARTY_LICENSES.txt'),
    `${chunks.join('\n').trimEnd()}\n`
  );
  return inventory.map(({ name, version, license }) => ({ name, version, license }));
}

async function smokeImport(archivePath, main) {
  const extractionDirectory = await mkdtemp(path.join(tmpdir(), 'zclaudia-plugin-smoke-'));
  try {
    await extractZip(archivePath, extractionDirectory);
    await validatePlugin(extractionDirectory);
    const mainPath = path.join(extractionDirectory, ...main.split('/'));
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]).href);",
        mainPath,
      ],
      { capture: true }
    );
  } finally {
    await rm(extractionDirectory, { force: true, recursive: true });
  }
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function compatibilityMetadata(agent, agentRoot) {
  if (agent !== 'claude') return undefined;
  const module = await import(pathToFileURL(path.join(agentRoot, 'dist', 'compatibility.js')).href);
  return module.CLAUDE_CLI_COMPATIBILITY;
}

async function packAgent(agent) {
  const agentRoot = path.join(repoRoot, 'agents', agent);
  const packagePath = path.join(agentRoot, 'package.json');
  const manifestPath = path.join(agentRoot, 'plugin.json');
  const packageJson = await readJson(packagePath);
  const manifest = await readJson(manifestPath);
  assertSourceMetadata(agent, packageJson, manifest);

  const stagingDirectory = path.join(stagingRoot, agent);
  const artifactName = `zclaudia-agent-${agent}-${manifest.version}-any.zplugin`;
  const artifactPath = path.join(releaseRoot, artifactName);
  await rm(stagingDirectory, { force: true, recursive: true });
  await Promise.all([
    rm(artifactPath, { force: true }),
    rm(`${artifactPath}.sha256`, { force: true }),
    rm(`${artifactPath}.metadata.json`, { force: true }),
  ]);
  await mkdir(stagingDirectory, { recursive: true });
  await Promise.all(
    ['plugin.json', 'README.md', 'LICENSE'].map(file =>
      copyFile(path.join(agentRoot, file), path.join(stagingDirectory, file))
    )
  );
  await copyRuntimeDist(path.join(agentRoot, 'dist'), path.join(stagingDirectory, 'dist'));

  let dependencies = [];
  if (agent === 'claude') {
    await vendorClaudeDependencies(packageJson.name, stagingDirectory);
    dependencies = await generateLicenseInventory(stagingDirectory);
  }

  await validatePlugin(stagingDirectory);
  await mkdir(releaseRoot, { recursive: true });
  await createDeterministicZip(stagingDirectory, artifactPath);
  const validation = await validatePlugin(artifactPath);
  await smokeImport(artifactPath, manifest.main);

  const checksum = await sha256(artifactPath);
  const artifactDetails = await stat(artifactPath);
  const timestamp = process.env.SOURCE_DATE_EPOCH ? deterministicTimestamp() : new Date();
  const metadata = {
    schemaVersion: 1,
    generatedAt: timestamp.toISOString(),
    plugin: {
      agent,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      main: manifest.main,
    },
    artifact: {
      file: artifactName,
      target: 'any',
      sha256: checksum,
      size: artifactDetails.size,
      fileCount: validation.fileCount,
      unpackedSize: validation.unpackedSize,
    },
    runtime: {
      requiredExecutable: requiredExecutables[agent],
      compatibility: await compatibilityMetadata(agent, agentRoot),
    },
    dependencies,
  };
  await writeFile(`${artifactPath}.sha256`, `${checksum}  ${artifactName}\n`);
  await writeFile(`${artifactPath}.metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Packed ${agent}: ${path.relative(repoRoot, artifactPath)}`);
  return metadata;
}

const args = process.argv.slice(2);
const skipChecks = args.includes('--skip-checks');
const requested = args.find(argument => !argument.startsWith('--'));
const agents = requested === 'all' ? supportedAgents : [requested];
if (!requested || agents.some(agent => !supportedAgents.includes(agent))) {
  usage();
  process.exit(2);
}

try {
  if (agents.length === supportedAgents.length) {
    await rm(stagingRoot, { force: true, recursive: true });
    await rm(releaseRoot, { force: true, recursive: true });
  }
  if (!skipChecks) {
    pnpm(['lint:boundaries']);
    for (const agent of agents) {
      const filter = `@zclaudia/plugin-${agent}`;
      pnpm(['--filter', filter, 'clean']);
      pnpm(['--filter', filter, 'typecheck']);
      pnpm(['--filter', filter, 'test']);
      pnpm(['--filter', filter, 'build']);
    }
  }
  for (const agent of agents) await packAgent(agent);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
}
