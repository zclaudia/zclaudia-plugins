import { describe, expect, it } from 'vitest';
import { fileChangeEffectFromMap, makeShellEffect } from '../tool-effects.js';

describe('tool-effects', () => {
  it('makeShellEffect returns shell effect', () => {
    expect(makeShellEffect('ls -la')).toEqual({ kind: 'shell', command: 'ls -la' });
  });

  it('fileChangeEffectFromMap maps codex fileChanges record', () => {
    const effect = fileChangeEffectFromMap({
      'src/a.ts': { type: 'modify' },
      'src/b.ts': { type: 'add' },
    });
    expect(effect?.kind).toBe('file_change');
    expect(effect?.files?.map(f => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
