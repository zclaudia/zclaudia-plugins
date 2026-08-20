import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = process.env.CODEX_CLI_PATH || 'codex';
const outputDirectory = mkdtempSync(path.join(tmpdir(), 'zclaudia-codex-contract-'));

function fail(message) {
  throw new Error(`Codex app-server protocol drift: ${message}`);
}

function schema(relativePath) {
  return JSON.parse(readFileSync(path.join(outputDirectory, relativePath), 'utf8'));
}

function requiredFields(value, context, expected) {
  const actual = new Set(value.required || []);
  for (const field of expected) {
    if (!actual.has(field)) fail(`${context} no longer requires ${field}`);
  }
}

function properties(value, context, expected) {
  for (const field of expected) {
    if (!(field in (value.properties || {}))) fail(`${context} no longer contains ${field}`);
  }
}

function variant(definition, type, context) {
  const found = (definition?.oneOf || []).find(candidate => {
    const typeSchema = candidate?.properties?.type;
    return typeSchema?.const === type || typeSchema?.enum?.includes(type);
  });
  if (!found) fail(`${context} no longer contains ${type}`);
  return found;
}

try {
  const generated = spawnSync(
    cli,
    ['app-server', 'generate-json-schema', '--experimental', '--out', outputDirectory],
    { encoding: 'utf8' }
  );
  if (generated.error || generated.status !== 0) {
    const detail = generated.error?.message || generated.stderr || generated.stdout;
    throw new Error(`Could not generate Codex app-server schema with ${cli}: ${detail}`);
  }

  const turnInterrupt = schema('v2/TurnInterruptParams.json');
  requiredFields(turnInterrupt, 'turn/interrupt params', ['threadId', 'turnId']);

  const initialize = schema('v1/InitializeParams.json');
  requiredFields(initialize, 'initialize params', ['clientInfo']);
  properties(initialize, 'initialize params', ['capabilities']);

  const turnStart = schema('v2/TurnStartParams.json');
  requiredFields(turnStart, 'turn/start params', ['threadId', 'input']);
  const userInput = turnStart.definitions?.UserInput;
  const textInput = variant(userInput, 'text', 'UserInput');
  requiredFields(textInput, 'text UserInput', ['type', 'text']);
  properties(textInput, 'text UserInput', ['text_elements']);
  requiredFields(variant(userInput, 'localImage', 'UserInput'), 'localImage UserInput', [
    'type',
    'path',
  ]);

  const turnStartResponse = schema('v2/TurnStartResponse.json');
  requiredFields(turnStartResponse, 'turn/start response', ['turn']);
  const turn = turnStartResponse.definitions?.Turn || {};
  requiredFields(turn, 'Turn', ['id', 'status']);
  properties(turn, 'Turn', ['error']);

  const usage = schema('v2/ThreadTokenUsageUpdatedNotification.json');
  requiredFields(usage, 'thread/tokenUsage/updated', ['threadId', 'turnId', 'tokenUsage']);
  properties(usage.definitions?.TokenUsageBreakdown || {}, 'TokenUsageBreakdown', [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
  ]);

  const modelList = schema('v2/ModelListResponse.json');
  requiredFields(modelList, 'model/list response', ['data']);
  properties(modelList, 'model/list response', ['nextCursor']);
  requiredFields(modelList.definitions?.Model || {}, 'Model', [
    'id',
    'model',
    'displayName',
    'description',
    'hidden',
  ]);

  const progress = schema('v2/McpToolCallProgressNotification.json');
  requiredFields(progress, 'item/mcpToolCall/progress', [
    'threadId',
    'turnId',
    'itemId',
    'message',
  ]);

  const itemStarted = schema('v2/ItemStartedNotification.json');
  requiredFields(itemStarted, 'item/started', ['threadId', 'turnId', 'item']);
  const threadItem = itemStarted.definitions?.ThreadItem;
  requiredFields(variant(threadItem, 'fileChange', 'ThreadItem'), 'fileChange item', [
    'id',
    'type',
    'changes',
    'status',
  ]);
  const mcpToolCall = variant(threadItem, 'mcpToolCall', 'ThreadItem');
  requiredFields(mcpToolCall, 'mcpToolCall item', [
    'id',
    'type',
    'server',
    'tool',
    'arguments',
    'status',
  ]);
  properties(mcpToolCall, 'mcpToolCall item', ['result', 'error']);
  const commandExecution = variant(threadItem, 'commandExecution', 'ThreadItem');
  requiredFields(commandExecution, 'commandExecution item', ['id', 'type', 'command', 'status']);
  properties(commandExecution, 'commandExecution item', ['aggregatedOutput']);

  for (const [file, context] of [
    ['CommandExecutionRequestApprovalParams.json', 'command approval'],
    ['FileChangeRequestApprovalParams.json', 'file-change approval'],
    ['PermissionsRequestApprovalParams.json', 'permissions approval'],
  ]) {
    requiredFields(schema(file), context, ['threadId', 'turnId', 'itemId']);
  }

  console.log('Codex app-server protocol contract matches the adapter.');
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
