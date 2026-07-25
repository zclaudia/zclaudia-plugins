/**
 * Provider-neutral assertions used by every agent adapter test.  These checks
 * deliberately assert protocol invariants instead of model wording: the
 * latter is not deterministic enough to certify a CLI integration.
 */

const REQUIRED_RUNTIME_CAPABILITIES = new Set([
  'chat.stream',
  'tool.call',
  'permission.mode',
  'session.abort',
]);

function failure(id, message) {
  return { id, status: 'failed', message };
}

function success(id, message) {
  return { id, status: 'passed', message };
}

/**
 * Check the part of plugin.json which defines the public runtime contract.
 * Unsupported capabilities are valid, but must declare their degradation
 * behavior so the host can make the same decision everywhere.
 */
export function validateRuntimeManifest(manifest, expectedRuntime) {
  const results = [];
  const runtimes = manifest?.contributes?.agentRuntimes;
  const runtime = Array.isArray(runtimes)
    ? runtimes.find(candidate => candidate?.type === expectedRuntime)
    : undefined;

  if (!runtime) {
    return [failure('manifest.runtime', `No ${expectedRuntime} runtime contribution was found.`)];
  }
  results.push(success('manifest.runtime', `Runtime type is ${expectedRuntime}.`));

  const capabilities = runtime?.manifest?.capabilities;
  if (!Array.isArray(capabilities)) {
    return [
      ...results,
      failure('manifest.capabilities', 'Runtime manifest has no capabilities array.'),
    ];
  }

  const seen = new Set();
  for (const capability of capabilities) {
    if (!capability || typeof capability.id !== 'string' || !capability.id) {
      results.push(failure('manifest.capability-id', 'Every capability must have a non-empty id.'));
      continue;
    }
    if (seen.has(capability.id)) {
      results.push(failure(`manifest.${capability.id}`, 'Capability id is duplicated.'));
      continue;
    }
    seen.add(capability.id);
    if (capability.supported === false && typeof capability.degradation !== 'string') {
      results.push(
        failure(
          `manifest.${capability.id}`,
          'Unsupported capabilities must declare a degradation behavior.'
        )
      );
    }
  }

  for (const id of REQUIRED_RUNTIME_CAPABILITIES) {
    if (!seen.has(id)) {
      results.push(failure(`manifest.${id}`, 'Required ZClaudia runtime capability is missing.'));
    }
  }

  if (!results.some(result => result.status === 'failed')) {
    results.push(
      success('manifest.capabilities', `${capabilities.length} capabilities are declared.`)
    );
  }
  return results;
}

function isCompletion(event) {
  return (
    (event?.type === 'result' && event.isComplete === true) ||
    (event?.type === 'provider_turn_finished' && event.isComplete === true)
  );
}

function isContent(event) {
  return [
    'assistant',
    'assistant_delta',
    'tool_use',
    'tool_started',
    'tool_activity',
    'tool_result',
  ].includes(event?.type);
}

/**
 * Execute one adapter turn in a fixture and return a serializable result.  A
 * caller can use this in Vitest tests or in a future provider fixture runner.
 */
export async function runAdapterConformanceSuite({ adapter, input, context, onPermission }) {
  const events = [];
  for await (const event of adapter.run(input, context, onPermission)) events.push(event);

  const results = [];
  const init = events.find(event => event?.type === 'init');
  if (!init?.sessionId) {
    results.push(
      failure('stream.init', 'The stream did not publish an init event with a session id.')
    );
  } else {
    results.push(success('stream.init', 'The stream published a provider session id.'));
  }

  if (!events.some(isContent)) {
    results.push(
      failure('stream.content', 'The stream did not publish assistant or tool activity.')
    );
  } else {
    results.push(success('stream.content', 'The stream published content or tool activity.'));
  }

  const completionIndex = events.findIndex(isCompletion);
  if (completionIndex === -1) {
    results.push(
      failure('stream.completion', 'The stream did not publish a terminal completion event.')
    );
  } else if (events.slice(completionIndex + 1).some(isContent)) {
    results.push(failure('stream.ordering', 'Content was emitted after terminal completion.'));
  } else {
    results.push(success('stream.completion', 'The stream completed without trailing content.'));
  }

  return {
    passed: results.every(result => result.status === 'passed'),
    events,
    results,
  };
}
