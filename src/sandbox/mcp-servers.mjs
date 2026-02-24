/**
 * Vibe Guild — World-shared MCP Server Definitions
 *
 * This is the single place to register MCP servers (and tool configs) that every
 * sandbox task inherits. entrypoint.mjs calls getMcpServers(process.env) and writes
 * the result into /tmp/vibeguild-mcp.json before launching the claude CLI.
 *
 * To add a new server:
 *   1. Add an entry to the object returned below.
 *   2. Rebuild the sandbox image if the server requires a new npm package inside
 *      the container; otherwise no rebuild is needed (file is mounted :ro).
 *
 * Auth convention: tokens that already exist in the container environment (e.g.
 * ANTHROPIC_API_KEY) are read from `env` — no extra secrets needed.
 */

/**
 * @param {Record<string, string|undefined>} env  process.env of the container
 * @returns {Record<string, object>}  mcpServers map compatible with claude --mcp-config
 */
export const getMcpServers = (env) => ({

  // ── Add hardcoded world-default MCP servers here ────────────────────────────
  // These are inherited by every sandbox task automatically.
  // For operator-managed servers, use: npm run setup
  //
  // Example:
  // 'my-tool': {
  //   transport: 'streamableHttp',
  //   url: 'https://example.com/mcp',
  //   headers: { Authorization: `Bearer ${env['MY_TOOL_TOKEN'] ?? ''}` },
  // },

});
