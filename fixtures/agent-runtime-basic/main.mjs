export async function activate(context) {
  context.agentRuntimes.register({
    type: 'fixture',
    async *run(input) {
      yield { type: 'init', sessionId: 'fixture-session' };
      yield { type: 'assistant_delta', content: input };
      yield { type: 'provider_turn_finished', isComplete: true };
    },
  });
}
