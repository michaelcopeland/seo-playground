import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Every tool that spends DataForSEO credit takes a `confirm` param. When it's not `true`, the
 * tool must return this instead of making the request — an agent can preview exactly what would
 * be billed before opting in, rather than a paid call firing on the first invocation.
 */
export function dryRun(toolName: string, preview: Record<string, unknown>): CallToolResult {
  return toolResult({
    dryRun: true,
    tool: toolName,
    ...preview,
    note: 'No DataForSEO request was sent. Re-call with confirm: true to execute and bill for it.',
  });
}

export function toolResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

const MISSING_CREDS = 'DataForSEO credentials missing. Configure them in the app\'s Settings page.';

export function missingCredentialsError(): CallToolResult {
  return toolError(MISSING_CREDS);
}
