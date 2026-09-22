import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCredentials,
  getBacklinksHistory, saveBacklinksSearch, getBacklinksResult, getBacklinksLinks, type BacklinksSearchEntry,
  getAnchorsHistory, saveAnchorsSearch, getAnchorsResults, type AnchorsSearchEntry,
  getBlBulkBlHistory, saveBlBulkBl, getBlBulkBlResults, type BlBulkBlEntry,
  getBlBulkRdHistory, saveBlBulkRd, getBlBulkRdResults, type BlBulkRdEntry,
  getBlDomIntHistory, saveBlDomInt, getBlDomIntResults, type BlDomIntEntry,
  getBlHistHistory, saveBlHist, getBlHistResults, type BlHistEntry,
  getBlPageIntHistory, saveBlPageInt, getBlPageIntResults, type BlPageIntEntry,
  getRefDomainsHistory, saveRefDomainsSearch, getRefDomainsResults, type RefDomainsSearchEntry,
  getBlRefNetHistory, saveBlRefNet, getBlRefNetResults, type BlRefNetEntry,
} from '../../src/lib/db';
import { dryRun, toolResult, toolError, missingCredentialsError } from '../guardrails';
import { callDataForSeoFirst } from '../../src/lib/dataforseo';
import { stableSearchId } from '../../src/lib/dedupe';
import { BULK_TARGET_CAP, BACKLINKS_PAGE_INTERSECTION_CAP } from '../limits';

// ---- Shared cleaning helpers (mirror each page.tsx's own normalization exactly, so the
// stableSearchId we compute here matches the id the page would compute for the same input —
// that's what lets a search made through the UI show up as a cache hit through the MCP tool
// and vice versa). ----

