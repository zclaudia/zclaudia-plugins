import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentDevOptions } from '../options.js';

describe('parseAgentDevOptions', () => {
  it('parses a standalone run command', () => {
    expect(
      parseAgentDevOptions(
        [
          'run',
          'agents/codex',
          '--input',
          'hello',
          '--cwd',
          'project',
          '--permission',
          'allow',
          '--bridge',
          'debug',
          '--raw',
        ],
        '/repo'
      )
    ).toMatchObject({
      command: 'run',
      pluginDirectory: path.join('/repo', 'agents/codex'),
      input: 'hello',
      cwd: path.join('/repo', 'project'),
      permissionMode: 'allow',
      bridgeMode: 'debug',
      includeRawEvents: true,
    });
  });

  it('requires an input for one-shot runs', () => {
    expect(() => parseAgentDevOptions(['run', 'agents/codex'], '/repo')).toThrow(
      'requires --input'
    );
  });
});
