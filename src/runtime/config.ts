/**
 * Runtime configuration — read once from process.env.
 *
 * Set RUNTIME_MODE=docker to use the Docker sandbox.
 * Default is 'local' (in-process, same as current behaviour).
 */

import { join } from 'node:path';

export type RuntimeMode = 'local' | 'docker';

/**
 * v1 — single Claude session (current default).
 * v2 — leader spawns team members as independent subagents via Claude's Task tool.
 */
export type ExecutionMode = 'v1' | 'v2';

export type RuntimeConfig = {
  mode: RuntimeMode;
  anthropicApiKey: string;
  /** Optional: custom Anthropic-compatible base URL (e.g. third-party provider). */
  anthropicBaseUrl: string;
  /** Optional: model override passed to claude CLI inside the sandbox. */
  anthropicModel: string;
  dockerImage: string;
  /**
   * Execution model inside the sandbox.
   * v1 = single-session leader (default), v2 = leader + subagents via Task tool.
   */
  executionMode: ExecutionMode;
  /** Absolute path to the workspace root (contains world/, src/, …). */
  workspaceRoot: string;
  /**
   * Host path to the FeatBit marketplace skills directory.
   * Mounted read-only into the sandbox at /home/sandbox/.claude/plugins/marketplaces/featbit-marketplace/skills.
   * Defaults to $HOME/.claude/plugins/marketplaces/featbit-marketplace/skills
   * Override with FEATBIT_SKILLS_HOST_PATH.
   */
  featbitSkillsHostPath: string;
  /**
   * Optional: host path to the shared agent skills directory (.agent/).
   * Mounted read-only into the sandbox at /home/sandbox/.agent.
   * Override with AGENT_HOME_HOST_PATH.
   */
  agentHomeHostPath: string;
};

export const loadRuntimeConfig = (): RuntimeConfig => ({
  mode: (process.env['RUNTIME_MODE'] ?? 'local') as RuntimeMode,
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
  anthropicBaseUrl: process.env['ANTHROPIC_BASE_URL'] ?? '',
  // Support both ANTHROPIC_MODEL and ANTHROPIC_MODEL_ID (the latter is used by world.ts)
  anthropicModel: process.env['ANTHROPIC_MODEL'] ?? process.env['ANTHROPIC_MODEL_ID'] ?? '',
  dockerImage: process.env['SANDBOX_DOCKER_IMAGE'] ?? 'vibeguild-sandbox',
  executionMode: (process.env['EXECUTION_MODE'] ?? 'v1') as ExecutionMode,
  workspaceRoot: process.env['WORKSPACE_ROOT'] ?? process.cwd(),
  featbitSkillsHostPath:
    process.env['FEATBIT_SKILLS_HOST_PATH'] ??
    `${process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''}/.claude/plugins/marketplaces/featbit-marketplace/skills`,
  agentHomeHostPath:
    process.env['AGENT_HOME_HOST_PATH'] ??
    `${process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''}/.agent`,
});

/** Absolute path to the world/ directory (always under workspaceRoot). */
export const worldPath = (cfg: RuntimeConfig): string =>
  join(cfg.workspaceRoot, 'world');
