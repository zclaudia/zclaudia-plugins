import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_COMPATIBILITY_FILE,
  validateRuntimeCompatibility,
} from './runtime-compatibility.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsRoot = path.join(repoRoot, 'agents');
const packagesRoot = path.join(repoRoot, 'packages');
const failures = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    if (entry === 'dist' || entry === 'node_modules') continue;
    if (statSync(fullPath).isDirectory()) files.push(...walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

for (const pluginName of readdirSync(agentsRoot).sort()) {
  const pluginRoot = path.join(agentsRoot, pluginName);
  if (!statSync(pluginRoot).isDirectory()) continue;

  const packagePath = path.join(pluginRoot, 'package.json');
  const manifestPath = path.join(pluginRoot, 'plugin.json');
  const compatibilityPath = path.join(pluginRoot, RUNTIME_COMPATIBILITY_FILE);
  if (!existsSync(packagePath) || !existsSync(manifestPath) || !existsSync(compatibilityPath)) {
    failures.push(
      `agents/${pluginName}: package.json, plugin.json, and ${RUNTIME_COMPATIBILITY_FILE} are all required.`
    );
    continue;
  }

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expectedPackageName = `@zclaudia/plugin-${pluginName}`;

  if (packageJson.name !== expectedPackageName) {
    failures.push(
      `agents/${pluginName}/package.json: expected package name ${expectedPackageName}.`
    );
  }
  if (packageJson.private === true) {
    failures.push(`agents/${pluginName}/package.json: publishable plugins must not be private.`);
  }
  if (packageJson.version !== manifest.version) {
    failures.push(
      `agents/${pluginName}: package version ${packageJson.version} does not match manifest version ${manifest.version}.`
    );
  }
  try {
    validateRuntimeCompatibility(JSON.parse(readFileSync(compatibilityPath, 'utf8')), pluginName);
  } catch (error) {
    failures.push(
      `agents/${pluginName}/${RUNTIME_COMPATIBILITY_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  for (const file of walk(pluginRoot)) {
    const relativePath = path.relative(repoRoot, file).replaceAll(path.sep, '/');
    const content = readFileSync(file, 'utf8');
    if (/['"]@zclaudia\/shared(?:\/[^'"]*)?['"]/.test(content)) {
      failures.push(`${relativePath}: import public contracts from @zclaudia/plugin-sdk.`);
    }
    if (/"[^"]+"\s*:\s*"workspace:/.test(content)) {
      failures.push(`${relativePath}: workspace: dependencies cannot be published independently.`);
    }
  }
}

for (const packageDirectory of readdirSync(packagesRoot).sort()) {
  const packageRoot = path.join(packagesRoot, packageDirectory);
  if (!statSync(packageRoot).isDirectory()) continue;

  const packagePath = path.join(packageRoot, 'package.json');
  if (!existsSync(packagePath)) {
    failures.push(`packages/${packageDirectory}: package.json is required.`);
    continue;
  }

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!packageJson.name?.startsWith('@zclaudia/')) {
    failures.push(`packages/${packageDirectory}/package.json: package name must use @zclaudia/.`);
  }

  for (const file of walk(packageRoot)) {
    const relativePath = path.relative(repoRoot, file).replaceAll(path.sep, '/');
    const content = readFileSync(file, 'utf8');
    if (/['"]@zclaudia\/shared(?:\/[^'"]*)?['"]/.test(content)) {
      failures.push(`${relativePath}: import public contracts from @zclaudia/plugin-sdk.`);
    }
    if (packageJson.private !== true && /"[^"]+"\s*:\s*"workspace:/.test(content)) {
      failures.push(`${relativePath}: publishable packages cannot use workspace: dependencies.`);
    }
  }
}

if (failures.length > 0) {
  console.error('Plugin package boundary checks failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Plugin package boundary checks passed.');
