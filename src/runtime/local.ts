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
  leaderId: string,
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
        `You are the Orchestrator running a SINGLE focused task.`,
        ``,
        `**Task:** ${task.title}`,
        `**Task ID:** ${task.id}`,
        `**Leader:** ${leaderId} — this being leads the team and owns all progress reporting.`,
        `**Team:** ${task.assignedTo?.join(', ') ?? leaderId}`,
        ``,
        `## Instructions`,
        `1. Use the Task tool to spawn **${leaderId}** as leader with ALL of the following instructions:`,
        ``,
        `   ### Leader responsibilities`,
        `   - Coordinate the team. Spawn other team members in parallel as needed.`,
        `   - You decide WHEN to write a progress report — trust your own judgment on meaningful`,
        `     checkpoints. But every time you do report, FIRST read \`world/memory/world.json\``,
        `     to get the current \`dayCount\`, then write \`world/tasks/${task.id}/progress.json\`:`,
        `     {`,
        `       "taskId": "${task.id}",`,
        `       "leaderId": "${leaderId}",`,
        `       "worldDay": <dayCount from world.json>,`,
        `       "reportedAt": "<ISO timestamp>",`,
        `       "status": "in-progress",`,
        `       "summary": "...",`,
        `       "percentComplete": 0-100,`,
        `       "checkpoints": [{ "at": "<ISO>", "sessionId": "<current>", "description": "..." }]`,
        `     }`,
        `   - When the task is fully done: write a final progress.json with status "completed",`,
        `     then update world/tasks/queue.json to mark this task "completed".`,
        ``,
        `   ### Instructions to pass to each team member when you spawn them`,
        `   Tell every non-leader being you spawn:`,
        `   "When you finish your assigned node or subtask, write a self-summary to`,
        `    \`world/beings/{YOUR_BEING_ID}/memory/self-notes/<ISO-timestamp>.json\``,
        `    with: what you did, key decisions you made, what you learned, anything worth remembering.`,
        `    Format is free — write what is genuinely useful to your future self."`,
        ``,
        `2. MAX BEINGS: ${task.maxBeings ?? 'unlimited'} — this is the total number of distinct beings`,
        `   you may use across the entire task (including yourself as leader).`,
        `   Do not spawn more unique beings than this limit, even across multiple rounds.`,
        ``,
        `## Task description`,
        task.description,
      );
    } else {
      lines.push(
        `You are the Orchestrator resuming a task after a rest or interruption.`,
        ``,
        `**Task:** ${task.title} (ID: ${task.id.slice(0, 8)})`,
        `**Leader:** ${leaderId}`,
        ``,
        `Spawn **${leaderId}** again and tell them:`,
        `  "Read world/tasks/${task.id}/progress.json — find the latest checkpoint and continue from there."`,
        `  "Your team: ${task.assignedTo?.join(', ') ?? leaderId}. Resume where you left off."`,
      );
    }

    if (msgs.length > 0) {
      lines.push(``, `--- MESSAGE FROM HUMAN OPERATOR ---`);
      for (const m of msgs) lines.push(`> ${m}`);
      lines.push(
        `---`,
        `Before resuming work, pass this message to ${leaderId} and have them:`,
        `  1. Write a checkpoint to progress.json capturing the current state.`,
        `  2. Acknowledge the human's guidance.`,
        `  3. Adjust direction if instructed, then continue.`,
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
      await updateTaskStatus(taskId, 'in-progress', task.assignedTo);

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
              process.stdout.write(`\n[${leaderId}@${taskId.slice(0, 8)}] ${block['text'] as string}\n`);
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
