import { createInterface, type Interface } from 'node:readline/promises';
import type { PermissionDecision, PermissionRequest } from '@zclaudia/plugin-sdk/providers';
import type { PermissionHandler } from '@zclaudia/agent-runtime';
import type { PermissionMode } from './options.js';

export class TerminalPrompter {
  private readonly readline: Interface;

  constructor() {
    this.readline = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    });
  }

  async question(prompt: string): Promise<string> {
    return await this.readline.question(prompt);
  }

  permissionHandler(mode: PermissionMode): PermissionHandler {
    if (mode === 'allow') {
      return async request => ({
        behavior: 'allow',
        updatedInput: request.toolInput,
      });
    }
    if (mode === 'deny') {
      return async () => ({
        behavior: 'deny',
        message: 'Denied by standalone host policy.',
      });
    }
    if (!process.stdin.isTTY) {
      return async () => ({
        behavior: 'deny',
        message: 'Interactive permission requested without a TTY.',
      });
    }
    return request => this.askPermission(request);
  }

  close(): void {
    this.readline.close();
  }

  private async askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    process.stderr.write(
      `\nPermission requested\n  tool: ${request.toolName}\n  detail: ${request.detail}\n`
    );
    const answer = (await this.question('Allow? [y/N] ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      return { behavior: 'allow', updatedInput: request.toolInput };
    }
    return { behavior: 'deny', message: 'Denied by user.' };
  }
}
