/**
 * Narrow app-server v2 contract used by this adapter.
 *
 * Keep this file aligned with `codex app-server generate-json-schema --experimental`.
 * The protocol check script asserts the required fields that this adapter relies on
 * without vendoring the complete generated schema bundle.
 */

export type RequestId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface InitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities?: {
    experimentalApi: boolean;
    requestAttestation: boolean;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type AppServerInputBlock =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' };

export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

export interface Turn {
  id: string;
  status: string;
  error: TurnError | null;
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  [key: string]: unknown;
}

export interface CodexClientRequestMap {
  initialize: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  'thread/start': {
    params: { cwd?: string | null; model?: string | null };
    result: { thread: { id: string; [key: string]: unknown } };
  };
  'thread/resume': {
    params: { threadId: string; cwd?: string | null; model?: string | null };
    result: { thread: { id: string; cwd?: string; [key: string]: unknown }; cwd?: string };
  };
  'thread/loaded/list': {
    params: Record<string, never>;
    result: { data: string[] };
  };
  'turn/start': {
    params: { threadId: string; input: AppServerInputBlock[]; model?: string | null };
    result: { turn: Turn };
  };
  'turn/interrupt': {
    params: { threadId: string; turnId: string };
    result: Record<string, never>;
  };
  'model/list': {
    params: { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null };
    result: { data: ModelInfo[]; nextCursor?: string | null };
  };
}

export type CodexClientRequestMethod = keyof CodexClientRequestMap;
export type ClientRequestParams<M extends CodexClientRequestMethod> =
  CodexClientRequestMap[M]['params'];
export type ClientRequestResult<M extends CodexClientRequestMethod> =
  CodexClientRequestMap[M]['result'];

export interface FileUpdateChange {
  path: string;
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
  diff: string;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: Record<string, unknown> & { type: string; id: string };
}

export interface DeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface McpProgressNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  message: string;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  error: TurnError;
  willRetry: boolean;
}

export type KnownNotificationParams =
  | ThreadTokenUsageUpdatedNotification
  | TurnStartedNotification
  | TurnCompletedNotification
  | ItemNotification
  | DeltaNotification
  | McpProgressNotification
  | ErrorNotification;

export interface TurnScopedServerRequestParams {
  threadId: string;
  turnId: string;
  itemId: string;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined;
}

export function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid Codex app-server ${context}: expected object`);
  return value;
}

export function requireString(
  value: Record<string, unknown>,
  field: string,
  context: string
): string {
  const result = stringField(value, field);
  if (result === undefined) {
    throw new Error(`Invalid Codex app-server ${context}: missing string field ${field}`);
  }
  return result;
}
