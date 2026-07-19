import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

const { clearClaudeAgentConfigCache, loadClaudeAgentConfig } = await import('../config.js');

const tempDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'zclaudia-claude-config-'));
  tempDirs.push(dir);
  homedirMock.mockReturnValue(dir);
  clearClaudeAgentConfigCache();
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), 'utf-8');
}

afterEach(() => {
  clearClaudeAgentConfigCache();
  homedirMock.mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadClaudeAgentConfig', () => {
  it('returns empty SDK config when Claude config files are absent', () => {
    makeHome();

    expect(loadClaudeAgentConfig()).toEqual({
      mcpServers: {},
      plugins: [],
    });
  });

  it('loads stdio MCP servers from ~/.claude/mcp.json', () => {
    const home = makeHome();
    writeJson(path.join(home, '.claude', 'mcp.json'), {
      mcpServers: {
        docs: {
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: 'secret' },
        },
        broken: {
          args: ['missing-command'],
        },
      },
    });

    expect(loadClaudeAgentConfig().mcpServers).toEqual({
      docs: {
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'secret' },
      },
    });
  });

  it('loads enabled local plugins from Claude settings and installed registry', () => {
    const home = makeHome();
    const pluginPath = path.join(home, 'plugin-a');
    mkdirSync(pluginPath, { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      enabledPlugins: {
        'plugin-a@local': true,
        'plugin-b@local': false,
      },
    });
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 1,
      plugins: {
        'plugin-a@local': [
          {
            scope: 'user',
            installPath: pluginPath,
            version: '1.0.0',
          },
        ],
      },
    });

    expect(loadClaudeAgentConfig().plugins).toEqual([{ type: 'local', path: pluginPath }]);
  });

  it('ignores invalid JSON instead of throwing', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'mcp.json'), '{not-json', 'utf-8');

    expect(loadClaudeAgentConfig()).toEqual({
      mcpServers: {},
      plugins: [],
    });
  });

  it('caches config until the cache is cleared', () => {
    const home = makeHome();
    const mcpFile = path.join(home, '.claude', 'mcp.json');
    writeJson(mcpFile, {
      mcpServers: {
        first: { command: 'node' },
      },
    });

    expect(Object.keys(loadClaudeAgentConfig().mcpServers)).toEqual(['first']);
    writeJson(mcpFile, {
      mcpServers: {
        second: { command: 'node' },
      },
    });
    expect(Object.keys(loadClaudeAgentConfig().mcpServers)).toEqual(['first']);

    clearClaudeAgentConfigCache();
    expect(Object.keys(loadClaudeAgentConfig().mcpServers)).toEqual(['second']);
  });
});
