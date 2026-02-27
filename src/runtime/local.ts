/**
 * LocalAdapter — runs a world task in-process using @anthropic-ai/claude-agent-sdk.
 *
 * This is the current behaviour extracted from the old TaskRunner class.
 * Used when RUNTIME_MODE=local (the default).
 */

import { readTaskSession, writeTaskSession } from '../memory/store.js';
import { updateTaskStatus } from '../tasks/queue.js';
import type { Task } from '../tasks/types.js';
import type { AdapterOptions, AdapterState, RuntimeAdapter } from './adapter.js';

export const createLocalAdapter = (
  taskId: string,
  opts: AdapterOptions = {},
): RuntimeAdapter => {
  let state: AdapterState = 'idle';
  let sessionId: string | null = null;
  let abortCtrl: AbortController | null = null;
  const pendingMessages: string[] = [];

  // ─── prompt builder ───────────────────────────────────────────────────────

  const buildPrompt = (task: Task, isResume: boolean): string => {
    const msgs = pendingMessages.splice(0);
    const lines: string[] = [];

    if (!isResume) {
      lines.push(
        `You are an autonomous agent executing a world task.`,
        ``,
        `**Task:** ${task.title}`,
        `**Task ID:** ${task.id}`,
        ``,
        `## Task description`,
        task.description,
        ``,
        `## Your responsibilities`,
        `1. Execute this task fully and autonomously.`,
        `2. Write progress.json at every significant step:`,
        `   File: world/tasks/${task.id}/progress.json`,
        `   Schema: { taskId, worldDay (read from world/memory/world.json), reportedAt,`,
        `             status ("in-progress"|"completed"|"failed"|"waiting_for_human"), summary,`,
        `             percentComplete (0-100), checkpoints: [{at, description}] }`,
        `3. Poll for human instructions: world/tasks/${task.id}/inbox.json`,
        `4. When done: write status "completed" (or "failed").`,
      );
    } else {
      lines.push(
        `You are resuming a world task after a rest or interruption.`,
        ``,
        `**Task:** ${task.title} (ID: ${task.id.slice(0, 8)})`,
        ``,
        `Read world/tasks/${task.id}/progress.json to find the latest checkpoint and continue.`,
      );
    }

    if (msgs.length > 0) {
      lines.push(``, `--- MESSAGE FROM HUMAN OPERATOR ---`);
      for (const m of msgs) lines.push(`> ${m}`);
      lines.push(
        `---`,
        `Acknowledge the human's guidance, adjust direction if instructed, then continue.`,
      );
    }

    return lines.join('\n');
  };

  // ─── execution ────────────────────────────────────────────────────────────

  const execute = async (task: Task): Promise<void> => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const isResume = !!sessionId;
    const prompt = buildPrompt(task, isResume);

    const options: Record<string, unknown> = {
      allowedTools: ['Read', 'Write', 'Bash', 'Task', 'WebSearch', 'WebFetch'],
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      maxTurns: 40,
      ...(opts.modelId ? { model: opts.modelId } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
    };
    if (opts.mcpServer) {
      options['mcpServers'] = { 'vibe-guild-world-tools': opts.mcpServer };
    }

    abortCtrl = new AbortController();
    options['abortController'] = abortCtrl;

    try {
      await updateTaskStatus(taskId, 'in-progress');

      for await (const msg of query({
        prompt,
        options: options as Parameters<typeof query>[0]['options'],
      })) {
        const m = msg as Record<string, unknown>;

        if (m['type'] === 'system' && m['subtype'] === 'init' && m['session_id']) {
          sessionId = m['session_id'] as string;
          void writeTaskSession(taskId, sessionId);
        }

        if (m['type'] === 'assistant' && Array.isArray(m['content'])) {
          for (const block of m['content'] as Array<Record<string, unknown>>) {
            if (block['type'] === 'text' && block['text']) {
              process.stdout.write(`\n[agent@${taskId.slice(0, 8)}] ${block['text'] as string}\n`);
            }
          }
        }

        if (m['result']) {
          process.stdout.write(`\n[Local:${taskId.slice(0, 8)}] Turn complete.\n`);
        }

        if (abortCtrl.signal.aborted) break;
      }

      if (!abortCtrl.signal.aborted) {
        state = 'completed';
        await updateTaskStatus(taskId, 'completed');
        console.log(`\n✅ [Local:${taskId.slice(0, 8)}] Task "${task.title}" completed.\n`);
        opts.onComplete?.(taskId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) {
        // Intentional pause — state already set by pause()
      } else {
        state = 'failed';
        console.error(`\n❌ [Local:${taskId.slice(0, 8)}] Error: ${message}\n`);
        opts.onError?.(taskId, err instanceof Error ? err : new Error(message));
      }
    }
  };

  // ─── adapter interface ────────────────────────────────────────────────────

  return {
    taskId,
    get state() { return state; },

    start: async (task: Task) => {
      sessionId = await readTaskSession(taskId);
      state = 'running';
      void execute(task);
    },

    pause: async () => {
      if (abortCtrl && !abortCtrl.signal.aborted) {
        abortCtrl.abort();
      }
      state = 'paused';
      console.log(`\n⏸  [Local:${taskId.slice(0, 8)}] Paused (session saved).`);
    },

    resume: async (task: Task) => {
      if (state !== 'paused') return;
      state = 'running';
      console.log(`\n▶️  [Local:${taskId.slice(0, 8)}] Resuming.`);
      void execute(task);
    },

    injectMessage: async (msg: string) => {
      pendingMessages.push(msg);
    },

    release: async () => {
      if (abortCtrl && !abortCtrl.signal.aborted) {
        abortCtrl.abort();
      }
      state = 'completed';
    },
  };
};
