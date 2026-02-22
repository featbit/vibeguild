/**
 * RuntimeAdapter — the single abstraction point for task execution.
 *
 * The control plane never invokes Claude SDK or Docker directly.
 * It calls this interface, and the concrete adapter (local / docker)
 * takes care of the rest.
 */

import type { Task } from '../tasks/types.js';

export type AdapterState = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

/** Minimum progress snapshot the sandbox must sync into world/tasks/{id}/progress.json */
export type SyncedProgress = {
  taskId: string;
  leaderId: string;
  worldDay: number;
  reportedAt: string;
  /**
   * 'waiting_for_human' — leader is blocked on a decision and requires operator input
   * before it can proceed. The entrypoint will pause and await an inbox response.
   */
  status: 'in-progress' | 'completed' | 'failed' | 'blocked' | 'waiting_for_human';
  summary: string;
  percentComplete: number;
  checkpoints: Array<{ at: string; sessionId?: string; description: string }>;
  blockers?: string[];
  escalations?: string[];
  sandboxRepoUrl?: string;
  /** Present when status is 'waiting_for_human' — describes the specific question/decision */
  question?: string;
};

export type AdapterOptions = {
  mcpServer?: unknown;
  modelId?: string;
  onProgress?: (progress: SyncedProgress) => void;
  onComplete?: (taskId: string) => void;
  onError?: (taskId: string, err: Error) => void;
};

/**
 * RuntimeAdapter — abstracts how a world task is executed.
 * Implementations: LocalAdapter (SDK, in-process) and DockerSandboxAdapter.
 */
export interface RuntimeAdapter {
  readonly taskId: string;
  readonly state: AdapterState;
  start(task: Task): Promise<void>;
  pause(): Promise<void>;
  resume(task: Task): Promise<void>;
  /** Inject an operator instruction into the running (or next) turn. */
  injectMessage(msg: string): Promise<void>;
  /** Release the adapter; clean up resources after task is done/aborted. */
  release(): Promise<void>;
}
