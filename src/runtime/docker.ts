/**
 * DockerSandboxAdapter — runs each world task in a dedicated Docker container.
 *
 * Each container uses PRECISE volume mounts for isolation:
 *   - world/memory/world.json          :ro  — read dayCount, never write
 *   - world/tasks/{taskId}/             :rw  — progress.json + inbox.json (this task only)
 *   - world/beings/{id}/                :rw  — per assigned being only (other beings invisible)
 *   - output/                           :rw  — shared deliverables directory
 *   - src/sandbox/entrypoint.mjs        :ro  — the script that drives execution
 *   - AGENTS.md                         :ro  — world rules and being identity
 *
 * No other host filesystem paths are visible inside the container.
 * This prevents a sandbox from reading/writing other tasks' data or source code.
 *
 * Sync mechanism: entrypoint writes progress.json → chokidar on host detects change
 * → onProgress callback → printed to creator console in real-time.
 *
 * Requires RUNTIME_MODE=docker and a pre-built image (SANDBOX_DOCKER_IMAGE).
 */

import { spawn, exec as execCb } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { watch } from 'chokidar';
import { writeTaskInbox, readProgressSync } from './sync.js';
import { createTaskRepo } from '../github/repo.js';
import { updateTaskStatus } from '../tasks/queue.js';
import { loadRuntimeConfig, worldPath } from './config.js';
import type { Task } from '../tasks/types.js';
import type { AdapterOptions, AdapterState, RuntimeAdapter } from './adapter.js';

