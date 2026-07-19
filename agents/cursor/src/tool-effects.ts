import type { FileChangeEffectFile, ToolEffect } from '@zclaudia/plugin-sdk/types';

export function makeShellEffect(command: string | undefined): ToolEffect | undefined {
  const trimmed = command?.trim();
  return trimmed ? { kind: 'shell', command: trimmed } : undefined;
}

export function makeFileChangeEffect(files: FileChangeEffectFile[]): ToolEffect | undefined {
  const normalized = files
    .map(f => ({
      ...f,
      path: (f.path ?? '').trim(),
      changeKind: f.changeKind ?? ('unknown' as const),
    }))
    .filter(f => f.path);
  return normalized.length > 0 ? { kind: 'file_change', files: normalized } : undefined;
}

const DEFAULT_PATH_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'file',
  'filename',
  'target_file',
  'targetFile',
  'relative_path',
  'relativePath',
  'absolute_path',
  'absolutePath',
] as const;

function filePathFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of DEFAULT_PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export function fileChangeEffectFromInput(
  input: unknown,
  changeKind: FileChangeEffectFile['changeKind'] = 'unknown'
): ToolEffect | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const path = filePathFromRecord(input as Record<string, unknown>);
  if (!path) return undefined;
  return makeFileChangeEffect([{ path, changeKind }]);
}

export function readCursorEditResultEffect(args: unknown, result: unknown): ToolEffect | undefined {
  const resultRecord =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const success =
    resultRecord?.success &&
    typeof resultRecord.success === 'object' &&
    !Array.isArray(resultRecord.success)
      ? (resultRecord.success as Record<string, unknown>)
      : undefined;
  const diffString = typeof success?.diffString === 'string' ? success.diffString : undefined;
  if (diffString) {
    const path = success
      ? filePathFromRecord(success)
      : args && typeof args === 'object' && !Array.isArray(args)
        ? filePathFromRecord(args as Record<string, unknown>)
        : undefined;
    if (path) {
      return makeFileChangeEffect([{ path, changeKind: 'modify', summary: diffString }]);
    }
  }
  return fileChangeEffectFromInput(args, 'modify');
}
