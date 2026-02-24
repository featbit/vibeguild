#!/usr/bin/env node
/**
 * Vibe Guild — World Setup Assistant
 *
 * A conversational AI agent for configuring the world at runtime.
 * Run in a terminal separate from `npm start`:
 *
 *   node --env-file=.env scripts/vg-setup.mjs
 *   # or:
 *   npm run setup
 *
 * Capabilities:
 *   • List / add / remove MCP servers (persisted to world/shared/mcp-servers.json)
 *   • Test whether an MCP endpoint is reachable
 *   • List / add / remove shared skills (world/shared/skills/)
 *   • Show full world config (hardcoded + dynamic)
 *
 * Uses direct Anthropic-compatible HTTP API (GLM-compatible, no SDK needed).
 */

import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const worldRoot  = join(scriptDir, '..', 'world');
const sharedDir  = join(worldRoot, 'shared');
const mcpFile    = join(sharedDir, 'mcp-servers.json');
const skillsDir  = join(sharedDir, 'skills');

// ── env ────────────────────────────────────────────────────────────────────────
const API_KEY  = process.env['ANTHROPIC_API_KEY'] ?? '';
const BASE_URL = (process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/$/, '');
const MODEL    = process.env['ANTHROPIC_MODEL_ID'] ?? process.env['ANTHROPIC_MODEL'] ?? 'claude-3-5-sonnet-20241022';

if (!API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is not set. Run with: node --env-file=.env scripts/vg-setup.mjs');
  process.exit(1);
}

// ── file helpers ───────────────────────────────────────────────────────────────
const safeReadJson = async (filePath) => {
  try { return JSON.parse(await readFile(filePath, 'utf-8')); } catch { return null; }
};

const writeJson = async (filePath, data) => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

// ── tool handler implementations ───────────────────────────────────────────────
const handlers = {

  async list_world_config() {
    const hardcodedModule = join(scriptDir, '..', 'src', 'sandbox', 'mcp-servers.mjs');
    let hardcoded = {};
    try {
      const { getMcpServers } = await import(pathToFileURL(hardcodedModule).href);
      hardcoded = getMcpServers(process.env);
    } catch { hardcoded = {}; }

    const dynamic = (await safeReadJson(mcpFile)) ?? {};
    let skills = [];
    try { skills = (await readdir(skillsDir)).filter(f => f.endsWith('.md')); } catch { /* dir may not exist */ }

    return {
      hardcoded_mcp_servers: hardcoded,
      dynamic_mcp_servers: dynamic,
      shared_skills: skills,
      note: 'Dynamic servers override hardcoded ones on name collision. Both are merged at container startup.',
    };
  },

  async add_mcp_server({ name, url, token, transport = 'streamableHttp' }) {
    const registry = (await safeReadJson(mcpFile)) ?? {};
    registry[name] = {
      transport,
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    };
    await writeJson(mcpFile, registry);
    return { success: true, message: `MCP server "${name}" saved to world/shared/mcp-servers.json.` };
  },

  async remove_mcp_server({ name }) {
    const registry = (await safeReadJson(mcpFile)) ?? {};
    if (!(name in registry)) {
      return { success: false, message: `"${name}" not found in dynamic registry.` };
    }
    delete registry[name];
    await writeJson(mcpFile, registry);
    return { success: true, message: `MCP server "${name}" removed.` };
  },

  async test_mcp_connection({ url, token }) {
    // Send the MCP initialize handshake (JSON-RPC 2.0 over streamableHttp)
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vg-setup-test', version: '0.1' },
      },
    });

    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
      const text = await res.text();

      // SSE response: extract first JSON data line
      let parsed = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          try { parsed = JSON.parse(line.slice(5).trim()); break; } catch { /* */ }
        }
      }
      // Plain JSON response
      if (!parsed) {
        try { parsed = JSON.parse(text); } catch { /* */ }
      }

      if (res.ok && parsed?.result) {
        return {
          success: true,
          status: res.status,
          server_info: parsed.result?.serverInfo ?? parsed.result,
          message: '✅ MCP endpoint responded successfully to initialize handshake.',
        };
      }
      return {
        success: false,
        status: res.status,
        body_preview: text.slice(0, 300),
        message: `⚠️  Endpoint responded with status ${res.status} but no valid MCP result.`,
      };
    } catch (err) {
      return {
        success: false,
        message: `❌ Connection failed: ${err.message}`,
      };
    }
  },

  async add_skill({ name, content }) {
    await mkdir(skillsDir, { recursive: true });
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const filePath = join(skillsDir, `${slug}.md`);
    await writeFile(filePath, `# ${name}\n\n${content}\n`, 'utf-8');
    return { success: true, file: `world/shared/skills/${slug}.md` };
  },

  async remove_skill({ filename }) {
    const filePath = join(skillsDir, filename.endsWith('.md') ? filename : `${filename}.md`);
    if (!existsSync(filePath)) return { success: false, message: `"${filename}" not found.` };
    await unlink(filePath);
    return { success: true, message: `Skill "${filename}" removed.` };
  },
};

