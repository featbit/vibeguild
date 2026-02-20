/**
 * TaskRunner — one per active task.
 *
 * Each runner owns a single `query()` call (with its own AbortController and
 * session ID).  The Orchestrator prompt inside is scoped entirely to one task:
 * it assigns the leader, spawns the team via the Task tool, and instructs the
 * leader to write `world/tasks/{id}/progress.json` regularly.
 *
 * Lifecycle:
 *   start()  → first run (no session yet, or resumes from a saved task session)
 *   pause()  → abort current query(); session ID is already persisted
 *   resume() → re-enter query() using the saved session ID
 *
 * The scheduler in world.ts holds a Map<taskId, TaskRunner> and drives these
 * transitions based on world signals (rest, meetup, day-end).
 */

import { readTaskSession, writeTaskSession } from '../memory/store.js';
import { updateTaskStatus } from './queue.js';
import type { Task } from './types.js';

export type RunnerState = 'running' | 'paused' | 'completed' | 'failed';

export type RunnerOptions = {
  mcpServer?: unknown;
  modelId?: string;
  onComplete?: (taskId: string) => void;
  onError?: (taskId: string, err: Error) => void;
};

export class TaskRunner {
  readonly taskId: string;
  readonly leaderId: string;

  state: RunnerState = 'running';

  private sessionId: string | null = null;
  private abortCtrl: AbortController | null = null;
  private pendingMessages: string[] = [];
  private opts: RunnerOptions;

  constructor(task: Task, opts: RunnerOptions = {}) {
    this.taskId = task.id;
    this.leaderId = task.leaderId ?? task.assignedTo?.[0] ?? 'orchestrator';
    this.opts = opts;
  }

  get isRunning(): boolean { return this.state === 'running'; }
  get isPaused(): boolean { return this.state === 'paused'; }
  get isFinished(): boolean { return this.state === 'completed' || this.state === 'failed'; }

  /** Start for the first time (or recover if a task session already exists). */
  async start(task: Task): Promise<void> {
    this.sessionId = await readTaskSession(this.taskId);
    this.state = 'running';
    void this._execute(task);
  }

  /**
   * Abort the running query() and mark as paused.
   * The session ID was already written on every init message, so resume is safe.
   */
  pause(): void {
    if (this.abortCtrl && !this.abortCtrl.signal.aborted) {
      this.abortCtrl.abort();
    }
    this.state = 'paused';
    console.log(`\n⏸  [Runner:${this.taskId.slice(0, 8)}] Paused (session saved).`);
  }

