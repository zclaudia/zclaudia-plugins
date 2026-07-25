#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from './plugin-validation.mjs';

const tag = process.argv[2];
const match = /^([a-z0-9][a-z0-9-]*)-v(.+)$/.exec(tag ?? '');
if (!match) {
  console.error('Usage: node scripts/verify-release.mjs <runtime>-v<version>');
  process.exit(2);
}

const [, agent, version] = match;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactName = `zclaudia-agent-${agent}-${version}-any.zplugin`;
const artifactPath = path.join(repoRoot, 'artifacts', 'release', artifactName);

try {
  const [archive, checksumFile, metadata, details, validation] = await Promise.all([
    readFile(artifactPath),
    readFile(`${artifactPath}.sha256`, 'utf8'),
    readFile(`${artifactPath}.metadata.json`, 'utf8').then(JSON.parse),
    stat(artifactPath),
    validatePlugin(artifactPath),
  ]);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const expectedChecksumFile = `${checksum}  ${artifactName}\n`;
  if (checksumFile !== expectedChecksumFile) throw new Error('SHA-256 sidecar does not match.');
  if (
    metadata.plugin.agent !== agent ||
    metadata.plugin.version !== version ||
    metadata.artifact.file !== artifactName ||
    metadata.artifact.sha256 !== checksum ||
    metadata.artifact.size !== details.size ||
    metadata.artifact.fileCount !== validation.fileCount ||
    metadata.artifact.unpackedSize !== validation.unpackedSize
  ) {
    throw new Error('Artifact metadata does not match the validated archive.');
  }
  console.log(`Verified ${artifactName} (${checksum}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
