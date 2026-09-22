import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCredentials, getSetting, getTargetDomains, addTargetDomain, removeTargetDomain,
  getTrackedKeywords, addTrackedKeyword, removeTrackedKeyword,
  getRankHistory, getLatestRankCheck, saveRankCheck,
  type TrackedKeyword,
} from '../../src/lib/db';
import { dryRun, toolResult, toolError, missingCredentialsError } from '../guardrails';
import { RANK_TRACKER_ADD_CAP } from '../limits';

function cleanDomain(d: string) {
  return d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

interface SerpItem {
  type: string;
  rank_absolute: number;
  url?: string;
  title?: string;
  domain?: string;
}

interface SerpResponse {
  tasks?: Array<{ status_code?: number; status_message?: string; cost?: number; result?: Array<{ items?: SerpItem[] }> }>;
}

/**
 * Same behavior as `checkKeywordsBatch` in `src/app/dashboard/rank-tracker/actions.ts`, which
 * isn't exported. One task per request: the live SERP endpoint executes only the first task of
 * an array and rejects the rest with 40000 "You can set only one task at a time".
 * Failures are counted as skipped and existing data is kept.
 */
async function checkKeywordsBatch(
  keywords: Array<{ id: number; keyword: string; domain: string; location: string; language: string }>,
  login: string,
  pass: string,
): Promise<{ checked: number; skipped: number; totalCost: number }> {
  const depth = parseInt(getSetting('rank_tracker_depth') ?? '100', 10);
  const auth = btoa(`${login}:${pass}`);
  let checked = 0;
  let skipped = 0;
  let totalCost = 0;

  for (const kw of keywords) {
    let res: Response;
    try {
      res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: kw.keyword, location_name: kw.location, language_name: kw.language, depth }]),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      console.error(`[rank-tracker] SERP request failed for "${kw.keyword}":`, err);
      skipped++;
      continue;
    }
    if (!res.ok) {
      console.error(`[rank-tracker] SERP request for "${kw.keyword}" returned HTTP ${res.status}`);
      skipped++;
      continue;
    }

    const task = ((await res.json()) as SerpResponse).tasks?.[0];
    if (task?.status_code !== 20000) {
      console.error(`[rank-tracker] SERP check failed for "${kw.keyword}": ${task?.status_code ?? 'no task'} ${task?.status_message ?? ''}`);
      skipped++;
      continue;
    }

    const items = task.result?.[0]?.items ?? [];
    const cost = task.cost ?? null;
    if (cost) totalCost += cost;

    const domain = cleanDomain(kw.domain).split('/')[0];
    const hit = items.find((item) => {
      if (item.type !== 'organic') return false;
      const d = cleanDomain(item.domain ?? item.url ?? '').split('/')[0];
      return d === domain || d.endsWith('.' + domain);
    });

    saveRankCheck(kw.id, hit?.rank_absolute ?? null, hit?.url ?? null, hit?.title ?? null, cost);
    checked++;
  }

  return { checked, skipped, totalCost };
}

function keywordSummary(kw: TrackedKeyword) {
  const latest = getLatestRankCheck(kw.id);
  return {
    id: kw.id,
    keyword: kw.keyword,
    domain: kw.domain,
    location: kw.location,
    language: kw.language,
    latestPosition: latest?.position ?? null,
    latestUrl: latest?.url ?? null,
    lastCheckedAt: latest ? new Date(latest.checkedAt).toISOString() : null,
  };
}