  /** Resume after pause. Must be called with the latest task object. */
  resume(task: Task): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    console.log(`\n▶️  [Runner:${this.taskId.slice(0, 8)}] Resuming.`);
    void this._execute(task);
  }

  /** Inject a human message — will appear in the next query() prompt on resume. */
  injectMessage(msg: string): void {
    this.pendingMessages.push(msg);
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private buildPrompt(task: Task, isResume: boolean): string {
    const msgs = this.pendingMessages.splice(0);
    const lines: string[] = [];

    if (!isResume) {
      lines.push(
        `You are the Orchestrator running a SINGLE focused task.`,
        ``,
        `**Task:** ${task.title}`,
        `**Task ID:** ${task.id}`,
        `**Leader:** ${this.leaderId} — this being coordinates the team and owns all progress reporting.`,
        `**Team:** ${task.assignedTo?.join(', ') ?? this.leaderId}`,
        ``,
        `## Instructions`,
        `1. Use the Task tool to spawn **${this.leaderId}** as leader with these instructions:`,
        `   - Coordinate the team, spawn other team members in parallel if needed.`,
        `   - After each major milestone, write \`world/tasks/${task.id}/progress.json\`:`,
        `     { "taskId": "${task.id}", "leaderId": "${this.leaderId}",`,
        `       "status": "in-progress", "summary": "...", "percentComplete": 0-100,`,
        `       "checkpoints": [{"at":"<ISO>","sessionId":"<current session id>","description":"..."}],`,
        `       "lastUpdated": "<ISO>" }`,
        `   - When the task is fully done: set status "completed" in progress.json,`,
        `     then update world/tasks/queue.json task status to "completed".`,
        ``,
        `2. Respect MAX BEINGS if set: ${task.maxBeings ?? 'unlimited'}.`,
        ``,
        `## Task description`,
        task.description,
      );
    } else {
      lines.push(
        `You are the Orchestrator resuming a task after a rest or interruption.`,
        ``,
        `**Task:** ${task.title} (ID: ${task.id.slice(0, 8)})`,
        `**Leader:** ${this.leaderId}`,
        ``,
        `Spawn **${this.leaderId}** again and tell them:`,
        `  "Read world/tasks/${task.id}/progress.json — find the latest checkpoint and continue from there."`,
        `  "Your team: ${task.assignedTo?.join(', ') ?? this.leaderId}. Resume where you left off."`,
      );
    }

    if (msgs.length > 0) {
      lines.push(``, `--- MESSAGE FROM HUMAN OPERATOR ---`);
      for (const m of msgs) lines.push(`> ${m}`);
      lines.push(
        `---`,
        `Before resuming work, pass this message to ${this.leaderId} and have them:`,
        `  1. Write a checkpoint to progress.json capturing the current state.`,
        `  2. Acknowledge the human's guidance.`,
        `  3. Adjust direction if instructed, then continue.`,
      );
    }

    return lines.join('\n');
  }

  private async _execute(task: Task): Promise<void> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const isResume = !!this.sessionId;
    const prompt = this.buildPrompt(task, isResume);

    const options: Record<string, unknown> = {
      allowedTools: ['Read', 'Write', 'Bash', 'Task', 'WebSearch', 'WebFetch'],
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      maxTurns: 40,
      ...(this.opts.modelId ? { model: this.opts.modelId } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };
    if (this.opts.mcpServer) {
      options['mcpServers'] = { 'vibe-guild-world-tools': this.opts.mcpServer };
    }

    this.abortCtrl = new AbortController();
    options['abortController'] = this.abortCtrl;

    try {
      await updateTaskStatus(this.taskId, 'in-progress', task.assignedTo);

      for await (const msg of query({
        prompt,
        options: options as Parameters<typeof query>[0]['options'],
      })) {
        const m = msg as Record<string, unknown>;

        // Persist session ID so we can resume after pause/restart
        if (m['type'] === 'system' && m['subtype'] === 'init' && m['session_id']) {
          this.sessionId = m['session_id'] as string;
          void writeTaskSession(this.taskId, this.sessionId);
        }

        // Stream leader output to terminal
        if (m['type'] === 'assistant' && Array.isArray(m['content'])) {
          for (const block of m['content'] as Array<Record<string, unknown>>) {
            if (block['type'] === 'text' && block['text']) {
              process.stdout.write(
                `\n[${this.leaderId}@${this.taskId.slice(0, 8)}] ${block['text'] as string}\n`,
              );
            }
          }
        }

        if (m['result']) {
          process.stdout.write(`\n[Runner:${this.taskId.slice(0, 8)}] Turn complete.\n`);
        }

        if (this.abortCtrl.signal.aborted) break;
      }

      if (!this.abortCtrl.signal.aborted) {
        this.state = 'completed';
        await updateTaskStatus(this.taskId, 'completed');
        console.log(`\n✅ [Runner:${this.taskId.slice(0, 8)}] Task "${task.title}" completed.\n`);
        this.opts.onComplete?.(this.taskId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) {
        // Intentional pause — state was already set by pause()
      } else {
        this.state = 'failed';
        console.error(`\n❌ [Runner:${this.taskId.slice(0, 8)}] Error: ${message}\n`);
        this.opts.onError?.(
          this.taskId,
          err instanceof Error ? err : new Error(message),
        );
      }
    }
  }
}