const execAsync = promisify(execCb);

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run `docker run -d …` and return the trimmed container ID. */
const dockerRunDetached = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawn('docker', ['run', '-d', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker run failed (${code}): ${stderr.trim()}`));
    });
  });

/** Block until the container exits; resolves with its exit code. */
const waitForContainer = (id: string): Promise<number> =>
  new Promise((resolve) => {
    const proc = spawn('docker', ['wait', id], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', () => resolve(parseInt(output.trim(), 10) || 0));
  });

// ─── factory ─────────────────────────────────────────────────────────────────

export const createDockerSandboxAdapter = (
  taskId: string,
  leaderId: string,
  opts: AdapterOptions = {},
): RuntimeAdapter => {
  const cfg = loadRuntimeConfig();
  const wPath = worldPath(cfg);

  // Mutable state in an object so TypeScript can't narrow it across async closures.
  // TypeScript narrows closed-over `let` variables but NOT property accesses.
  const ctx = {
    state: 'idle' as AdapterState,
    containerId: null as string | null,
    sandboxRepoUrl: null as string | null,
    progressWatcher: null as ReturnType<typeof watch> | null,
  };

  const pendingMessages: string[] = [];

  const stopWatcher = () => {
    ctx.progressWatcher?.close().catch(() => undefined);
    ctx.progressWatcher = null;
  };

  const startProgressWatch = () => {
    const progressFile = join(wPath, 'tasks', taskId, 'progress.json');
    ctx.progressWatcher = watch(progressFile, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });
    ctx.progressWatcher.on('change', () => {
      void readProgressSync(wPath, taskId).then((p) => {
        if (p) opts.onProgress?.(p);
      });
    });
  };

  // ─── adapter ───────────────────────────────────────────────────────────────

  return {
    taskId,
    get state() { return ctx.state; },

    start: async (task: Task) => {
      ctx.state = 'running';

      // Create a GitHub repo for this task's execution artifacts (best-effort)
      if (cfg.githubToken) {
        try {
          const repo = await createTaskRepo({
            taskId,
            taskTitle: task.title,
            org: cfg.githubOrg,
            token: cfg.githubToken,
          });
          ctx.sandboxRepoUrl = repo.url;
          console.log(`\n🔧 [Sandbox:${taskId.slice(0, 8)}] GitHub repo: ${repo.url}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`\n⚠️  [Sandbox:${taskId.slice(0, 8)}] GitHub repo creation skipped: ${msg}`);
        }
      }

      // Build docker run args
      const containerName = `vibeguild-${taskId.slice(0, 8)}`;

      // ── Precise volume mounts (isolation boundary) ───────────────────────
      // Pre-create host-side directories so Docker doesn't create them as root-owned.
      const taskDir    = join(wPath, 'tasks', taskId);
      const beingsRoot = join(wPath, 'beings');
      const assignedBeings = task.assignedTo ?? [leaderId];
      await mkdir(taskDir, { recursive: true });
      await Promise.all(assignedBeings.map((id) => mkdir(join(beingsRoot, id), { recursive: true })));

      // Per-being mounts: only the assigned beings' directories are writable.
      // Every other being's data is invisible to this container.
      const beingMounts = assignedBeings.flatMap((id) => [
        '-v', `${beingsRoot}/${id}:/workspace/world/beings/${id}`,
      ]);

      const dockerArgs = [
        // No --rm: we keep the container on failure so we can capture logs
        '--name', containerName,
        // ── Read-only context ────────────────────────────────────────────
        // World-level metadata (dayCount, worldStatus — never written by sandbox)
        '-v', `${wPath}/memory/world.json:/workspace/world/memory/world.json:ro`,
        // World rules and being identity (AGENTS.md)
        '-v', `${join(cfg.workspaceRoot, 'AGENTS.md')}:/workspace/AGENTS.md:ro`,
        // Sandbox entrypoint script
        '-v', `${join(cfg.workspaceRoot, 'src', 'sandbox', 'entrypoint.mjs')}:/workspace/src/sandbox/entrypoint.mjs:ro`,
        // ── Read-write: this task only ──────────────────────────────────
        // progress.json and inbox.json for this specific task
        '-v', `${taskDir}:/workspace/world/tasks/${taskId}`,
        // ── Read-write: assigned beings only ────────────────────────────
        ...beingMounts,
        // ── Read-write: shared output directory (deliverables) ──────────
        '-v', `${join(cfg.workspaceRoot, 'output')}:/workspace/output`,
        '-w', '/workspace',
        '-e', `TASK_ID=${task.id}`,
        '-e', `TASK_TITLE=${encodeURIComponent(task.title)}`,
        '-e', `TASK_DESCRIPTION=${encodeURIComponent(task.description)}`,
        '-e', `LEADER_ID=${leaderId}`,
        '-e', `ASSIGNED_TO=${task.assignedTo?.join(',') ?? leaderId}`,
        '-e', `ANTHROPIC_API_KEY=${cfg.anthropicApiKey}`,
        ...(cfg.anthropicBaseUrl ? ['-e', `ANTHROPIC_BASE_URL=${cfg.anthropicBaseUrl}`] : []),
        ...(cfg.anthropicModel ? ['-e', `ANTHROPIC_MODEL=${cfg.anthropicModel}`] : []),
        '-e', `VIBEGUILD_GITHUB_TOKEN=${cfg.githubToken}`,
        '-e', `VIBEGUILD_GITHUB_ORG=${cfg.githubOrg}`,
        ...(ctx.sandboxRepoUrl ? ['-e', `SANDBOX_REPO_URL=${ctx.sandboxRepoUrl}`] : []),
        cfg.dockerImage,
        'node', '/workspace/src/sandbox/entrypoint.mjs',
      ];

      await updateTaskStatus(taskId, 'in-progress', task.assignedTo);
      ctx.containerId = await dockerRunDetached(dockerArgs);
      console.log(`\n🐳 [Sandbox:${taskId.slice(0, 8)}] Container ${ctx.containerId.slice(0, 12)} started.`);

      startProgressWatch();

      // Wait for the container to finish in the background.
      // Reading ctx.state (property access) — TypeScript cannot narrow property
      // accesses the way it narrows let-variables, so these comparisons are safe.
      void (async () => {
        try {
          const exitCode = await waitForContainer(ctx.containerId!);
          stopWatcher();
          if (ctx.state === 'paused') {
            // Container was stopped by release() while paused — not an error
            return;
          }
          if (exitCode === 0) {
            ctx.state = 'completed';
            await updateTaskStatus(taskId, 'completed');
            console.log(`\n✅ [Sandbox:${taskId.slice(0, 8)}] Container finished successfully.`);
            await execAsync(`docker rm ${ctx.containerId}`).catch(() => undefined);
            opts.onComplete?.(taskId);
          } else {
            // Capture logs (stdout + stderr) before removing the container
            try {
              const { stdout: logs, stderr: logsErr } = await execAsync(`docker logs ${ctx.containerId}`);
              const allLogs = [logs.trim(), logsErr ? `[stderr]\n${logsErr.trim()}` : '']
                .filter(Boolean).join('\n');
              if (allLogs) {
                console.error(`\n📋 [Sandbox:${taskId.slice(0, 8)}] Container logs:\n${allLogs}`);
              }
            } catch { /* ignore */ }
            await execAsync(`docker rm ${ctx.containerId}`).catch(() => undefined);
            ctx.state = 'failed';
            const err = new Error(`Sandbox container exited with code ${exitCode}`);
            console.error(`\n❌ [Sandbox:${taskId.slice(0, 8)}] ${err.message}`);
            opts.onError?.(taskId, err);
          }
        } catch (err) {
          if (ctx.state !== 'paused') {
            ctx.state = 'failed';
            opts.onError?.(taskId, err instanceof Error ? err : new Error(String(err)));
          }
        }
      })();
    },

    pause: async () => {
      if (ctx.containerId && ctx.state === 'running') {
        await execAsync(`docker pause ${ctx.containerId}`);
        ctx.state = 'paused';
        console.log(`\n⏸  [Sandbox:${taskId.slice(0, 8)}] Container ${ctx.containerId.slice(0, 12)} paused.`);
      }
    },

    resume: async (_task: Task) => {
      if (ctx.containerId && ctx.state === 'paused') {
        await execAsync(`docker unpause ${ctx.containerId}`);
        ctx.state = 'running';
        console.log(`\n▶️  [Sandbox:${taskId.slice(0, 8)}] Container ${ctx.containerId.slice(0, 12)} resumed.`);
      }
    },

    injectMessage: async (msg: string) => {
      pendingMessages.push(msg);
      await writeTaskInbox(wPath, taskId, [...pendingMessages]);
      console.log(`\n💬 [Sandbox:${taskId.slice(0, 8)}] Message written to inbox.json.`);
    },

    release: async () => {
      stopWatcher();
      if (ctx.containerId) {
        try {
          await execAsync(`docker stop ${ctx.containerId}`);
        } catch {
          // Container may have already exited — ignore
        }
      }
      ctx.state = 'completed';
    },
  };
};
