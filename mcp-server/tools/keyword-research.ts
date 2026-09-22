import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCredentials, getSetting,
  getKwOverviewHistory, saveKwOverviewSearch, getKwOverviewResults, type KwOverviewSearchEntry,
  getKeywordIdeasHistory, saveKeywordIdeasSearch, getKeywordIdeasResults, type KeywordIdeasEntry,
  getRelatedKwHistory, saveRelatedKwSearch, getRelatedKwResults, type RelatedKwSearchEntry,
  getKwDifficultyHistory, saveKwDifficultySearch, getKwDifficultyResults, type KwDifficultySearchEntry,
  getSearchIntentHistory, saveSearchIntentSearch, getSearchIntentResults, type SearchIntentEntry,
  getKdHistory, saveKdSearch, getKdResults, type KdHistoryEntry,
  getTopSearchesHistory, saveTopSearches, getTopSearchesResults, type TopSearchesEntry,
} from '../../src/lib/db';
import { toLabsCountry } from '../../src/lib/geo-options';
import { stableSearchId } from '../../src/lib/dedupe';
import { callDataForSeo, callDataForSeoFirst } from '../../src/lib/dataforseo';
import { dryRun, toolResult, toolError, missingCredentialsError } from '../guardrails';
import { KEYWORD_LIST_CAP } from '../limits';

type LabsItem = Record<string, unknown>;

/**
 * Default location for `dataforseo_labs/*` tools mirrors every Labs page.tsx: the saved setting is
 * pushed through `toLabsCountry` because Labs only accepts its own restricted country-name list
 * (see `LABS_LOCATIONS` in geo-options.ts). Only applied when the caller didn't pass a location
 * explicitly — an explicit value is trusted as-is, exactly like the page.tsx forms do.
 */
function defaultLabsLocation(): string {
  return toLabsCountry(getSetting('default_location') ?? 'France');
}

function defaultLanguage(): string {
  return getSetting('default_language') ?? 'French';
}

function cleanKeywordList(keywords: string[]): string[] {
  return [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, KEYWORD_LIST_CAP);
}

