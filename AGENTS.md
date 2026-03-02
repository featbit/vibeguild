---
applyTo: "**"
---

# Project General Guidelines

## Working Workspaces

This repository hosts multiple independent sub-projects. Each sub-project lives in its own isolated directory:

```
workspaces/
  {project-name}/   ← each sub-project is self-contained here
  {project-name}/
  ...
```

**Key rules when working with sub-projects:**

- Treat each `workspaces/{project-name}` directory as a **standalone project** — it has its own dependencies, configuration, and conventions.
- **Do not** share or cross-reference code between sub-projects unless explicitly asked.
- When a user asks about a specific project, scope all file reads, edits, and terminal commands to that project's directory.
- If no project is specified, ask the user which sub-project to work in before proceeding.

## Skills

### Microsoft Technology Stack

For any Microsoft technology stack — such as Azure, .NET, GitHub, GitHub Copilot, etc. — in addition to the Agent Skills stored under `.agents/skills`, you can use the `microsoftdocs/mcp` MCP server to search for the latest official documentation.

### FeatBit Skills

FeatBit skills are stored under `.agents/skills/featbit/`. Use these skills to understand FeatBit concepts, feature flag management, SDK integration, and deployment patterns.

## Language

- Use English for all code comments, documentation, and communication unless the user explicitly requests another language.