/**
 * Runtime configuration — read once from process.env.
 *
 * Set RUNTIME_MODE=docker to use the Docker sandbox.
 * Default is 'local' (in-process, same as current behaviour).
 */

import { join } from 'node:path';

export type RuntimeMode = 'local' | 'docker';

export type RuntimeConfig = {
  mode: RuntimeMode;
  anthropicApiKey: string;
  githubToken: string;
  githubOrg: string;
  dockerImage: string;
  /** Absolute path to the workspace root (contains world/, src/, …). */
  workspaceRoot: string;
};

export const loadRuntimeConfig = (): RuntimeConfig => ({
  mode: (process.env['RUNTIME_MODE'] ?? 'local') as RuntimeMode,
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
  githubToken: process.env['VIBEGUILD_GITHUB_TOKEN'] ?? '',
  githubOrg: process.env['VIBEGUILD_GITHUB_ORG'] ?? 'vibeguild',
  dockerImage: process.env['SANDBOX_DOCKER_IMAGE'] ?? 'vibeguild-sandbox',
  workspaceRoot: process.env['WORKSPACE_ROOT'] ?? process.cwd(),
});

/** Absolute path to the world/ directory (always under workspaceRoot). */
export const worldPath = (cfg: RuntimeConfig): string =>
  join(cfg.workspaceRoot, 'world');