export function registerKeywordResearchTools(server: McpServer) {
  // ---- 1. get_keyword_overview ----
  server.registerTool(
    'get_keyword_overview',
    {
      title: 'Get keyword overview',
      description:
        'PAID — one DataForSEO Labs call (keyword_overview), cached after the first run for the same keyword set/location/language. ' +
        `Detailed per-keyword metrics (volume, CPC, difficulty, intent) for up to ${KEYWORD_LIST_CAP} keywords at once.`,
      inputSchema: {
        keywords: z.array(z.string()).max(KEYWORD_LIST_CAP).describe('Keywords to look up'),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keywords, location, language, confirm }) => {
      const kwList = cleanKeywordList(keywords);
      if (kwList.length === 0) return toolError('No non-empty keywords provided.');

      const loc = location?.trim() || defaultLabsLocation();
      const lang = language?.trim() || defaultLanguage();

      const dedupeId = stableSearchId(['keyword-overview', kwList.join(','), loc, lang]);
      const cached = getKwOverviewResults<LabsItem>(dedupeId);
      if (cached) {
        const cost = getKwOverviewHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, count: cached.length, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_keyword_overview', { keywordCount: kwList.length, location: loc, language: lang, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsItem[] }>(
        'dataforseo_labs/google/keyword_overview/live',
        { keywords: kwList, location_name: loc, language_name: lang },
        creds,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const label = kwList.slice(0, 3).join(', ');
        const entry: KwOverviewSearchEntry = {
          id: dedupeId, ts: Date.now(),
          keywords: label.length > 80 ? label.slice(0, 77) + '…' : label,
          location: loc, language: lang, count: items.length, cost,
        };
        saveKwOverviewSearch(entry, items);
      }
      return toolResult({ items, count: items.length, cost, cached: false });
    },
  );

  // ---- 2. get_keyword_ideas ----
  server.registerTool(
    'get_keyword_ideas',
    {
      title: 'Get keyword ideas',
      description:
        'PAID — one DataForSEO Labs call (keyword_ideas), cached after the first run for the same seed keyword/location/language/limit. ' +
        'Discovers keyword ideas from a single seed keyword.',
      inputSchema: {
        keyword: z.string().describe('Seed keyword'),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        limit: z.number().optional().describe('Max results, 1-1000, default 100'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keyword, location, language, limit, confirm }) => {
      const kw = keyword.trim();
      if (!kw) return toolError('No seed keyword provided.');

      const loc = location?.trim() || defaultLabsLocation();
      const lang = language?.trim() || defaultLanguage();
      const lim = Math.min(Math.max(limit ?? 100, 1), 1000);

      const dedupeId = stableSearchId(['keyword-ideas', kw, loc, lang, lim]);
      const cached = getKeywordIdeasResults<LabsItem>(dedupeId);
      if (cached) {
        const cost = getKeywordIdeasHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, count: cached.length, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_keyword_ideas', { keyword: kw, location: loc, language: lang, limit: lim, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsItem[] }>(
        'dataforseo_labs/google/keyword_ideas/live',
        { keywords: [kw], location_name: loc, language_name: lang, limit: lim, include_serp_info: false, include_clickstream_data: false },
        creds,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: KeywordIdeasEntry = { id: dedupeId, ts: Date.now(), keyword: kw, location: loc, language: lang, count: items.length, cost };
        saveKeywordIdeasSearch(entry, items);
      }
      return toolResult({ items, count: items.length, cost, cached: false });
    },
  );

  // ---- 3. get_related_keywords ----
  server.registerTool(
    'get_related_keywords',
    {
      title: 'Get related keywords',
      description:
        'PAID — one DataForSEO Labs call (related_keywords), cached after the first run for the same keyword/location/language/depth/limit. ' +
        'Related keywords graph from a source keyword.',
      inputSchema: {
        keyword: z.string().describe('Source keyword'),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        depth: z.number().optional().describe('Search depth, 1-4, default 1'),
        limit: z.number().optional().describe('Max results, 1-1000, default 100'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keyword, location, language, depth, limit, confirm }) => {
      const kw = keyword.trim();
      if (!kw) return toolError('No source keyword provided.');

      const loc = location?.trim() || defaultLabsLocation();
      const lang = language?.trim() || defaultLanguage();
      const d = Math.min(Math.max(depth ?? 1, 1), 4);
      const lim = Math.min(Math.max(limit ?? 100, 1), 1000);

      const dedupeId = stableSearchId(['related-keywords', kw, loc, lang, d, lim]);
      const cached = getRelatedKwResults<LabsItem>(dedupeId);
      if (cached) {
        const cost = getRelatedKwHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, count: cached.length, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_related_keywords', { keyword: kw, location: loc, language: lang, depth: d, limit: lim, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsItem[] }>(
        'dataforseo_labs/google/related_keywords/live',
        { keyword: kw, location_name: loc, language_name: lang, depth: d, limit: lim, include_serp_info: true, include_clickstream_data: false },
        creds,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: RelatedKwSearchEntry = {
          id: dedupeId, ts: Date.now(), keyword: kw, location: loc, language: lang, depth: d, count: items.length, cost,
        };
        saveRelatedKwSearch(entry, items);
      }
      return toolResult({ items, count: items.length, cost, cached: false });
    },
  );

  // ---- 4. get_keyword_difficulty ----
  server.registerTool(
    'get_keyword_difficulty',
    {
      title: 'Get bulk keyword difficulty',
      description:
        'PAID — one DataForSEO Labs call (bulk_keyword_difficulty), cached after the first run for the same keyword set/location/language. ' +
        `Difficulty scores for up to ${KEYWORD_LIST_CAP} keywords at once.`,
      inputSchema: {
        keywords: z.array(z.string()).max(KEYWORD_LIST_CAP),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keywords, location, language, confirm }) => {
      const kwList = cleanKeywordList(keywords);
      if (kwList.length === 0) return toolError('No non-empty keywords provided.');

      const loc = location?.trim() || defaultLabsLocation();
      const lang = language?.trim() || defaultLanguage();

      const dedupeId = stableSearchId(['keyword-difficulty', kwList.join(','), loc, lang]);
      const cached = getKwDifficultyResults<LabsItem>(dedupeId);
      if (cached) {
        const cost = getKwDifficultyHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, count: cached.length, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_keyword_difficulty', { keywordCount: kwList.length, location: loc, language: lang, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsItem[] }>(
        'dataforseo_labs/google/bulk_keyword_difficulty/live',
        { keywords: kwList, location_name: loc, language_name: lang },
        creds,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const label = kwList.slice(0, 3).join(', ') + (kwList.length > 3 ? '…' : '');
        const entry: KwDifficultySearchEntry = { id: dedupeId, ts: Date.now(), keywords: label, location: loc, language: lang, count: items.length, cost };
        saveKwDifficultySearch(entry, items);
      }
      return toolResult({ items, count: items.length, cost, cached: false });
    },
  );

  // ---- 5. get_search_intent ----
  server.registerTool(
    'get_search_intent',
    {
      title: 'Classify keyword search intent',
      description:
        'PAID — one DataForSEO Labs call (search_intent), cached after the first run for the same keyword set/location/language. ' +
        `Classifies up to ${KEYWORD_LIST_CAP} keywords as informational, navigational, commercial or transactional.`,
      inputSchema: {
        keywords: z.array(z.string()).max(KEYWORD_LIST_CAP),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keywords, location, language, confirm }) => {
      const kwList = cleanKeywordList(keywords);
      if (kwList.length === 0) return toolError('No non-empty keywords provided.');

      const loc = location?.trim() || defaultLabsLocation();
      const lang = language?.trim() || defaultLanguage();

      const dedupeId = stableSearchId(['search-intent', kwList.join(','), loc, lang]);
      const cached = getSearchIntentResults<LabsItem>(dedupeId);
      if (cached) {
        const cost = getSearchIntentHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, count: cached.length, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_search_intent', { keywordCount: kwList.length, location: loc, language: lang, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsItem[] }>(
        'dataforseo_labs/google/search_intent/live',
        { keywords: kwList, location_name: loc, language_name: lang },
        creds,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      if (items.length > 0) {
        const entry: SearchIntentEntry = { id: dedupeId, ts: Date.now(), keywords: kwList.join(', '), location: loc, language: lang, count: items.length, cost };
        saveSearchIntentSearch(entry, items);
      }
      return toolResult({ items, count: items.length, cost, cached: false });
    },
  );

  // ---- 6. get_keyword_data ----
  const SE_TYPES = ['search_volume', 'keywords_for_site', 'keywords_for_keywords', 'ad_traffic_by_keywords', 'keyword_performance'] as const;

  server.registerTool(
    'get_keyword_data',
    {
      title: 'Get keywords_data metrics',
      description:
        'PAID — one DataForSEO keywords_data call (google_ads or bing; search_volume, keywords_for_site, keywords_for_keywords, ' +
        'ad_traffic_by_keywords or keyword_performance), cached after the first run for the same request. ' +
        'keywords_for_site needs a target domain instead of a keyword list; every other mode needs a keyword list.',
      inputSchema: {
        se: z.enum(['google_ads', 'bing']).default('google_ads'),
        seType: z.enum(SE_TYPES).default('search_volume').describe('DataForSEO seType, e.g. search_volume, keywords_for_site'),
        keywords: z.array(z.string()).max(KEYWORD_LIST_CAP).optional().describe('Required unless seType is keywords_for_site'),
        target: z.string().optional().describe('Target domain — required when seType is keywords_for_site'),
        targetType: z.string().optional().describe('e.g. "site" or "page" — only used with keywords_for_site'),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        searchPartners: z.boolean().optional(),
        includeAdultKeywords: z.boolean().optional(),
        device: z.string().optional().describe('Bing only, e.g. "desktop"/"mobile"/"all"'),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        sortBy: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ se, seType, keywords, target, targetType, location, language, searchPartners, includeAdultKeywords, device, dateFrom, dateTo, sortBy, confirm }) => {
      const loc = location?.trim() || getSetting('default_location') || 'France';
      const lang = language?.trim() || getSetting('default_language') || 'French';

      const body: Record<string, unknown> = { location_name: loc, language_name: lang };
      if (searchPartners) body.search_partners = true;
      if (dateFrom) body.date_from = dateFrom;
      if (dateTo) body.date_to = dateTo;
      if (sortBy && sortBy !== 'relevance') body.sort_by = sortBy;

      let kwList: string[] = [];
      const isSiteMode = seType === 'keywords_for_site';

      if (isSiteMode) {
        const cleanTarget = target?.trim() ?? '';
        if (!cleanTarget) return toolError('seType "keywords_for_site" requires a target domain.');
        body.target = cleanTarget;
        if (targetType) body.target_type = targetType;
        if (includeAdultKeywords) body.include_adult_keywords = true;
      } else {
        kwList = cleanKeywordList(keywords ?? []);
        if (kwList.length === 0) return toolError(`seType "${seType}" requires a non-empty keyword list.`);
        body.keywords = kwList;
        if (includeAdultKeywords) body.include_adult_keywords = true;
      }
      if (se === 'bing' && device) body.device = device;

      const dedupeId = stableSearchId(['keyword-data', se, seType, JSON.stringify(body)]);
      const cached = getKdResults<LabsItem>(dedupeId);
      if (cached) {
        const cost = getKdHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, count: cached.length, cost, cached: true });
      }

      if (!confirm) {
        const preview = isSiteMode
          ? { se, seType, target: body.target, location: loc, language: lang, billedCalls: 1 }
          : { se, seType, keywordCount: kwList.length, location: loc, language: lang, billedCalls: 1 };
        return dryRun('get_keyword_data', preview);
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeo<LabsItem>(`keywords_data/${se}/${seType}/live`, body, creds);
      if (error) return toolError(error);

      const items = result ?? [];
      if (items.length > 0) {
        const rawLabel = isSiteMode ? (String(body.target ?? 'site')) : kwList.slice(0, 3).join(', ');
        const label = rawLabel.length > 60 ? rawLabel.slice(0, 57) + '…' : rawLabel;

        const params: Record<string, string> = { se, se_type: seType, location: loc, language: lang };
        if (isSiteMode) {
          params.target = String(body.target ?? '');
          if (targetType) params.target_type = targetType;
        } else {
          params.keywords = kwList.join('\n');
        }
        if (searchPartners) params.search_partners = 'true';
        if (includeAdultKeywords) params.include_adult_keywords = 'true';
        if (device) params.device = device;
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;
        if (sortBy) params.sort_by = sortBy;

        const entry: KdHistoryEntry = { id: dedupeId, ts: Date.now(), se, seType, label, count: items.length, cost, params };
        saveKdSearch(entry, items);
      }
      return toolResult({ items, count: items.length, cost, cached: false });
    },
  );

  // ---- 7. get_top_searches ----
  server.registerTool(
    'get_top_searches',
    {
      title: 'Get top searches for a market',
      description:
        'PAID — one DataForSEO Labs call (top_searches), cached after the first run for the same location/language/limit/ignoreSynonyms. ' +
        'The most-searched keywords for a given location and language.',
      inputSchema: {
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        limit: z.number().optional().describe('Max results, 1-1000, default 100'),
        ignoreSynonyms: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ location, language, limit, ignoreSynonyms, confirm }) => {
      const loc = location?.trim() || defaultLabsLocation();
      const lang = language?.trim() || defaultLanguage();
      const lim = Math.min(Math.max(limit ?? 100, 1), 1000);
      const ignoreSyn = ignoreSynonyms ?? false;

      const dedupeId = stableSearchId(['top-searches', loc, lang, lim, ignoreSyn]);
      const cached = getTopSearchesResults<LabsItem>(dedupeId);
      if (cached) {
        const cachedEntry = getTopSearchesHistory().find((e) => e.id === dedupeId);
        return toolResult({ items: cached, count: cached.length, totalCount: cachedEntry?.totalCount, cost: cachedEntry?.cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_top_searches', { location: loc, language: lang, limit: lim, ignoreSynonyms: ignoreSyn, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: LabsItem[]; total_count?: number }>(
        'dataforseo_labs/google/top_searches/live',
        { location_name: loc, language_name: lang, limit: lim, ignore_synonyms: ignoreSyn, include_serp_info: false },
        creds,
        30_000,
      );
      if (error) return toolError(error);

      const items = result?.items ?? [];
      const totalCount = result?.total_count;
      if (items.length > 0) {
        const entry: TopSearchesEntry = { id: dedupeId, ts: Date.now(), location: loc, language: lang, limitCount: lim, count: items.length, totalCount, cost };
        saveTopSearches(entry, items);
      }
      return toolResult({ items, count: items.length, totalCount, cost, cached: false });
    },
  );
}
