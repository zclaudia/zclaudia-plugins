#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRuntimePlugins } from './runtime-compatibility.mjs';
import {
  currentPlatformKey,
  managedArtifactEntries,
  verifyManagedArtifact,
} from './managed-artifacts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('Usage: pnpm managed:verify [all|runtime...] [--all-platforms]');
}

const args = process.argv.slice(2);
const allPlatforms = args.includes('--all-platforms');
const selected = args.filter(arg => arg !== '--all-platforms');
if (selected.some(arg => arg.startsWith('--'))) {
  usage();
  process.exit(2);
}

try {
  const plugins = await discoverRuntimePlugins(repoRoot);
  const requested =
    selected.length === 0 || selected.includes('all')
      ? plugins
      : plugins.filter(plugin => selected.includes(plugin.runtime));
  const unknown = selected.filter(
    name => name !== 'all' && !plugins.some(plugin => plugin.runtime === name)
  );
  if (unknown.length > 0 || requested.length === 0) {
    console.error(`Unknown runtime(s): ${unknown.join(', ') || selected.join(', ')}`);
    process.exit(2);
  }

  const platform = currentPlatformKey();
  if (!allPlatforms && !platform) {
    throw new Error(`Unsupported verification platform: ${process.platform}-${process.arch}.`);
  }
  for (const plugin of requested) {
    if (!plugin.compatibility.managedInstall) {
      console.log(`${plugin.runtime}: skipped (no managedInstall metadata)`);
      continue;
    }
    const entries = managedArtifactEntries(plugin.compatibility, {
      allPlatforms,
      platform,
    });
    if (entries.length === 0) {
      throw new Error(`${plugin.runtime}: no managed artifact is declared for ${platform}.`);
    }
    for (const entry of entries) {
      process.stdout.write(
        `${entry.runtime}@${entry.version} ${entry.platform}: downloading and hashing... `
      );
      const result = await verifyManagedArtifact(entry.artifact);
      console.log(`verified (${result.size} bytes, ${result.sha256})`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
