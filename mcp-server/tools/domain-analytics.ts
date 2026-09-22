import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCredentials, getSetting,
  getCompetitorsHistory, saveCompetitorsSearch, getCompetitorsResults, type CompetitorsSearchEntry,
  getRankedKwHistory, saveRankedKwSearch, getRankedKwResults, type RankedKwSearchEntry,
  getDomainIntersectionHistory, saveDomainIntersectionSearch, getDomainIntersectionResults, type DomainIntersectionSearchEntry,
  getHistRankHistory, saveHistRankSearch, getHistRankResults, type HistRankSearchEntry,
  getSubdomainsHistory, saveSubdomainsSearch, getSubdomainsResults, type SubdomainsEntry,
  getTrafficEstimationHistory, saveTrafficEstimationSearch, getTrafficEstimationResults, type TrafficEstimationEntry,
  getPageIntersectionHistory, savePageIntersectionSearch, getPageIntersectionResults, type PageIntersectionEntry,
  getDomainCategoriesHistory, saveDomainCategoriesSearch, getDomainCategoriesResults, getCategoryPath, type DomainCategoriesEntry,
  getDomainTechHistory, saveDomainTechSearch, getDomainTechResult, type DomainTechEntry,
  getDomainFindHistory, saveDomainFindSearch, getDomainFindResults, type DomainFindEntry,
  getDomainWhoisHistory, saveDomainWhoisSearch, getDomainWhoisResult, type DomainWhoisEntry,
} from '../../src/lib/db';
import { dryRun, toolResult, toolError, missingCredentialsError } from '../guardrails';
import { callDataForSeoFirst } from '../../src/lib/dataforseo';
import { stableSearchId } from '../../src/lib/dedupe';
import { BULK_TARGET_CAP, LABS_PAGE_INTERSECTION_CAP } from '../limits';

