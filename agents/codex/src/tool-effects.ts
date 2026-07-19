import type { FileChangeEffectFile, ToolEffect } from '@zclaudia/plugin-sdk/types';

export function makeShellEffect(command: string | undefined): ToolEffect | undefined {
  const trimmed = command?.trim();
  return trimmed ? { kind: 'shell', command: trimmed } : undefined;
}

export function cleanEffectPath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;
  let value = rawPath.trim();
  if (!value || value === '/dev/null') return undefined;
  value = value.replace(/^["']|["']$/g, '');
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
  const tabIdx = value.indexOf('\t');
  if (tabIdx >= 0) value = value.slice(0, tabIdx);
  return value || undefined;
}

export function makeFileChangeEffect(files: FileChangeEffectFile[]): ToolEffect | undefined {
  const normalized = files
    .map(f => ({
      ...f,
      path: cleanEffectPath(f.path) ?? '',
      changeKind: f.changeKind ?? ('unknown' as const),
    }))
    .filter(f => f.path);
  return normalized.length > 0 ? { kind: 'file_change', files: normalized } : undefined;
}

export function fileChangeEffectFromMap(value: unknown): ToolEffect | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, any>;
  const files: FileChangeEffectFile[] = [];

  for (const [rawPath, change] of Object.entries(record)) {
    const path = cleanEffectPath(rawPath);
    if (!path) continue;

    const type = (change?.type as string | undefined)?.toLowerCase();

    let changeKind: FileChangeEffectFile['changeKind'];
    if (type === 'add') {
      changeKind = 'add';
    } else if (type === 'delete') {
      changeKind = 'delete';
    } else {
      changeKind = 'modify';
    }

    files.push({
      path,
      changeKind,
    });
  }

  return makeFileChangeEffect(files);
}
