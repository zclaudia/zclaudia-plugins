#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCompatibilityReport,
  discoverRuntimePlugins,
  testRuntimeCompatibility,
} from './runtime-compatibility.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(
    'Usage: pnpm compat:test [all|runtime...] [--live] [--timeout milliseconds] [--report file] [--cli runtime=/absolute/path]'
  );
}

const args = process.argv.slice(2);
let live = false;
let timeoutMs = 5_000;
let reportPath;
const cliPaths = new Map();
const selected = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--live') {
    live = true;
  } else if (arg === '--timeout') {
    timeoutMs = Number(args[++index]);
  } else if (arg === '--report') {
    reportPath = args[++index];
  } else if (arg === '--cli') {
    const value = args[++index] ?? '';
    const separator = value.indexOf('=');
    if (separator <= 0) {
      usage();
      process.exit(2);
    }
    cliPaths.set(value.slice(0, separator), value.slice(separator + 1));
  } else if (arg.startsWith('--')) {
    usage();
    process.exit(2);
  } else {
    selected.push(arg);
  }
}

if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
  console.error('--timeout must be an integer between 100 and 600000 milliseconds.');
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
  const results = [];
  for (const plugin of requested) {
    const result = await testRuntimeCompatibility(plugin, {
      executable: cliPaths.get(plugin.runtime),
      timeoutMs,
      live,
    });
    results.push(result);
    console.log(
      `${plugin.runtime}: ${result.state}${result.cli.version ? ` (${result.cli.version})` : ''}`
    );
    for (const test of result.results) {
      console.log(`  ${test.status.padEnd(7)} ${test.id}: ${test.message}`);
    }
  }
  const report = createCompatibilityReport(results, { live });
  if (reportPath) {
    const absolute = path.resolve(reportPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${absolute}`);
  }
  if (results.some(result => result.state === 'incompatible')) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
