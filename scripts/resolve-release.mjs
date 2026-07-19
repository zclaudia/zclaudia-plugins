import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
const match = /^(claude|codex|cursor)-v(.+)$/.exec(tag ?? '');
if (!match) {
  throw new Error(
    `Invalid release tag "${tag ?? ''}". Expected claude-v<version>, codex-v<version>, or cursor-v<version>.`
  );
}

const [, pluginName, version] = match;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = `agents/${pluginName}`;
const packagePath = path.join(repoRoot, packageDirectory, 'package.json');
const manifestPath = path.join(repoRoot, packageDirectory, 'plugin.json');

if (!existsSync(packagePath) || !existsSync(manifestPath)) {
  throw new Error(`Plugin package ${packageDirectory} does not exist.`);
}

const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (packageJson.version !== version || manifest.version !== version) {
  throw new Error(
    `Tag version ${version} must match package.json (${packageJson.version}) and plugin.json (${manifest.version}).`
  );
}

const output = [
  `plugin-name=${pluginName}`,
  `package-name=${packageJson.name}`,
  `package-directory=${packageDirectory}`,
  `version=${version}`,
].join('\n');

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
else console.log(output);
