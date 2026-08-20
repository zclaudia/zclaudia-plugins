export const MAX_CODEX_DELTA_BYTES = 128 * 1024;
export const MAX_CODEX_TOOL_INPUT_BYTES = 256 * 1024;
export const MAX_CODEX_TOOL_RESULT_BYTES = 512 * 1024;

function prefixAtUtf8Boundary(buffer: Buffer, bytes: number): Buffer {
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}

function suffixAtUtf8Boundary(buffer: Buffer, bytes: number): Buffer {
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

/** Keep useful context from both ends while enforcing a UTF-8 byte budget. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;

  const placeholder = '\n… [truncated] …\n';
  const placeholderBytes = Buffer.byteLength(placeholder);
  if (maxBytes <= placeholderBytes) {
    return prefixAtUtf8Boundary(buffer, maxBytes).toString('utf8');
  }

  const contentBudget = maxBytes - placeholderBytes;
  const head = prefixAtUtf8Boundary(buffer, Math.ceil(contentBudget * 0.75));
  const tail = suffixAtUtf8Boundary(buffer, contentBudget - head.length);
  return `${head.toString('utf8')}${placeholder}${tail.toString('utf8')}`;
}

export function boundedJsonText(value: unknown, maxBytes: number): string {
  if (typeof value === 'string') return truncateUtf8(value, maxBytes);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value ?? '');
  } catch {
    serialized = String(value);
  }
  return truncateUtf8(serialized, maxBytes);
}

export function boundedToolInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { _raw: boundedJsonText(value, MAX_CODEX_TOOL_INPUT_BYTES) };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { _raw: boundedJsonText(value, MAX_CODEX_TOOL_INPUT_BYTES) };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_CODEX_TOOL_INPUT_BYTES) {
    return value as Record<string, unknown>;
  }
  return {
    _truncated: true,
    _raw: truncateUtf8(serialized, MAX_CODEX_TOOL_INPUT_BYTES),
  };
}
