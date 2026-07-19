import { describe, expect, it } from 'vitest';
import {
  buildEnv,
  buildMcpConfigToml,
  mapModeToConfigArgs,
  mcpServersToToml,
  normalizeClaudiaToolName,
  prepareAppServerInput,
} from '../config.js';

describe('config', () => {
  describe('mcpServersToToml', () => {
    it('serializes bridge entry with command and args', () => {
      const toml = mcpServersToToml({
        'claudia-plugins': { command: 'node', args: ['/path/to/bridge.js'] },
      });
      expect(toml).toBe(
        '[mcp_servers.claudia-plugins]\ncommand = "node"\nargs = ["/path/to/bridge.js"]'
      );
    });
  });

  describe('buildMcpConfigToml', () => {
    it('builds TOML from bridge entry only', () => {
      const toml = buildMcpConfigToml({
        name: 'claudia-plugins',
        config: { command: 'node', args: ['/path/to/bridge.js'] },
      });
      expect(toml).toBe(
        '[mcp_servers.claudia-plugins]\ncommand = "node"\nargs = ["/path/to/bridge.js"]'
      );
    });

    it('returns empty string when bridge is null', () => {
      expect(buildMcpConfigToml(null)).toBe('');
    });
  });

  describe('mapModeToConfigArgs', () => {
    it('includes approval_policy on-request for plan mode', () => {
      const args = mapModeToConfigArgs('plan');
      expect(args).toContain('-c');
      expect(args).toContain('approval_policy="on-request"');
    });
  });

  describe('buildEnv', () => {
    it('sets both ZCLAUDIA_SESSION_ID and CLAUDIA_SESSION_ID', () => {
      const env = buildEnv({ claudiaSessionId: 'sess-42' });
      expect(env.ZCLAUDIA_SESSION_ID).toBe('sess-42');
      expect(env.CLAUDIA_SESSION_ID).toBe('sess-42');
    });
  });

  describe('prepareAppServerInput', () => {
    it('returns text-only blocks for phase 1', () => {
      expect(prepareAppServerInput('hello')).toEqual([{ type: 'text', text: 'hello' }]);
    });
  });

  describe('normalizeClaudiaToolName', () => {
    it('maps claudia-plugins enter_plan_mode to EnterPlanMode', () => {
      expect(normalizeClaudiaToolName('claudia-plugins', 'enter_plan_mode')).toBe('EnterPlanMode');
    });
  });
});