/** Mirrors `backlinks/page.tsx`'s local `cleanTarget`: strip protocol + leading www, take first path segment. */
function cleanTargetPathStrip(t: string) {
  return t.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

/** Mirrors the `bulk-backlinks` / `bulk-referring-domains` / `domain-intersection` / `history` /
 * `referring-networks` pages' inline normalization: trim, lowercase, strip protocol, strip trailing slash. */
function cleanHost(t: string) {
  return t.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ---- Types (local copies matching each page.tsx's response shape, not imported from src/) ----

interface LinkTypes {
  anchor?: number; image?: number; redirect?: number; canonical?: number; alternate?: number;
  hreflang?: number; nofollow_link?: number; form?: number; frame?: number; comment?: number;
}

interface BacklinksSummary {
  target?: string; rank?: number; backlinks?: number; new_backlinks?: number; lost_backlinks?: number;
  referring_domains?: number; new_referring_domains?: number; lost_referring_domains?: number;
  referring_ips?: number; referring_subnets?: number; referring_pages?: number;
  broken_backlinks?: number; broken_pages?: number; spam_score?: number;
  referring_links_types?: LinkTypes; referring_links_tld?: Record<string, number>;
}

interface BacklinkItem {
  type?: string; domain_from?: string; url_from?: string; domain_to?: string; url_to?: string;
  page_from_rank?: number; domain_from_rank?: number; anchor?: string; alt?: string; image_url?: string;
  dofollow?: boolean; original?: boolean; is_broken?: boolean; url_to_status_code?: number;
  attributes?: string[]; first_seen?: string; last_seen?: string;
}

interface AnchorItem {
  anchor: string; backlinks: number; referring_domains: number; broken_backlinks: number;
  broken_pages: number; dofollow: number; nofollow: number; first_seen: string; last_seen: string;
}

interface BulkBlItem { target?: string; backlinks?: number; }

interface BulkRdItem {
  target?: string; referring_domains?: number; referring_main_domains?: number; referring_ips?: number;
  broken_backlinks?: number; broken_pages?: number; referring_domains_nofollow?: number;
}

interface DomIntItem {
  domain_from?: string; domain_from_rank?: number; backlinks_from_target1?: number;
  backlinks_from_target2?: number; first_seen?: string; last_seen?: string;
}

interface HistoryPoint {
  date?: string; backlinks?: number; new_backlinks?: number; lost_backlinks?: number;
  referring_domains?: number; new_referring_domains?: number; lost_referring_domains?: number;
  referring_main_domains?: number;
}

interface PageIntItem {
  url_from?: string; domain_from?: string; page_from_rank?: number; backlinks_spam_score?: number;
  url_to?: string[];
}

interface RefDomain {
  domain?: string; domain_from_rank?: number; backlinks?: number; broken_backlinks?: number;
  first_seen?: string; last_seen?: string; is_broken?: boolean; is_redirect?: boolean;
}

interface NetworkItem {
  network_address?: string; ip_count?: number; referring_domains?: number; backlinks?: number; rank?: number;
}

// ---- Bulk target-list normalization ----

/** Mirrors the `bulk-*` pages: split on newline (also accepts an array here), clean each host, drop empties, cap. */
function normalizeBulkTargets(targets: string[]): string[] {
  return targets.map((t) => cleanHost(t)).filter(Boolean).slice(0, BULK_TARGET_CAP);
}

/** Mirrors `page-intersection`: trim only (targets are URLs, not bare domains), drop empties, cap. */
function normalizePageIntTargets(targets: string[]): string[] {
  return targets.map((t) => t.trim()).filter(Boolean).slice(0, BACKLINKS_PAGE_INTERSECTION_CAP);
}

export function registerBacklinksTools(server: McpServer) {
  // ---- 1. Backlinks overview (summary/live + backlinks/live combined) ----
  server.registerTool(
    'get_backlinks_overview',
    {
      title: 'Get Backlinks overview',
      description:
        'Backlink profile summary and a page of backlink links for a domain (mirrors the Backlinks dashboard page, which fires both calls together). ' +
        'PAID — on a cache miss, bills DataForSEO twice: one backlinks/summary/live call and one backlinks/backlinks/live call. ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        target: z.string().describe('Domain to analyze, e.g. example.com'),
        limit: z.number().optional().describe('Max links to return (default 100, capped at 1000)'),
        orderBy: z.string().optional().describe(
          "Sort for the links list, one of 'domain_from_rank,desc' (default), 'page_from_rank,desc', 'first_seen,desc', 'first_seen,asc'",
        ),
        dofollow: z.boolean().optional().describe('Filter to dofollow-only (true) or nofollow-only (false); omit for all links'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, limit, orderBy, dofollow, confirm }) => {
      const clean = cleanTargetPathStrip(target.trim());
      if (!clean) return toolError('No target provided.');
      const lim = Math.min(limit ?? 100, 1000);
      const orderByVal = orderBy ?? 'domain_from_rank,desc';
      const dofollowFilter = dofollow === true ? true : dofollow === false ? false : null;

      const dedupeId = stableSearchId(['backlinks', clean, lim, orderByVal, dofollowFilter]);
      const cachedSummary = getBacklinksResult<BacklinksSummary>(dedupeId);

      if (cachedSummary) {
        const links = getBacklinksLinks<BacklinkItem>(dedupeId) ?? [];
        const cachedEntry = getBacklinksHistory().find((e) => e.id === dedupeId);
        return toolResult({
          target: clean, summary: cachedSummary, links,
          linksTotal: cachedEntry?.linksTotal ?? links.length,
          cost: cachedEntry?.cost, cached: true,
        });
      }

      if (!confirm) {
        return dryRun('get_backlinks_overview', { target: clean, limit: lim, orderBy: orderByVal, dofollow: dofollowFilter, billedCalls: 2 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const summaryRes = await callDataForSeoFirst<BacklinksSummary>('backlinks/summary/live', { target: clean }, { login: creds.login, pass: creds.pass });

      const linksBody: Record<string, unknown> = { target: clean, limit: lim, include_subdomains: true, order_by: [orderByVal] };
      if (dofollowFilter !== null) linksBody.filters = ['dofollow', '=', dofollowFilter];
      const linksRes = await callDataForSeoFirst<{ total_count?: number; items?: BacklinkItem[] }>(
        'backlinks/backlinks/live', linksBody, { login: creds.login, pass: creds.pass },
      );

      if (summaryRes.error || linksRes.error) {
        return toolError(summaryRes.error ?? linksRes.error ?? 'Unknown error.');
      }

      const summary = summaryRes.result ?? {};
      const links = linksRes.result?.items ?? [];
      const linksTotal = linksRes.result?.total_count ?? 0;
      const cost = (summaryRes.cost ?? 0) + (linksRes.cost ?? 0);

      if (Object.keys(summary).length > 0 || links.length > 0) {
        const entry: BacklinksSearchEntry = { id: dedupeId, ts: Date.now(), target: clean, cost, linksTotal };
        saveBacklinksSearch(entry, summary, links, linksTotal);
      }

      return toolResult({ target: clean, summary, links, linksTotal, cost });
    },
  );

  // ---- 2. Anchors ----
  server.registerTool(
    'get_backlink_anchors',
    {
      title: 'Get backlink anchor text distribution',
      description:
        'Anchor text distribution of backlinks pointing to a target. ' +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/anchors/live). ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        target: z.string().describe('Domain, subdomain, or URL to analyze'),
        limit: z.number().optional().describe('Max anchors to return (default 100, capped at 1000)'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, limit, confirm }) => {
      const t = target.trim();
      if (!t) return toolError('No target provided.');
      const lim = Math.min(limit ?? 100, 1000);

      const dedupeId = stableSearchId(['anchors', t, lim]);
      const cached = getAnchorsResults<AnchorItem>(dedupeId);
      if (cached) {
        const cachedEntry = getAnchorsHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: t, items: cached, total: cachedEntry?.total ?? cached.length, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_backlink_anchors', { target: t, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ total_count?: number; items?: AnchorItem[] }>(
        'backlinks/anchors/live', { target: t, limit: lim, order_by: ['backlinks,desc'], include_subdomains: true },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      const total = result?.total_count ?? 0;
      if (items.length > 0) {
        const entry: AnchorsSearchEntry = { id: dedupeId, ts: Date.now(), target: t, cost, total };
        saveAnchorsSearch(entry, items);
      }
      return toolResult({ target: t, items, total, cost });
    },
  );

  // ---- 3. Bulk backlinks ----
  server.registerTool(
    'get_bulk_backlinks',
    {
      title: 'Get bulk backlink counts',
      description:
        `Total backlink count for up to ${BULK_TARGET_CAP} domains in a single request. ` +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/bulk_backlinks/live), regardless of target count. ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        targets: z.array(z.string()).max(BULK_TARGET_CAP).describe('Domains to check'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ targets, confirm }) => {
      const targetList = normalizeBulkTargets(targets);
      if (targetList.length === 0) return toolError('No non-empty targets provided.');

      const dedupeId = stableSearchId(['bulk-backlinks', targetList.join(',')]);
      const cached = getBlBulkBlResults<BulkBlItem>(dedupeId);
      if (cached) {
        const cachedEntry = getBlBulkBlHistory().find((e) => e.id === dedupeId);
        return toolResult({ items: cached, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_bulk_backlinks', { targetCount: targetList.length, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: BulkBlItem[] }>(
        'backlinks/bulk_backlinks/live', { targets: targetList }, { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: BlBulkBlEntry = { id: dedupeId, ts: Date.now(), targets: targetList.join(', '), count: items.length, cost };
        saveBlBulkBl(entry, items);
      }
      return toolResult({ items, cost });
    },
  );

  // ---- 4. Bulk referring domains ----
  server.registerTool(
    'get_bulk_referring_domains',
    {
      title: 'Get bulk referring domain counts',
      description:
        `Referring domain / IP / broken-link counts for up to ${BULK_TARGET_CAP} domains in a single request. ` +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/bulk_referring_domains/live), regardless of target count. ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        targets: z.array(z.string()).max(BULK_TARGET_CAP).describe('Domains to check'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ targets, confirm }) => {
      const targetList = normalizeBulkTargets(targets);
      if (targetList.length === 0) return toolError('No non-empty targets provided.');

      const dedupeId = stableSearchId(['bulk-referring-domains', targetList.join(',')]);
      const cached = getBlBulkRdResults<BulkRdItem>(dedupeId);
      if (cached) {
        const cachedEntry = getBlBulkRdHistory().find((e) => e.id === dedupeId);
        return toolResult({ items: cached, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_bulk_referring_domains', { targetCount: targetList.length, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: BulkRdItem[] }>(
        'backlinks/bulk_referring_domains/live', { targets: targetList }, { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: BlBulkRdEntry = { id: dedupeId, ts: Date.now(), targets: targetList.join(', '), count: items.length, cost };
        saveBlBulkRd(entry, items);
      }
      return toolResult({ items, cost });
    },
  );

  // ---- 5. Domain intersection ----
  server.registerTool(
    'get_backlinks_domain_intersection',
    {
      title: 'Get backlinks domain intersection',
      description:
        'Domains that link to both of two targets simultaneously. ' +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/domain_intersection/live). ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        target1: z.string().describe('Your domain'),
        target2: z.string().describe('Competitor domain'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target1, target2, confirm }) => {
      const t1 = cleanHost(target1);
      const t2 = cleanHost(target2);
      if (!t1 || !t2) return toolError('Both target1 and target2 are required.');

      const dedupeId = stableSearchId(['bl-domain-intersection', t1, t2]);
      const cached = getBlDomIntResults<DomIntItem>(dedupeId);
      if (cached) {
        const cachedEntry = getBlDomIntHistory().find((e) => e.id === dedupeId);
        return toolResult({ target1: t1, target2: t2, items: cached, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_backlinks_domain_intersection', { target1: t1, target2: t2, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: DomIntItem[] }>(
        'backlinks/domain_intersection/live',
        { target1: t1, target2: t2, limit: 500, order_by: ['domain_from_rank,desc'] },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: BlDomIntEntry = { id: dedupeId, ts: Date.now(), target1: t1, target2: t2, count: items.length, cost };
        saveBlDomInt(entry, items);
      }
      return toolResult({ target1: t1, target2: t2, items, cost });
    },
  );

  // ---- 6. Backlinks history ----
  server.registerTool(
    'get_backlinks_history',
    {
      title: 'Get backlink history over time',
      description:
        'Monthly evolution of backlinks and referring domains for a domain. ' +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/history/live). ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        target: z.string().describe('Domain to analyze'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, confirm }) => {
      const t = cleanHost(target);
      if (!t) return toolError('No target provided.');

      const dedupeId = stableSearchId(['backlinks-history', t]);
      const cached = getBlHistResults<HistoryPoint>(dedupeId);
      if (cached) {
        const cachedEntry = getBlHistHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: t, items: cached, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_backlinks_history', { target: t, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: HistoryPoint[] }>(
        'backlinks/history/live', { target: t }, { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: BlHistEntry = { id: dedupeId, ts: Date.now(), target: t, count: items.length, cost };
        saveBlHist(entry, items);
      }
      return toolResult({ target: t, items, cost });
    },
  );

  // ---- 7. Page intersection ----
  server.registerTool(
    'get_backlinks_page_intersection',
    {
      title: 'Get backlinks page intersection',
      description:
        `External pages that link to multiple (2-${BACKLINKS_PAGE_INTERSECTION_CAP}) targets simultaneously. ` +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/page_intersection/live). ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        targets: z.array(z.string()).max(BACKLINKS_PAGE_INTERSECTION_CAP).describe('Target URLs or domains (2 or more)'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ targets, confirm }) => {
      const targetList = normalizePageIntTargets(targets);
      if (targetList.length < 2) return toolError('Enter at least 2 targets.');

      const dedupeId = stableSearchId(['bl-page-intersection', targetList.join(',')]);
      const cached = getBlPageIntResults<PageIntItem>(dedupeId);
      if (cached) {
        const cachedEntry = getBlPageIntHistory().find((e) => e.id === dedupeId);
        return toolResult({ targets: targetList, items: cached, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_backlinks_page_intersection', { targets: targetList, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: PageIntItem[] }>(
        'backlinks/page_intersection/live',
        { targets: targetList.map((t) => ({ url: t, type: 'url' })), limit: 500, order_by: ['page_from_rank,desc'] },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: BlPageIntEntry = { id: dedupeId, ts: Date.now(), targets: targetList.join(', '), count: items.length, cost };
        saveBlPageInt(entry, items);
      }
      return toolResult({ targets: targetList, items, cost });
    },
  );

  // ---- 8. Referring domains ----
  server.registerTool(
    'get_referring_domains',
    {
      title: 'Get referring domains',
      description:
        'Dofollow domains linking to a target, with DR, backlink count, and broken-link status. ' +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/referring_domains/live). ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        target: z.string().describe('Domain to analyze'),
        limit: z.number().optional().describe('Max domains to return (default 100, capped at 1000)'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, limit, confirm }) => {
      const t = target.trim();
      if (!t) return toolError('No target provided.');
      const lim = Math.min(limit ?? 100, 1000);

      const dedupeId = stableSearchId(['ref-domains', t, lim]);
      const cached = getRefDomainsResults<RefDomain>(dedupeId);
      if (cached) {
        const cachedEntry = getRefDomainsHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: t, items: cached, total: cachedEntry?.total ?? cached.length, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_referring_domains', { target: t, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ total_count?: number; items?: RefDomain[] }>(
        'backlinks/referring_domains/live',
        { target: t, limit: lim, order_by: ['domain_from_rank,desc'], filters: ['dofollow', '=', true], include_subdomains: true },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      const total = result?.total_count ?? 0;
      if (items.length > 0) {
        const entry: RefDomainsSearchEntry = { id: dedupeId, ts: Date.now(), target: t, cost, total };
        saveRefDomainsSearch(entry, items);
      }
      return toolResult({ target: t, items, total, cost });
    },
  );

  // ---- 9. Referring networks ----
  server.registerTool(
    'get_referring_networks',
    {
      title: 'Get referring networks',
      description:
        'IP subnets/networks sending backlinks to a domain. ' +
        'PAID — on a cache miss, bills DataForSEO once (backlinks/referring_networks/live). ' +
        'Call without confirm first to preview, then again with confirm: true to execute.',
      inputSchema: {
        target: z.string().describe('Domain to analyze'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, confirm }) => {
      const t = cleanHost(target);
      if (!t) return toolError('No target provided.');

      const dedupeId = stableSearchId(['bl-ref-networks', t]);
      const cached = getBlRefNetResults<NetworkItem>(dedupeId);
      if (cached) {
        const cachedEntry = getBlRefNetHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: t, items: cached, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) return dryRun('get_referring_networks', { target: t, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: NetworkItem[] }>(
        'backlinks/referring_networks/live', { target: t, limit: 1000, order_by: ['referring_domains,desc'] },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: BlRefNetEntry = { id: dedupeId, ts: Date.now(), target: t, count: items.length, cost };
        saveBlRefNet(entry, items);
      }
      return toolResult({ target: t, items, cost });
    },
  );
}