// ── tool definitions (Anthropic JSON schema format) ─────────────────────────────
const TOOLS = [
  {
    name: 'list_world_config',
    description: 'Show all registered MCP servers (hardcoded + dynamic) and shared skills. Call this first to understand the current state before making changes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_mcp_server',
    description: 'Register a new MCP server in the dynamic world registry (world/shared/mcp-servers.json). Takes effect for all new sandbox tasks. Does NOT affect running containers.',
    input_schema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Unique identifier, e.g. "glm-web-search-prime"' },
        url:       { type: 'string', description: 'Full HTTPS URL of the streamableHttp MCP endpoint' },
        token:     { type: 'string', description: 'Bearer token for Authorization header (optional)' },
        transport: { type: 'string', enum: ['streamableHttp'], description: 'Transport type (default: streamableHttp)' },
      },
      required: ['name', 'url'],
    },
  },
  {
    name: 'remove_mcp_server',
    description: 'Remove a dynamically registered MCP server by name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'test_mcp_connection',
    description: 'Test whether an MCP endpoint responds to the JSON-RPC initialize handshake. Run this before adding a server unless the user says to skip.',
    input_schema: {
      type: 'object',
      properties: {
        url:   { type: 'string', description: 'MCP endpoint URL to test' },
        token: { type: 'string', description: 'Bearer token for the test request (optional)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'add_skill',
    description: 'Write a shared skill Markdown file to world/shared/skills/. All beings read these at the start of every task.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Short skill name' },
        content: { type: 'string', description: 'Full skill content in Markdown' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'remove_skill',
    description: 'Remove a shared skill file by filename (with or without .md).',
    input_schema: {
      type: 'object',
      properties: { filename: { type: 'string' } },
      required: ['filename'],
    },
  },
];

const SYSTEM = `You are the Vibe Guild Setup Assistant. Help the operator configure world-shared MCP servers and skills.

When the operator wants to add an MCP server:
- Extract the server name, URL, and auth token from whatever they provide (JSON, plain text, mixed)
- If the token looks like a placeholder (xxxx, <token>, etc.), ask once for the real value or offer to use the env key: ${API_KEY}
- Call test_mcp_connection first, then add_mcp_server
- Confirm when done

Present config in human-friendly format. Be concise.

Available tools: list_world_config, add_mcp_server, remove_mcp_server, test_mcp_connection, add_skill, remove_skill.`;

// ── pre-process user message: detect MCP JSON snippets and inject structured hints ──

const callApi = async (messages) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let res;
  try {
    res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, messages, tools: TOOLS }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('API timeout (60s) — GLM did not respond. Try again.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
};

const startSpinner = (label = '🤔 Thinking') => {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  process.stdout.write('\n');
  const id = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${label}...`);
  }, 80);
  return () => { clearInterval(id); process.stdout.write('\r\x1b[K'); };
};

const runAgentTurn = async (messages) => {
  while (true) {
    const stopSpinner = startSpinner();
    const response = await callApi(messages);
    stopSpinner();
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (text) console.log(`\n🌐 Assistant: ${text}\n`);
      break;
    }

    const preText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (preText.trim()) console.log(`\n🌐 Assistant: ${preText}`);

    const toolResults = [];
    for (const toolUse of toolUses) {
      process.stdout.write(`\n🔧 [${toolUse.name}] `);
      let result;
      try {
        const fn = handlers[toolUse.name];
        if (!fn) throw new Error(`Unknown tool: ${toolUse.name}`);
        result = await fn(toolUse.input);
        console.log(JSON.stringify(result));
      } catch (err) {
        result = { error: err.message };
        console.log(`ERROR: ${err.message}`);
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
    // loop: model sees tool results and continues reasoning
  }
};

// ── main conversation loop ─────────────────────────────────────────────────────
const main = async () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║      Vibe Guild — World Setup Assistant               ║');
  console.log('║  Configure MCP servers and shared skills              ║');
  console.log('║  Type your request. Press Enter twice to send.        ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n  API: ${BASE_URL}  Model: ${MODEL}\n`);

  const messages = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Greet with current state
  messages.push({ role: 'user', content: 'Hello! Show me the current world config so I know where we stand.' });
  await runAgentTurn(messages);

  // Multi-line input buffer: accumulate lines, send on blank line (double Enter)
  let inputBuffer = [];

  const askUser = () => {
    if (rl.closed) return;
    const isBuffering = inputBuffer.length > 0;
    const promptText = isBuffering ? '... ' : 'You: ';
    try {
      rl.question(promptText, async (line) => {
        if (!isBuffering && (line.trim() === 'exit' || line.trim() === 'quit' || line.trim() === '/exit')) {
          console.log('\nGoodbye!\n');
          rl.close();
          process.exit(0);
        }

        if (line.trim() === '' && inputBuffer.length > 0) {
          // Blank line = end of multi-line input, send accumulated message
          const fullInput = inputBuffer.join('\n').trim();
          inputBuffer = [];
          if (fullInput) {
            messages.push({ role: 'user', content: fullInput });
            try {
              await runAgentTurn(messages);
            } catch (err) {
              console.error(`\n❌ Error: ${err.message}\n`);
            }
          }
        } else if (line.trim() !== '') {
          inputBuffer.push(line);
          if (!isBuffering) {
            // First line of a new message — show hint on first non-empty line
            process.stdout.write('  (press Enter on blank line to send, or keep typing)\n');
          }
        }
        askUser();
      });
    } catch (err) {
      if (err.code !== 'ERR_USE_AFTER_CLOSE') console.error('readline error:', err.message);
    }
  };

  askUser();
};

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
