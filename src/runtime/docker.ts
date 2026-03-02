/**
 * DockerSandboxAdapter — runs each world task in a dedicated Docker container.
 *
 * Each container uses PRECISE volume mounts for isolation:
 *   - world/memory/world.json          :ro  — read dayCount, never write
 *   - world/tasks/{taskId}/             :rw  — progress.json + inbox.json (this task only)
 *   - world/{demos|examples|insights}/…  :rw  — per-task persistent execution workspace
 *   - output/{taskId}/                  :rw  — per-task deliverables directory (isolated per task)
 *   - Host Claude marketplace skills    :ro  — FeatBit marketplace skills for task execution
 *   - src/sandbox/entrypoint.mjs        :ro  — the script that drives execution
 *   - AGENTS.md                         :ro  — world rules and being identity
 *
 * Other than these explicit mounts, no host source paths are visible inside the container.
 * This prevents a sandbox from reading/writing task-unrelated project files or source code.
 *
 * Sync mechanism: entrypoint writes progress.json → chokidar on host detects change
 * → onProgress callback → printed to creator console in real-time.
 *
 * Requires RUNTIME_MODE=docker and a pre-built image (SANDBOX_DOCKER_IMAGE).
 */

import { spawn, exec as execCb } from 'node:child_process';
import { mkdir, appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { watch } from 'chokidar';
import { writeTaskInbox, readProgressSync } from './sync.js';
import { updateTaskStatus, updateTaskSandbox } from '../tasks/queue.js';
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

const workspaceBucketForTask = (task: Task): 'demos' | 'examples' | 'insights' | 'workspaces' => {
  if (task.taskKind === 'demo' || task.taskKind === 'skill_demo_trigger') return 'demos';
  if (task.taskKind === 'skill_validation' || task.taskKind === 'issue_feedback') return 'examples';
  if (task.taskKind === 'dev_insight_blog' || task.taskKind === 'learning_note') return 'insights';
  return 'workspaces';
};

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';

// ─── factory ─────────────────────────────────────────────────────────────────

export const createDockerSandboxAdapter = (
  taskId: string,
  opts: AdapterOptions = {},
): RuntimeAdapter => {
  const cfg = loadRuntimeConfig();
  const wPath = worldPath(cfg);
  const taskDir = join(wPath, 'tasks', taskId);
  const logsDir = join(taskDir, 'logs');

  const ctx = {
    state: 'idle' as AdapterState,
    containerId: null as string | null,
    progressWatcher: null as ReturnType<typeof watch> | null,
  };

  const pendingMessages: string[] = [];

  const appendTaskLog = async (file: string, line: string): Promise<void> => {
    await mkdir(logsDir, { recursive: true });
    await appendFile(join(logsDir, file), `${line}\n`, 'utf-8');
  };

  const logRuntime = async (message: string): Promise<void> => {
    const ts = new Date().toISOString();
    await appendTaskLog('runtime.log', `[${ts}] ${message}`);
  };

  const logProgressEvent = async (progress: unknown): Promise<void> => {
    const event = {
      at: new Date().toISOString(),
      taskId,
      progress,
    };
    await appendTaskLog('progress-events.ndjson', JSON.stringify(event));
  };

  const captureDockerLogs = async (): Promise<void> => {
    if (!ctx.containerId) return;
    try {
      const { stdout: logs, stderr: logsErr } = await execAsync(`docker logs ${ctx.containerId}`);
      const allLogs = [logs.trim(), logsErr ? `[stderr]\n${logsErr.trim()}` : '']
        .filter(Boolean)
        .join('\n');
      if (allLogs) {
        await appendTaskLog('docker.log', allLogs);
        console.error(`\n📋 [Sandbox:${taskId.slice(0, 8)}] Container logs:\n${allLogs}`);
      }
    } catch {
      // ignore
    }
  };

  const stopWatcher = () => {
    ctx.progressWatcher?.close().catch(() => undefined);
    ctx.progressWatcher = null;
  };

  const startProgressWatch = () => {
    const progressFile = join(taskDir, 'progress.json');
    ctx.progressWatcher = watch(progressFile, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });

    const onProgressFile = () => {
      void readProgressSync(wPath, taskId).then(async (p) => {
        if (p?.sandboxWorkspacePath) {
          await updateTaskSandbox(taskId, { workspacePath: p.sandboxWorkspacePath }).catch(() => undefined);
        }
        if (p) opts.onProgress?.(p);
        if (p) await logProgressEvent(p).catch(() => undefined);
      });
    };

    ctx.progressWatcher.on('add', onProgressFile);
    ctx.progressWatcher.on('change', onProgressFile);
  };

  return {
    taskId,
    get state() { return ctx.state; },

    start: async (task: Task) => {
      ctx.state = 'running';
      const workspaceBucket = workspaceBucketForTask(task);
      const workspaceDirName = `${task.id.slice(0, 8)}-${slugify(task.title)}`;
      const taskWorkspaceRelative = `world/${workspaceBucket}/${workspaceDirName}`;

      const claudeHomeDir = join(taskDir, 'claude-home');
      const taskWorkspaceDir = join(wPath, workspaceBucket, workspaceDirName);
      const taskOutputDir = join(cfg.workspaceRoot, 'output', taskId);

      await mkdir(taskDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(claudeHomeDir, { recursive: true });
      await mkdir(taskWorkspaceDir, { recursive: true });
      await mkdir(taskOutputDir, { recursive: true });
      await logRuntime(`Task runner starting (mode=docker)`);

      const containerName = `vibeguild-${taskId.slice(0, 8)}`;
      const sharedDir = join(wPath, 'shared');

      await mkdir(sharedDir, { recursive: true });

      const dockerArgs = [
        '--name', containerName,
        '-v', `${wPath}/memory/world.json:/workspace/world/memory/world.json:ro`,
        '-v', `${join(cfg.workspaceRoot, 'AGENTS.md')}:/workspace/AGENTS.md:ro`,
        '-v', `${join(cfg.workspaceRoot, 'src', 'sandbox', 'entrypoint.mjs')}:/workspace/src/sandbox/entrypoint.mjs:ro`,
        '-v', `${join(cfg.workspaceRoot, 'src', 'sandbox', 'mcp-servers.mjs')}:/workspace/src/sandbox/mcp-servers.mjs:ro`,
        '-v', `${join(wPath, 'shared')}:/workspace/world/shared:ro`,
        '-v', `${taskDir}:/workspace/world/tasks/${taskId}`,
        '-v', `${taskWorkspaceDir}:/workspace/task-workspace`,
        '-v', `${claudeHomeDir}:/home/sandbox/.claude`,
        '-v', `${cfg.featbitSkillsHostPath}:/home/sandbox/.claude/plugins/marketplaces/featbit-marketplace/skills:ro`,
        ...(cfg.agentHomeHostPath ? ['-v', `${cfg.agentHomeHostPath}:/home/sandbox/.agent:ro`] : []),
        '-v', `${taskOutputDir}:/workspace/output`,
        '-w', '/workspace',
        '-e', `TASK_ID=${task.id}`,
        '-e', `TASK_TITLE=${encodeURIComponent(task.title)}`,
        '-e', `TASK_DESCRIPTION=${encodeURIComponent(task.description)}`,
        '-e', `TASK_KIND=${task.taskKind}`,
        '-e', `TASK_LEAD_ROLE=${task.leadRole}`,
        '-e', `ANTHROPIC_API_KEY=${cfg.anthropicApiKey}`,
        ...(cfg.anthropicBaseUrl ? ['-e', `ANTHROPIC_BASE_URL=${cfg.anthropicBaseUrl}`] : []),
        ...(cfg.anthropicModel ? ['-e', `ANTHROPIC_MODEL=${cfg.anthropicModel}`] : []),
        '-e', `EXECUTION_MODE=${cfg.executionMode}`,
        '-e', `HOME=/home/sandbox`,
        '-e', `TASK_WORKSPACE_PATH=/workspace/task-workspace`,
        '-e', `TASK_WORKSPACE_HOST_PATH=${taskWorkspaceRelative}`,
        cfg.dockerImage,
        'node', '/workspace/src/sandbox/entrypoint.mjs',
      ];

      await updateTaskStatus(taskId, 'in-progress');
      await execAsync(`docker rm -f ${containerName}`).catch(() => undefined);

      ctx.containerId = await dockerRunDetached(dockerArgs);
      await updateTaskSandbox(taskId, {
        containerId: ctx.containerId,
        workspacePath: taskWorkspaceRelative,
      });
      await logRuntime(`Container started: ${ctx.containerId}`);
      console.log(`\n🐳 [Sandbox:${taskId.slice(0, 8)}] Container ${ctx.containerId.slice(0, 12)} started.`);
      opts.onLog?.(`🐳 [Sandbox:${taskId.slice(0, 8)}] Container started.`, taskId);

      startProgressWatch();

      void (async () => {
        try {
          const exitCode = await waitForContainer(ctx.containerId!);
          stopWatcher();

          if (ctx.state === 'paused') return;

          if (exitCode === 0) {
            const progress = await readProgressSync(wPath, taskId);
            const progressStatus = progress?.status;

            if (progressStatus === 'completed') {
              ctx.state = 'completed';
              await updateTaskStatus(taskId, 'completed');
              await logRuntime('Container finished successfully and progress status is completed.');
              console.log(`\n✅ [Sandbox:${taskId.slice(0, 8)}] Container finished successfully.`);
              opts.onLog?.(`✅ [Sandbox:${taskId.slice(0, 8)}] Container finished successfully.`, taskId);
              // Ensure onProgress fires with the final completed snapshot (watcher may have missed it)
              if (progress) opts.onProgress?.(progress);
              await execAsync(`docker rm ${ctx.containerId}`).catch(() => undefined);
              opts.onComplete?.(taskId);
              return;
            }

            ctx.state = 'failed';
            await updateTaskStatus(taskId, 'failed');
            const reason = progress
              ? `Container exited with code 0 but progress status is "${progressStatus ?? 'unknown'}".`
              : 'Container exited with code 0 but no progress.json was found.';
            await logRuntime(`FAILED: ${reason}`);
            console.error(`\n❌ [Sandbox:${taskId.slice(0, 8)}] ${reason}`);
            opts.onLog?.(`❌ [Sandbox:${taskId.slice(0, 8)}] Failed: ${reason}`, taskId);
            await captureDockerLogs();
            await execAsync(`docker rm ${ctx.containerId}`).catch(() => undefined);
            opts.onError?.(taskId, new Error(reason));
            return;
          }

          await captureDockerLogs();
          await execAsync(`docker rm ${ctx.containerId}`).catch(() => undefined);
          ctx.state = 'failed';
          await updateTaskStatus(taskId, 'failed');
          const err = new Error(`Sandbox container exited with code ${exitCode}`);
          await logRuntime(`FAILED: ${err.message}`);
          console.error(`\n❌ [Sandbox:${taskId.slice(0, 8)}] ${err.message}`);
          // Capture container logs for operator diagnostics
          try {
            const { stdout: logs, stderr: logsErr } = await execAsync(`docker logs ${ctx.containerId}`);
            const allLogs = [logs.trim(), logsErr ? logsErr.trim() : ''].filter(Boolean).join('\n');
            if (allLogs) opts.onLog?.(`❌ [Sandbox:${taskId.slice(0, 8)}] Exit ${exitCode}\n${allLogs.slice(0, 1500)}`, taskId);
            else opts.onLog?.(`❌ [Sandbox:${taskId.slice(0, 8)}] Exit ${exitCode} — no logs`, taskId);
          } catch { opts.onLog?.(`❌ [Sandbox:${taskId.slice(0, 8)}] Exit ${exitCode}`, taskId); }
          opts.onError?.(taskId, err);
        } catch (err) {
          if (ctx.state !== 'paused') {
            ctx.state = 'failed';
            await updateTaskStatus(taskId, 'failed').catch(() => undefined);
            await logRuntime(`FAILED: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
            opts.onError?.(taskId, err instanceof Error ? err : new Error(String(err)));
          }
        }
      })();
    },

    pause: async () => {
      if (ctx.containerId && ctx.state === 'running') {
        await execAsync(`docker pause ${ctx.containerId}`);
        ctx.state = 'paused';
        await logRuntime(`Container paused: ${ctx.containerId}`);
        console.log(`\n⏸  [Sandbox:${taskId.slice(0, 8)}] Container ${ctx.containerId.slice(0, 12)} paused.`);
      }
    },

    resume: async (_task: Task) => {
      if (ctx.containerId && ctx.state === 'paused') {
        await execAsync(`docker unpause ${ctx.containerId}`);
        ctx.state = 'running';
        await logRuntime(`Container resumed: ${ctx.containerId}`);
        console.log(`\n▶️  [Sandbox:${taskId.slice(0, 8)}] Container ${ctx.containerId.slice(0, 12)} resumed.`);
      }
    },

    injectMessage: async (msg: string) => {
      pendingMessages.push(msg);
      await writeTaskInbox(wPath, taskId, [...pendingMessages]);
      await logRuntime(`Operator message injected (${msg.length} chars).`);
      console.log(`\n💬 [Sandbox:${taskId.slice(0, 8)}] Message written to inbox.json.`);
    },

    release: async () => {
      stopWatcher();
      if (ctx.containerId) {
        try {
          await execAsync(`docker stop ${ctx.containerId}`);
          await logRuntime(`Container stopped during release: ${ctx.containerId}`);
        } catch {
          // Container may have already exited — ignore
        }
      }
      ctx.state = 'completed';
    },
  };
};
