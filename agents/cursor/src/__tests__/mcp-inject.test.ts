import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { injectCursorMcpBridge } from '../mcp-inject.js';

describe('injectCursorMcpBridge', () => {
  const dirs: string[] = [];
  afterEach(() => {
    // leave tmp dirs; OS cleans. Track for clarity.
    dirs.length = 0;
  });

  function project(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'zclaudia-cursor-mcp-'));
    dirs.push(dir);
    return dir;
  }

  it('creates .cursor/mcp.json and writes the bridge server', () => {
    const cwd = project();
    const result = injectCursorMcpBridge(cwd, {
      name: 'claudia-plugins',
      config: { command: 'node', args: ['bridge.js'] },
    });
    expect(result).toEqual({ ok: true });
    const raw = JSON.parse(readFileSync(path.join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(raw.mcpServers['claudia-plugins']).toEqual({
      command: 'node',
      args: ['bridge.js'],
    });
  });

  it('merges without removing existing servers', () => {
    const cwd = project();
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'docs' } } })
    );
    injectCursorMcpBridge(cwd, {
      name: 'claudia-plugins',
      config: { command: 'node', args: ['bridge.js'] },
    });
    const raw = JSON.parse(readFileSync(path.join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(raw.mcpServers.docs).toEqual({ command: 'docs' });
    expect(raw.mcpServers['claudia-plugins']).toBeTruthy();
  });

  it('does not overwrite a user server with the same name', () => {
    const cwd = project();
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { 'claudia-plugins': { command: 'user-bridge' } },
      })
    );
    injectCursorMcpBridge(cwd, {
      name: 'claudia-plugins',
      config: { command: 'node', args: ['bridge.js'] },
    });
    const raw = JSON.parse(readFileSync(path.join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(raw.mcpServers['claudia-plugins']).toEqual({ command: 'user-bridge' });
  });

  it('recovers from invalid JSON by rewriting a fresh config', () => {
    const cwd = project();
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    writeFileSync(path.join(cwd, '.cursor', 'mcp.json'), '{not-json');
    const result = injectCursorMcpBridge(cwd, {
      name: 'claudia-plugins',
      config: { command: 'node', args: ['bridge.js'] },
    });
    expect(result).toEqual({ ok: true });
    expect(existsSync(path.join(cwd, '.cursor', 'mcp.json'))).toBe(true);
  });
});