export function registerRankTrackerTools(server: McpServer) {
  server.registerTool(
    'list_tracked_domains',
    {
      title: 'List Rank Tracker domains',
      description: 'Local read, no cost. Lists every domain tracked in Rank Tracker, with a keyword count for each.',
      inputSchema: {},
    },
    async () => {
      const savedDomains = getTargetDomains();
      const allKeywords = getTrackedKeywords();
      const kwDomains = [...new Set(allKeywords.map((k) => k.domain))];
      const domains = [...new Set([...savedDomains, ...kwDomains])];
      return toolResult(domains.map((domain) => ({
        domain,
        keywordCount: allKeywords.filter((k) => k.domain === domain).length,
      })));
    },
  );

  server.registerTool(
    'list_tracked_keywords',
    {
      title: 'List Rank Tracker keywords',
      description: 'Local read, no cost. Lists tracked keywords (optionally filtered to one domain) with their latest rank check.',
      inputSchema: { domain: z.string().optional().describe('Limit to this domain; omit for all domains') },
    },
    async ({ domain }) => {
      const keywords = getTrackedKeywords().filter((k) => !domain || k.domain === domain);
      return toolResult(keywords.map(keywordSummary));
    },
  );

  server.registerTool(
    'get_keyword_rank_history',
    {
      title: 'Get keyword rank history',
      description: 'Local read, no cost. Daily rank history for one tracked keyword.',
      inputSchema: { id: z.number().describe('Tracked keyword id, from list_tracked_keywords'), days: z.number().optional().default(30) },
    },
    async ({ id, days }) => {
      const history = getRankHistory(id, days ?? 30);
      return toolResult(history);
    },
  );

  server.registerTool(
    'add_tracked_domain',
    {
      title: 'Add Rank Tracker domain',
      description: 'Local write, no cost. Adds a domain to Rank Tracker (no keywords yet).',
      inputSchema: { domain: z.string() },
    },
    async ({ domain }) => {
      addTargetDomain(domain);
      return toolResult({ added: cleanDomain(domain) });
    },
  );

  server.registerTool(
    'remove_tracked_domain',
    {
      title: 'Remove Rank Tracker domain',
      description: 'Local write, no cost. Removes a domain from the target_domains list (does not remove its tracked keywords).',
      inputSchema: { domain: z.string() },
    },
    async ({ domain }) => {
      removeTargetDomain(domain);
      return toolResult({ removed: domain });
    },
  );

  server.registerTool(
    'add_tracked_keywords',
    {
      title: 'Add and check Rank Tracker keywords',
      description:
        `Adds up to ${RANK_TRACKER_ADD_CAP} keywords to a domain and immediately rank-checks all of them. ` +
        `PAID — bills DataForSEO once per keyword (one SERP request per keyword). ` +
        'Call without confirm first to preview the count, then again with confirm: true to execute.',
      inputSchema: {
        keywords: z.array(z.string()).max(RANK_TRACKER_ADD_CAP),
        domain: z.string(),
        location: z.string().optional(),
        language: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keywords, domain, location, language, confirm }) => {
      const kwList = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, RANK_TRACKER_ADD_CAP);
      if (kwList.length === 0) return toolError('No non-empty keywords provided.');

      if (!confirm) {
        return dryRun('add_tracked_keywords', { domain, keywordCount: kwList.length, billedCalls: kwList.length });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      addTargetDomain(domain);
      const loc = location?.trim() || getSetting('default_location') || 'France';
      const lang = language?.trim() || getSetting('default_language') || 'French';

      const toCheck = kwList.map((keyword) => ({
        id: addTrackedKeyword(keyword, domain, loc, lang),
        keyword, domain, location: loc, language: lang,
      }));

      const result = await checkKeywordsBatch(toCheck, creds.login, creds.pass);
      return toolResult({ domain, added: toCheck.length, ...result });
    },
  );

  server.registerTool(
    'check_keyword',
    {
      title: 'Re-check one tracked keyword',
      description: 'PAID — one DataForSEO SERP call. Re-checks a single tracked keyword\'s current rank.',
      inputSchema: { id: z.number().describe('Tracked keyword id, from list_tracked_keywords'), confirm: z.boolean().optional() },
    },
    async ({ id, confirm }) => {
      const kw = getTrackedKeywords().find((k) => k.id === id);
      if (!kw) return toolError(`No tracked keyword with id ${id}.`);

      if (!confirm) return dryRun('check_keyword', { id, keyword: kw.keyword, domain: kw.domain, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const result = await checkKeywordsBatch([kw], creds.login, creds.pass);
      return toolResult({ ...result, latest: keywordSummary(kw) });
    },
  );

  server.registerTool(
    'check_domain_keywords',
    {
      title: 'Re-check all keywords for a domain',
      description: `PAID — one DataForSEO SERP call per keyword. Re-checks every tracked keyword for one domain.`,
      inputSchema: { domain: z.string(), confirm: z.boolean().optional() },
    },
    async ({ domain, confirm }) => {
      const keywords = getTrackedKeywords().filter((k) => k.domain === domain);
      if (keywords.length === 0) return toolError(`No tracked keywords for domain ${domain}.`);

      if (!confirm) return dryRun('check_domain_keywords', { domain, keywordCount: keywords.length, billedCalls: keywords.length });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const result = await checkKeywordsBatch(keywords, creds.login, creds.pass);
      return toolResult({ domain, ...result });
    },
  );

  server.registerTool(
    'check_all_keywords',
    {
      title: 'Re-check every tracked keyword',
      description: `PAID — one DataForSEO SERP call per keyword across every domain. This is the "Check All" button — it re-bills for every tracked keyword every time.`,
      inputSchema: { confirm: z.boolean().optional() },
    },
    async ({ confirm }) => {
      const keywords = getTrackedKeywords();
      if (keywords.length === 0) return toolError('No tracked keywords.');

      if (!confirm) return dryRun('check_all_keywords', { keywordCount: keywords.length, billedCalls: keywords.length });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const result = await checkKeywordsBatch(keywords, creds.login, creds.pass);
      return toolResult(result);
    },
  );
}
