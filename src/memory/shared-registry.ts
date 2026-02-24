/**
 * World-shared registry helpers.
 *
 * The operator (creator) can dynamically register MCP servers and skills at
 * runtime via console commands (/add-mcp, /add-skill). Entries are persisted
 * in world/shared/ so every new sandbox container picks them up automatically.
 *
 * world/shared/mcp-servers.json  — dynamic MCP server additions (merged with
 *   the hardcoded servers in src/sandbox/mcp-servers.mjs at container startup)
 *
 * world/shared/skills/<name>.md  — operator-authored skill files; beings read
 *   these during task execution (world/shared/ is mounted :ro in sandboxes)
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// ─── types ────────────────────────────────────────────────────────────────────

export type McpServerEntry = {
  transport: 'streamableHttp' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
};

export type McpServerRegistry = Record<string, McpServerEntry>;

// ─── paths ────────────────────────────────────────────────────────────────────

const sharedDir  = (worldRoot: string) => join(worldRoot, 'shared');
const mcpFile    = (worldRoot: string) => join(worldRoot, 'shared', 'mcp-servers.json');
const skillsDir  = (worldRoot: string) => join(worldRoot, 'shared', 'skills');

// ─── MCP server registry ─────────────────────────────────────────────────────

export const readMcpRegistry = async (worldRoot: string): Promise<McpServerRegistry> => {
  try {
    const raw = await readFile(mcpFile(worldRoot), 'utf-8');
    return JSON.parse(raw) as McpServerRegistry;
  } catch {
    return {};
  }
};

export const addMcpServer = async (
  worldRoot: string,
  name: string,
  entry: McpServerEntry,
): Promise<void> => {
  await mkdir(sharedDir(worldRoot), { recursive: true });
  const registry = await readMcpRegistry(worldRoot);
  registry[name] = entry;
  await writeFile(mcpFile(worldRoot), JSON.stringify(registry, null, 2), 'utf-8');
};

export const removeMcpServer = async (worldRoot: string, name: string): Promise<boolean> => {
  const registry = await readMcpRegistry(worldRoot);
  if (!(name in registry)) return false;
  delete registry[name];
  await writeFile(mcpFile(worldRoot), JSON.stringify(registry, null, 2), 'utf-8');
  return true;
};

// ─── Skill registry ───────────────────────────────────────────────────────────

export const addSharedSkill = async (
  worldRoot: string,
  name: string,
  content: string,
): Promise<string> => {
  const dir = skillsDir(worldRoot);
  await mkdir(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const filePath = join(dir, `${slug}.md`);
  const body = `# ${name}\n\n${content}\n`;
  await writeFile(filePath, body, 'utf-8');
  return filePath;
};

export const listSharedSkills = async (worldRoot: string): Promise<string[]> => {
  try {
    const files = await readdir(skillsDir(worldRoot));
    return files.filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
};
