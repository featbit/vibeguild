/**
 * createTaskRunner — factory that returns a WorldTaskRunner.
 *
 * Selects LocalAdapter (RUNTIME_MODE=local, default) or DockerSandboxAdapter
 * (RUNTIME_MODE=docker) based on the env config.  World.ts drives the lifecycle;
 * it never calls the SDK or Docker directly — only this interface.
 *
 * Lifecycle:
 *   createTaskRunner(task, opts) → runner
 *   runner.start(task)           → kicks off execution
 *   runner.pause()               → fire-and-forget, delegates to adapter
 *   runner.resume(task)          → fire-and-forget, delegates to adapter
 *   runner.injectMessage(msg)    → fire-and-forget, delegates to adapter
 *   runner.release()             → cleanup
 */

import { loadRuntimeConfig } from '../runtime/config.js';
import { createLocalAdapter } from '../runtime/local.js';
import { createDockerSandboxAdapter } from '../runtime/docker.js';
import type { Task } from './types.js';
import type { AdapterOptions } from '../runtime/adapter.js';

export type RunnerOptions = AdapterOptions;

export type WorldTaskRunner = {
  readonly taskId: string;
  readonly isPaused: boolean;
  readonly isRunning: boolean;
  readonly isFinished: boolean;
  start(task: Task): Promise<void>;
  /** Fire-and-forget. Delegates to the underlying adapter. */
  pause(): void;
  /** Fire-and-forget. Delegates to the underlying adapter. */
  resume(task: Task): void;
  /** Fire-and-forget. Delegates to the underlying adapter. */
  injectMessage(msg: string): void;
  /** Fire-and-forget cleanup. */
  release(): void;
};

export const createTaskRunner = (task: Task, opts: RunnerOptions = {}): WorldTaskRunner => {
  const cfg = loadRuntimeConfig();

  const adapter =
    cfg.mode === 'docker'
      ? createDockerSandboxAdapter(task.id, opts)
      : createLocalAdapter(task.id, opts);

  return {
    taskId: task.id,

    get isPaused()  { return adapter.state === 'paused'; },
    get isRunning() { return adapter.state === 'running'; },
    get isFinished() {
      return adapter.state === 'completed' || adapter.state === 'failed';
    },

    start:         (t: Task)   => adapter.start(t),
    pause:         ()          => { void adapter.pause(); },
    resume:        (t: Task)   => { void adapter.resume(t); },
    injectMessage: (msg: string) => { void adapter.injectMessage(msg); },
    release:       ()          => { void adapter.release(); },
  };
};

// ─── Dead code removed below — no legacy class ───────────────────────────────
// The old TaskRunner class has been fully replaced by createTaskRunner() above.
// DO NOT reintroduce the class; it violates the FP policy in AGENTS.md.

