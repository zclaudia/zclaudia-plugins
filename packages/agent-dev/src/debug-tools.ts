import type { ToolCatalog, ToolDefinition } from '@zclaudia/agent-tool-bridge';

const DEBUG_TOOLS: ToolDefinition[] = [
  {
    name: 'debug_echo',
    description: 'Echo the supplied value. Used to verify standalone MCP tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { description: 'Value to echo' },
      },
      additionalProperties: true,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'debug_context',
    description: 'Return the standalone bridge session and process context.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'debug_fail',
    description: 'Return an intentional tool error for error-path testing.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

export function createDebugToolCatalog(): ToolCatalog {
  return {
    listTools() {
      return DEBUG_TOOLS;
    },
    callTool(name, args, context) {
      switch (name) {
        case 'debug_echo':
          return {
            content: [{ type: 'text', text: JSON.stringify({ echoed: args.value }) }],
          };
        case 'debug_context':
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  sessionId: context.sessionId,
                  pid: process.pid,
                  cwd: process.cwd(),
                }),
              },
            ],
          };
        case 'debug_fail':
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  typeof args.message === 'string'
                    ? args.message
                    : 'Intentional standalone debug tool failure.',
              },
            ],
          };
        default:
          throw new Error(`Unknown debug tool: ${name}`);
      }
    },
  };
}