function cleanDomain(d: string) {
  return d.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

function defaultLocation(location?: string) {
  return location?.trim() || getSetting('default_location') || 'France';
}

function defaultLanguage(language?: string) {
  return language?.trim() || getSetting('default_language') || 'French';
}

// ---- Shared item shapes (pass-through — mirrored from each page.tsx's own local types) ----

interface CompetitorItem {
  domain?: string;
  avg_position?: number;
  sum_position?: number;
  intersections?: number;
  full_domain_metrics?: { organic?: { count?: number; estimated_traffic?: number; is_new?: number; is_up?: number; is_down?: number; is_lost?: number } };
  metrics?: { organic?: { count?: number; estimated_traffic?: number } };
}

interface RankedKwItem {
  keyword_data?: {
    keyword?: string;
    keyword_info?: { search_volume?: number; cpc?: number; competition?: number; competition_level?: string };
    keyword_properties?: { keyword_difficulty?: number };
    search_intent_info?: { main_intent?: string };
  };
  ranked_serp_element?: {
    serp_item?: { type?: string; rank_group?: number; rank_absolute?: number; url?: string; title?: string; domain?: string; is_featured_snippet?: boolean };
  };
}

interface DomainIntersectionItem {
  keyword_data: {
    keyword: string;
    location_code: number;
    language_code: string;
    keyword_info?: { search_volume?: number; competition?: number; cpc?: number };
    keyword_properties?: { keyword_difficulty?: number };
  };
  first_domain_serp_element?: { rank_group?: number; rank_absolute?: number; url?: string };
  second_domain_serp_element?: { rank_group?: number; rank_absolute?: number; url?: string };
}

interface HistRankItem {
  se_type?: string;
  year: number;
  month: number;
  metrics: {
    organic?: {
      count?: number; pos_1?: number; pos_2_3?: number; pos_4_10?: number; pos_11_20?: number;
      pos_21_30?: number; pos_31_40?: number; pos_41_50?: number; pos_51_60?: number; pos_61_70?: number;
      pos_71_80?: number; pos_81_90?: number; pos_91_100?: number; etv?: number;
    };
  };
}

interface SubdomainItem {
  subdomain?: string;
  metrics?: { organic?: { count?: number; etv?: number; estimated_paid_traffic_cost?: number } };
}

interface TrafficMetrics { count?: number; etv?: number; impressions_etv?: number; }
interface TrafficItem { target?: string; metrics?: { organic?: TrafficMetrics; paid?: TrafficMetrics } }

interface LabsIntersectionRankedItem { url?: string; rank_absolute?: number; }
interface LabsIntersectionItem {
  keyword_data?: { keyword?: string; keyword_info?: { search_volume?: number; cpc?: number } };
  ranked_serp_element?: { items?: LabsIntersectionRankedItem[] };
  keyword_difficulty?: number;
}

interface CategoryItem {
  categories?: number[];
  metrics?: { organic?: { etv?: number; count?: number } };
}

type TechCategories = Record<string, Record<string, string[]>>;

interface DomainTechResult {
  domain?: string;
  title?: string;
  description?: string;
  domain_rank?: number;
  last_visited?: string;
  country_iso_code?: string;
  phone_numbers?: string[];
  emails?: string[];
  social_graph_urls?: string[];
  technologies?: TechCategories;
}

interface FindDomainItem {
  domain?: string;
  title?: string;
  description?: string;
  domain_rank?: number;
  country_iso_code?: string;
  last_visited?: string;
  technologies?: TechCategories;
}

interface WhoisResult {
  domain?: string;
  registered?: boolean;
  created_datetime?: string;
  expiration_datetime?: string;
  updated_datetime?: string;
  registrar?: string;
  epp_status_codes?: string[];
  nameservers?: string[];
  metrics?: {
    organic?: Record<string, number | undefined>;
    paid?: Record<string, number | undefined>;
  };
  backlinks_info?: {
    referring_domains?: number;
    referring_main_domains?: number;
    referring_pages?: number;
    backlinks?: number;
    rank?: number;
    main_domain_rank?: number;
  };
}

export function registerDomainAnalyticsTools(server: McpServer) {
  // ---- 1. Competitors ----
  server.registerTool(
    'get_competitors',
    {
      title: 'Get domain competitors',
      description:
        'PAID on cache miss — one DataForSEO call to dataforseo_labs/google/competitors_domain/live. ' +
        'Domains that rank for the same keywords as a target, ranked by keyword overlap. ' +
        'A repeat call with the same target/location/language/limit hits the local cache and is free — no confirm needed then.',
      inputSchema: {
        target: z.string().describe('Target domain'),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        limit: z.number().optional().default(20).describe('Number of competitors, max 100'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, location, language, limit, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const lim = Math.min(limit ?? 20, 100);
      const clean = cleanDomain(target);

      const dedupeId = stableSearchId(['competitors', clean, loc, lang, lim]);
      const cached = getCompetitorsResults<CompetitorItem>(dedupeId);
      if (cached) {
        const cachedEntry = getCompetitorsHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: clean, location: loc, language: lang, cached: true, cost: cachedEntry?.cost, items: cached });
      }

      if (!confirm) return dryRun('get_competitors', { target: clean, location: loc, language: lang, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: CompetitorItem[] }>(
        'dataforseo_labs/google/competitors_domain/live',
        { target: clean, location_name: loc, language_name: lang, limit: lim },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: CompetitorsSearchEntry = { id: dedupeId, ts: Date.now(), target: clean, location: loc, language: lang, count: items.length, cost };
        saveCompetitorsSearch(entry, items);
      }
      return toolResult({ target: clean, location: loc, language: lang, cost, items });
    },
  );

  // ---- 2. Ranked Keywords ----
  server.registerTool(
    'get_ranked_keywords',
    {
      title: 'Get ranked keywords for a domain',
      description:
        'PAID on cache miss — one DataForSEO call to dataforseo_labs/google/ranked_keywords/live. ' +
        'Every keyword a domain ranks for in Google, with volume/difficulty/position. ' +
        'A repeat call with identical params hits the local cache and is free.',
      inputSchema: {
        target: z.string().describe('Target domain'),
        location: z.string().optional(),
        language: z.string().optional(),
        limit: z.number().optional().default(100).describe('Max results, up to 1000'),
        orderBy: z.string().optional().default('ranked_serp_element.serp_item.rank_group,asc'),
        maxPosition: z.number().optional().describe('Filter to rank_group <= this value'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, location, language, limit, orderBy, maxPosition, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const lim = Math.min(limit ?? 100, 1000);
      const order = orderBy ?? 'ranked_serp_element.serp_item.rank_group,asc';
      const trimmedTarget = target.trim();
      const clean = cleanDomain(target);

      const dedupeId = stableSearchId(['ranked-keywords', trimmedTarget, loc, lang, lim, order, maxPosition ?? null]);
      const cached = getRankedKwResults<RankedKwItem>(dedupeId);
      if (cached) {
        const cachedEntry = getRankedKwHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: clean, location: loc, language: lang, cached: true, totalCount: cachedEntry?.totalCount ?? cached.length, items: cached });
      }

      if (!confirm) return dryRun('get_ranked_keywords', { target: clean, location: loc, language: lang, limit: lim, orderBy: order, maxPosition, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const body: Record<string, unknown> = { target: clean, location_name: loc, language_name: lang, limit: lim, order_by: [order] };
      if (maxPosition) body.filters = ['ranked_serp_element.serp_item.rank_group', '<=', maxPosition];

      const { result, cost, error } = await callDataForSeoFirst<{ total_count?: number; items?: RankedKwItem[] }>(
        'dataforseo_labs/google/ranked_keywords/live', body, { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      const totalCount = result?.total_count ?? 0;
      if (items.length > 0) {
        const entry: RankedKwSearchEntry = { id: dedupeId, ts: Date.now(), target: clean, location: loc, language: lang, count: items.length, totalCount, cost };
        saveRankedKwSearch(entry, items);
      }
      return toolResult({ target: clean, location: loc, language: lang, cost, totalCount, items });
    },
  );

  // ---- 3. Domain Intersection ----
  server.registerTool(
    'get_domain_intersection',
    {
      title: 'Get keywords two domains both rank for',
      description:
        'PAID on cache miss — one DataForSEO call to dataforseo_labs/google/domain_intersection/live. ' +
        'Keywords two domains rank for simultaneously, side by side by position. ' +
        'A repeat call with identical params hits the local cache and is free.',
      inputSchema: {
        target1: z.string().describe('First domain'),
        target2: z.string().describe('Second domain'),
        location: z.string().optional(),
        language: z.string().optional(),
        limit: z.number().optional().default(100).describe('Max results, up to 1000'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target1, target2, location, language, limit, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const lim = Math.min(limit ?? 100, 1000);
      const t1 = target1.trim();
      const t2 = target2.trim();

      const dedupeId = stableSearchId(['domain-intersection', t1, t2, loc, lang, lim]);
      const cached = getDomainIntersectionResults<DomainIntersectionItem>(dedupeId);
      if (cached) {
        const cachedEntry = getDomainIntersectionHistory().find((e) => e.id === dedupeId);
        return toolResult({ target1: t1, target2: t2, location: loc, language: lang, cached: true, totalCount: cachedEntry?.totalCount ?? cached.length, items: cached });
      }

      if (!confirm) return dryRun('get_domain_intersection', { target1: t1, target2: t2, location: loc, language: lang, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ total_count?: number; items?: DomainIntersectionItem[] }>(
        'dataforseo_labs/google/domain_intersection/live',
        { target1: t1, target2: t2, location_name: loc, language_name: lang, limit: lim, order_by: ['keyword_data.keyword_info.search_volume,desc'] },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      const totalCount = result?.total_count ?? 0;
      if (items.length > 0) {
        const entry: DomainIntersectionSearchEntry = { id: dedupeId, ts: Date.now(), target1: t1, target2: t2, location: loc, language: lang, count: items.length, totalCount, cost };
        saveDomainIntersectionSearch(entry, items);
      }
      return toolResult({ target1: t1, target2: t2, location: loc, language: lang, cost, totalCount, items });
    },
  );

  // ---- 4. Historical Rank Overview ----
  server.registerTool(
    'get_historical_rank',
    {
      title: 'Get historical rank overview for a domain',
      description:
        'PAID on cache miss — one DataForSEO call to dataforseo_labs/google/historical_rank_overview/live. ' +
        'Monthly organic keyword-count and position-distribution history for a domain. ' +
        'A repeat call with identical params hits the local cache and is free.',
      inputSchema: {
        target: z.string().describe('Target domain'),
        location: z.string().optional(),
        language: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, location, language, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const t = target.trim();

      const dedupeId = stableSearchId(['historical-rank', t, loc, lang]);
      const cached = getHistRankResults<HistRankItem>(dedupeId);
      if (cached) {
        const cachedEntry = getHistRankHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: t, location: loc, language: lang, cached: true, cost: cachedEntry?.cost, items: cached });
      }

      if (!confirm) return dryRun('get_historical_rank', { target: t, location: loc, language: lang, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: HistRankItem[] }>(
        'dataforseo_labs/google/historical_rank_overview/live',
        { target: t, location_name: loc, language_name: lang },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: HistRankSearchEntry = { id: dedupeId, ts: Date.now(), target: t, location: loc, language: lang, cost };
        saveHistRankSearch(entry, items);
      }
      return toolResult({ target: t, location: loc, language: lang, cost, items });
    },
  );

  // ---- 5. Subdomains ----
  server.registerTool(
    'get_subdomains',
    {
      title: 'Get top subdomains for a root domain',
      description:
        'PAID on cache miss — one DataForSEO call to dataforseo_labs/google/subdomains/live. ' +
        'Top subdomains of a root domain ranked by organic traffic. ' +
        'A repeat call with identical params hits the local cache and is free.',
      inputSchema: {
        target: z.string().describe('Root domain'),
        location: z.string().optional(),
        language: z.string().optional(),
        limit: z.number().optional().default(100).describe('Max results, up to 1000'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, location, language, limit, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const lim = Math.min(limit ?? 100, 1000);
      const clean = cleanDomain(target);

      const dedupeId = stableSearchId(['subdomains', clean, loc, lang, lim]);
      const cached = getSubdomainsResults<SubdomainItem>(dedupeId);
      if (cached) {
        const cachedEntry = getSubdomainsHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: clean, location: loc, language: lang, cached: true, cost: cachedEntry?.cost, items: cached });
      }

      if (!confirm) return dryRun('get_subdomains', { target: clean, location: loc, language: lang, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: SubdomainItem[] }>(
        'dataforseo_labs/google/subdomains/live',
        { target: clean, location_name: loc, language_name: lang, limit: lim },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: SubdomainsEntry = { id: dedupeId, ts: Date.now(), target: clean, location: loc, language: lang, count: items.length, cost };
        saveSubdomainsSearch(entry, items);
      }
      return toolResult({ target: clean, location: loc, language: lang, cost, items });
    },
  );

  // ---- 6. Bulk Traffic Estimation ----
  server.registerTool(
    'get_traffic_estimation',
    {
      title: 'Bulk organic traffic estimation',
      description:
        `PAID on cache miss — one DataForSEO call to dataforseo_labs/google/bulk_traffic_estimation/live. ` +
        `Estimated organic (and paid) traffic for a list of domains in one request, capped at ${BULK_TARGET_CAP} targets. ` +
        'A repeat call with an identical target list/location/language hits the local cache and is free.',
      inputSchema: {
        targets: z.array(z.string()).max(BULK_TARGET_CAP).describe('List of domains'),
        location: z.string().optional(),
        language: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ targets, location, language, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const targetList = [...new Set(targets.map((t) => cleanDomain(t)).filter(Boolean))].slice(0, BULK_TARGET_CAP);
      if (targetList.length === 0) return toolError('No non-empty targets provided.');

      const dedupeId = stableSearchId(['traffic-estimation', loc, lang, ...targetList]);
      const cached = getTrafficEstimationResults<TrafficItem>(dedupeId);
      if (cached) {
        const cachedEntry = getTrafficEstimationHistory().find((e) => e.id === dedupeId);
        return toolResult({ location: loc, language: lang, cached: true, cost: cachedEntry?.cost, items: cached });
      }

      if (!confirm) return dryRun('get_traffic_estimation', { targetCount: targetList.length, location: loc, language: lang, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: TrafficItem[] }>(
        'dataforseo_labs/google/bulk_traffic_estimation/live',
        { targets: targetList, location_name: loc, language_name: lang },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: TrafficEstimationEntry = { id: dedupeId, ts: Date.now(), targets: targetList.join(', '), location: loc, language: lang, count: items.length, cost };
        saveTrafficEstimationSearch(entry, items);
      }
      return toolResult({ location: loc, language: lang, cost, items });
    },
  );

  // ---- 7. Labs Page Intersection ----
  server.registerTool(
    'get_labs_page_intersection',
    {
      title: 'Get keywords multiple pages both rank for (Labs)',
      description:
        `PAID on cache miss — one DataForSEO call to dataforseo_labs/google/page_intersection/live. ` +
        `Keywords that ${LABS_PAGE_INTERSECTION_CAP} or fewer specific URLs (min 2) rank for simultaneously. ` +
        'This is the DataForSEO Labs page-intersection, distinct from the Backlinks page-intersection tool. ' +
        'A repeat call with an identical page list/location/language/limit hits the local cache and is free.',
      inputSchema: {
        pages: z.array(z.string()).min(2).max(LABS_PAGE_INTERSECTION_CAP).describe(`2–${LABS_PAGE_INTERSECTION_CAP} page URLs`),
        location: z.string().optional(),
        language: z.string().optional(),
        limit: z.number().optional().default(100).describe('Max results, up to 1000'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ pages, location, language, limit, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const lim = Math.min(limit ?? 100, 1000);
      const pageList = [...new Set(pages.map((p) => p.trim()).filter(Boolean))].slice(0, LABS_PAGE_INTERSECTION_CAP);
      if (pageList.length < 2) return toolError('Provide at least 2 page URLs.');

      const dedupeId = stableSearchId(['page-intersection', ...pageList, loc, lang, lim]);
      const cached = getPageIntersectionResults<LabsIntersectionItem>(dedupeId);
      if (cached) {
        const cachedEntry = getPageIntersectionHistory().find((e) => e.id === dedupeId);
        return toolResult({ pages: pageList, location: loc, language: lang, cached: true, cost: cachedEntry?.cost, items: cached });
      }

      if (!confirm) return dryRun('get_labs_page_intersection', { pages: pageList, location: loc, language: lang, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsIntersectionItem[] }>(
        'dataforseo_labs/google/page_intersection/live',
        { pages: pageList.map((url) => ({ url, type: 'url' })), location_name: loc, language_name: lang, limit: lim, intersections: true },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: PageIntersectionEntry = { id: dedupeId, ts: Date.now(), pages: JSON.stringify(pageList), location: loc, language: lang, count: items.length, cost };
        savePageIntersectionSearch(entry, items);
      }
      return toolResult({ pages: pageList, location: loc, language: lang, cost, items });
    },
  );

  // ---- 8. Domain Categories ----
  server.registerTool(
    'get_domain_categories',
    {
      title: "Get a domain's thematic categories",
      description:
        'PAID on cache miss — one DataForSEO call to dataforseo_labs/google/categories_for_domain/live. ' +
        "Thematic categories that best describe a domain's organic content, with keyword count and ETV per category. " +
        'A repeat call with identical params hits the local cache and is free.',
      inputSchema: {
        target: z.string().describe('Target domain'),
        location: z.string().optional(),
        language: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, location, language, confirm }) => {
      const loc = defaultLocation(location);
      const lang = defaultLanguage(language);
      const clean = cleanDomain(target);

      const dedupeId = stableSearchId(['domain-categories', clean, loc, lang]);
      const cached = getDomainCategoriesResults<CategoryItem>(dedupeId);
      if (cached) {
        const cachedEntry = getDomainCategoriesHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: clean, location: loc, language: lang, cached: true, cost: cachedEntry?.cost, items: resolveCategories(cached) });
      }

      if (!confirm) return dryRun('get_domain_categories', { target: clean, location: loc, language: lang, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: CategoryItem[] }>(
        'dataforseo_labs/google/categories_for_domain/live',
        { target: clean, location_name: loc, language_name: lang },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: DomainCategoriesEntry = { id: dedupeId, ts: Date.now(), target: clean, location: loc, language: lang, count: items.length, cost };
        saveDomainCategoriesSearch(entry, items);
      }
      return toolResult({ target: clean, location: loc, language: lang, cost, items: resolveCategories(items) });
    },
  );

  // ---- 9. Domain Technologies ----
  server.registerTool(
    'get_domain_technologies',
    {
      title: "Get a domain's detected tech stack",
      description:
        'PAID on cache miss (~$0.001) — one DataForSEO call to domain_analytics/technologies/domain_technologies/live. ' +
        'Detected CMS/analytics/marketing/hosting technologies for one domain, plus contact info found on it. ' +
        'A repeat call with the same target hits the local cache and is free.',
      inputSchema: {
        target: z.string().describe('Target domain'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, confirm }) => {
      const clean = cleanDomain(target);

      const dedupeId = stableSearchId(['domain-tech', clean]);
      const cached = getDomainTechResult<DomainTechResult>(dedupeId);
      if (cached) {
        const cachedEntry = getDomainTechHistory().find((e) => e.id === dedupeId);
        return toolResult({ target: clean, cached: true, cost: cachedEntry?.cost, result: cached });
      }

      if (!confirm) return dryRun('get_domain_technologies', { target: clean, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<DomainTechResult>(
        'domain_analytics/technologies/domain_technologies/live',
        { target: clean },
        { login: creds.login, pass: creds.pass },
        20_000,
      );
      if (error) return toolError(error);
      if (!result) return toolError('No data found for this domain.');

      const entry: DomainTechEntry = { id: dedupeId, ts: Date.now(), target: clean, cost };
      saveDomainTechSearch(entry, result);
      return toolResult({ target: clean, cost, result });
    },
  );

  // ---- 10. Find Domains by Technology ----
  server.registerTool(
    'find_domains_by_technology',
    {
      title: 'Find domains using a technology and/or keyword',
      description:
        'PAID on cache miss (~$0.01) — one DataForSEO call to domain_analytics/technologies/domains_by_technology/live. ' +
        'Finds domains matching a technology name (e.g. "WordPress", "Shopify") and/or a topical keyword — fill one or both. ' +
        'A repeat call with identical params hits the local cache and is free.',
      inputSchema: {
        technology: z.string().optional().describe('Technology name, e.g. WordPress, Shopify, React'),
        keyword: z.string().optional().describe('Topical keyword, e.g. plumbing, dentist'),
        limit: z.number().optional().default(20).describe('Max results, up to 100'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ technology, keyword, limit, confirm }) => {
      const tech = technology?.trim() ?? '';
      const kw = keyword?.trim() ?? '';
      if (!tech && !kw) return toolError('Provide at least one of technology or keyword.');
      const lim = Math.min(limit ?? 20, 100);

      const dedupeId = stableSearchId(['domain-find', kw, tech, lim]);
      const cached = getDomainFindResults<FindDomainItem>(dedupeId);
      if (cached) {
        const cachedEntry = getDomainFindHistory().find((e) => e.id === dedupeId);
        return toolResult({ technology: tech || undefined, keyword: kw || undefined, cached: true, totalCount: cachedEntry?.totalCount, items: cached });
      }

      if (!confirm) return dryRun('find_domains_by_technology', { technology: tech || undefined, keyword: kw || undefined, limit: lim, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const body: Record<string, unknown> = { limit: lim, order_by: ['domain_rank,desc'] };
      if (tech) body.technologies = [tech];
      if (kw) body.keywords = [kw];

      const { result, cost, error } = await callDataForSeoFirst<{ total_count?: number; items?: FindDomainItem[] }>(
        'domain_analytics/technologies/domains_by_technology/live', body, { login: creds.login, pass: creds.pass }, 20_000,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      const totalCount = result?.total_count;
      if (items.length > 0) {
        const entry: DomainFindEntry = { id: dedupeId, ts: Date.now(), keyword: kw || undefined, technology: tech || undefined, count: items.length, totalCount, cost };
        saveDomainFindSearch(entry, items);
      }
      return toolResult({ technology: tech || undefined, keyword: kw || undefined, cost, totalCount, items });
    },
  );

  // ---- 11. Domain Whois ----
  server.registerTool(
    'get_domain_whois',
    {
      title: 'Get Whois overview for a domain',
      description:
        'PAID on cache miss (~$0.001) — one DataForSEO call to domain_analytics/whois/overview/live. ' +
        'Domain registration data (registrar, dates, nameservers) plus organic/paid traffic and backlink metrics. ' +
        'A repeat call with the same domain hits the local cache and is free.',
      inputSchema: {
        domain: z.string().describe('Target domain'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ domain, confirm }) => {
      const clean = cleanDomain(domain);

      const dedupeId = stableSearchId(['domain-whois', clean]);
      const cached = getDomainWhoisResult<WhoisResult>(dedupeId);
      if (cached) {
        const cachedEntry = getDomainWhoisHistory().find((e) => e.id === dedupeId);
        return toolResult({ domain: clean, cached: true, cost: cachedEntry?.cost, result: cached });
      }

      if (!confirm) return dryRun('get_domain_whois', { domain: clean, billedCalls: 1 });

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: WhoisResult[] }>(
        'domain_analytics/whois/overview/live',
        { filters: ['domain', '=', clean], limit: 1 },
        { login: creds.login, pass: creds.pass },
        20_000,
      );
      if (error) return toolError(error);

      const whois = result?.items?.[0] ?? null;
      if (!whois) return toolError('No Whois data found for this domain.');

      const entry: DomainWhoisEntry = { id: dedupeId, ts: Date.now(), domain: clean, cost };
      saveDomainWhoisSearch(entry, whois);
      return toolResult({ domain: clean, cost, result: whois });
    },
  );
}

function resolveCategories(items: CategoryItem[]) {
  return items.map((item) => ({
    categoryPaths: (item.categories ?? []).map((c) => getCategoryPath(c)),
    count: item.metrics?.organic?.count ?? 0,
    etv: item.metrics?.organic?.etv ?? 0,
  }));
}
