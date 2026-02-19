import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendEscalation } from '../memory/store.js';

// Urgency levels for human escalations
const urgencyLevels = ['low', 'normal', 'high', 'critical'] as const;
type Urgency = (typeof urgencyLevels)[number];

const URGENCY_ICONS: Record<Urgency, string> = {
  low: '📋',
  normal: '📌',
  high: '⚠️',
  critical: '🚨',
};

export const escalateToHumanSchema = {
  message: z.string().describe('The message to escalate to the human operator'),
  urgency: z
    .enum(urgencyLevels)
    .default('normal')
    .describe('Urgency level: low | normal | high | critical'),
  beingId: z
    .string()
    .optional()
    .describe('ID of the being raising the escalation (e.g. aria, bram, cleo)'),
};

export const handleEscalateToHuman = async (args: {
  message: string;
  urgency: Urgency;
  beingId?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
  const escalation = {
    id: randomUUID(),
    message: args.message,
    urgency: args.urgency,
    beingId: args.beingId,
    createdAt: new Date().toISOString(),
  };

  await appendEscalation(escalation);

  const icon = URGENCY_ICONS[args.urgency];
  const label = `[ESCALATION:${args.urgency.toUpperCase()}]`;
  const prefix = args.beingId ? `[${args.beingId}]` : '[world]';
  console.log(`\n${icon} ${label} ${prefix} ${args.message}`);

  return {
    content: [
      {
        type: 'text',
        text: `Escalation recorded (id: ${escalation.id}, urgency: ${args.urgency}). The human operator has been notified.`,
      },
    ],
  };
};

// MCP server factory — call once in world.ts and pass the result to mcpServers option
// Uses the Claude Agent SDK's in-process MCP server helper
export const createWorldMcpServer = async () => {
  // Dynamic import so we can handle cases where the SDK exports differ
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  // The SDK exports `tool` and `createSdkMcpServer` for in-process MCP
  // If your SDK version doesn't export these, use mcpServers with a stdio server instead
  if (!('tool' in sdk) || !('createSdkMcpServer' in sdk)) {
    console.warn(
      '[tools] SDK does not export `tool`/`createSdkMcpServer` — skipping in-process MCP server. ' +
      'Beings can still use the `Write` tool to record escalations manually.',
    );
    return null;
  }

  const { tool, createSdkMcpServer } = sdk as typeof sdk & {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => unknown;
    createSdkMcpServer: (opts: {
      name: string;
      version?: string;
      tools?: unknown[];
    }) => unknown;
  };

  const escalateTool = tool(
    'escalateToHuman',
    'Escalate a message, finding, or blocker to the human operator. Use when: blocked on a decision, a deliverable needs human review, or you find something the human should know immediately.',
    escalateToHumanSchema,
    async (args) => {
      const typedArgs = args as {
        message: string;
        urgency: Urgency;
        beingId?: string;
      };
      return handleEscalateToHuman(typedArgs);
    },
  );

  return createSdkMcpServer({
    name: 'vibe-guild-world-tools',
    version: '0.1.0',
    tools: [escalateTool],
  });
};
