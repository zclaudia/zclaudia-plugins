import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentAdapter } from '../adapter.js';

const { queryMock, loadClaudeAgentConfigMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  loadClaudeAgentConfigMock: vi.fn(() => ({ mcpServers: {}, plugins: [] })),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

vi.mock('../config.js', () => ({
  loadClaudeAgentConfig: loadClaudeAgentConfigMock,
}));

async function* emptyStream() {
  /* no events */
}

async function drain(adapter: ClaudeAgentAdapter): Promise<void> {
  for await (const _event of adapter.run(
    'hello',
    { cwd: '/tmp/project', claudiaSessionId: 'session-1', serverPort: 3100 },
    vi.fn()
  )) {
    // drain
  }
}

describe('ClaudeAgentAdapter MCP bridge merge', () => {
  it('adds the tool-bridge entry when no MCP server uses its name', async () => {
    loadClaudeAgentConfigMock.mockReturnValueOnce({
      mcpServers: { docs: { command: 'node', args: ['docs.js'] } },
      plugins: [],
    });
    queryMock.mockReturnValueOnce(emptyStream());

    const bridge = { name: 'claudia-plugins', config: { command: 'node', args: ['bridge.js'] } };
    const adapter = new ClaudeAgentAdapter(async () => bridge);

    await drain(adapter);

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          mcpServers: {
            docs: { command: 'node', args: ['docs.js'] },
            'claudia-plugins': { command: 'node', args: ['bridge.js'] },
          },
        }),
      })
    );
  });

  it('preserves a user-configured MCP server registered under the bridge name', async () => {
    loadClaudeAgentConfigMock.mockReturnValueOnce({
      mcpServers: { 'claudia-plugins': { command: 'custom-bridge', args: ['user.js'] } },
      plugins: [],
    });
    queryMock.mockReturnValueOnce(emptyStream());

    const bridge = { name: 'claudia-plugins', config: { command: 'node', args: ['bridge.js'] } };
    const adapter = new ClaudeAgentAdapter(async () => bridge);

    await drain(adapter);

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          mcpServers: {
            'claudia-plugins': { command: 'custom-bridge', args: ['user.js'] },
          },
        }),
      })
    );
  });

  it('uses the config MCP servers unchanged when there is no bridge', async () => {
    loadClaudeAgentConfigMock.mockReturnValueOnce({
      mcpServers: { docs: { command: 'node', args: ['docs.js'] } },
      plugins: [],
    });
    queryMock.mockReturnValueOnce(emptyStream());

    const adapter = new ClaudeAgentAdapter(async () => null);

    await drain(adapter);

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          mcpServers: { docs: { command: 'node', args: ['docs.js'] } },
        }),
      })
    );
  });
});
