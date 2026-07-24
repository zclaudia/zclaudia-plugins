#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, MemoryAgentSessionStore, loadAgentPlugin } from '@zclaudia/agent-runtime';
import { createPortableToolBridge } from '@zclaudia/agent-tool-bridge';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(repoRoot, 'fixtures', 'agent-runtime-basic');

await smokeRuntime();
await smokeToolBridge();
console.log('Standalone agent runtime smoke checks passed.');

async function smokeRuntime() {
  const plugin = await loadAgentPlugin(fixtureDirectory);
  try {
    const runtime = new AgentRuntime({ sessionStore: new MemoryAgentSessionStore() });
    const handle = runtime.start({
      adapter: plugin.getAdapter(),
      input: 'runtime-smoke',
      cwd: repoRoot,
      hostSessionId: 'smoke',
    });
    const events = [];
    for await (const event of handle.events) events.push(event);
    await handle.done;
    assert.equal(handle.state.status, 'completed');
    assert.equal(handle.state.content, 'runtime-smoke');
    assert.ok(events.some(event => event.type === 'provider.session'));
    assert.equal(events.at(-1)?.type, 'run.completed');
  } finally {
    await plugin.deactivate();
  }
}

async function smokeToolBridge() {
  const handle = await createPortableToolBridge({
    sessionId: 'smoke-session',
    catalog: {
      listTools: () => [
        {
          name: 'echo',
          description: 'Echo a value',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: (_name, args, context) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ value: args.value, sessionId: context.sessionId }),
          },
        ],
      }),
    },
  });
  const config = handle.entry.config;
  assert.ok(config && typeof config === 'object');
  const { command, args = [], env = {} } = config;
  assert.equal(typeof command, 'string');
  assert.ok(Array.isArray(args));
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  lines.on('line', line => pending.shift()?.(JSON.parse(line)));

  try {
    const initialized = await rpc(child, pending, 1, 'initialize', {
      protocolVersion: '2024-11-05',
    });
    assert.equal(initialized.result.serverInfo.name, 'agent-tool-bridge');

    const listed = await rpc(child, pending, 2, 'tools/list');
    assert.equal(listed.result.tools[0].name, 'echo');

    const called = await rpc(child, pending, 3, 'tools/call', {
      name: 'echo',
      arguments: { value: 'bridge-smoke' },
    });
    assert.deepEqual(JSON.parse(called.result.content[0].text), {
      value: 'bridge-smoke',
      sessionId: 'smoke-session',
    });
  } finally {
    child.stdin.end();
    await withTimeout(
      new Promise(resolve => child.once('exit', resolve)),
      5_000,
      `MCP bridge did not exit. ${stderr.join('')}`
    );
    lines.close();
    await handle.close();
  }
}

async function rpc(child, pending, id, method, params) {
  const response = new Promise(resolve => pending.push(resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return await withTimeout(response, 5_000, `Timed out waiting for ${method}.`);
}

async function withTimeout(promise, timeoutMs, message) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
