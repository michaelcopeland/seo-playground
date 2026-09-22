#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRankTrackerTools } from './tools/rank-tracker';
import { registerKeywordResearchTools } from './tools/keyword-research';
import { registerDomainAnalyticsTools } from './tools/domain-analytics';
import { registerBacklinksTools } from './tools/backlinks';
import { registerAiVisibilityTools } from './tools/ai-visibility';

async function main() {
  const server = new McpServer({ name: 'seo-playground', version: '0.1.0' });

  registerRankTrackerTools(server);
  registerKeywordResearchTools(server);
  registerDomainAnalyticsTools(server);
  registerBacklinksTools(server);
  registerAiVisibilityTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
