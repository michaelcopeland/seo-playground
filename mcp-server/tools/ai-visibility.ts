import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCredentials, getSetting,
  getAiKwDataHistory, saveAiKwDataSearch, getAiKwDataResults, type AiKwDataEntry,
  getAiOptimizationHistory, saveAiOptimizationSearch, getAiOptimizationResults, type AiOptimizationEntry,
  getLlmResponseHistory, saveLlmResponseSearch, getLlmResponseResult, type LlmResponseEntry,
  getAiVisibilityHistory, saveAiVisibilitySearch, getAiVisibilityResult, type AiVisibilityEntry,
  getFanOutHistory, saveFanOutSearch, getFanOutResults, getFanOutSeedSummary, type FanOutEntry,
} from '../../src/lib/db';
import { toLabsCountry } from '../../src/lib/geo-options';
import { stableSearchId } from '../../src/lib/dedupe';
import { callDataForSeoFirst } from '../../src/lib/dataforseo';
import { MODELS_BY_PLATFORM, isValidPlatform, type LlmPlatform } from '../../src/lib/llm-options';
import { dryRun, toolResult, toolError, missingCredentialsError } from '../guardrails';
import { KEYWORD_LIST_CAP, FAN_OUT_SEED_CAP } from '../limits';

// ---- Shared types ----

interface MonthlyAiSearch {
  year: number;
  month: number;
  ai_search_volume: number;
}

function defaultGeo() {
  return {
    location: toLabsCountry(getSetting('default_location') ?? 'France'),
    language: getSetting('default_language') ?? 'French',
  };
}

// ---- Tool 1: get_ai_keyword_data ----

interface AiKeywordItem {
  keyword?: string;
  ai_search_volume?: number;
  ai_monthly_searches?: MonthlyAiSearch[];
}

// ---- Tool 2: search_llm_mentions ----

interface Source {
  url?: string;
  domain?: string;
  title?: string;
}

interface MonthlySearch {
  year: number;
  month: number;
  search_volume: number;
}

interface MentionItem {
  platform?: string;
  model_name?: string;
  question?: string;
  answer?: string;
  sources?: Source[];
  ai_search_volume?: number;
  monthly_searches?: MonthlySearch[];
  brand_entities?: Array<{ title?: string; category?: string }>;
  // The API returns these as plain strings, not { keyword } objects.
  fan_out_queries?: string[];
  first_response_at?: string;
  last_response_at?: string;
}

function buildMentionsTargetObj(value: string, type: 'domain' | 'keyword') {
  return type === 'domain'
    ? { domain: value, search_filter: 'include', search_scope: ['any'] }
    : { keyword: value, search_filter: 'include', search_scope: ['any'], match_type: 'word_match' };
}

// ---- Tool 3: get_llm_response ----

interface Annotation {
  title?: string;
  url?: string;
}

interface ResponseSection {
  type?: string;
  text?: string;
  annotations?: Annotation[];
}

interface ResponseItem {
  type?: string;
  sections?: ResponseSection[];
}

interface LlmResponseResult {
  platform?: string;
  model_name?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  web_search?: boolean;
  money_spent?: number;
  datetime?: string;
  items?: ResponseItem[];
  fan_out_queries?: Array<{ keyword?: string }> | null;
}

// ---- Tools 4-6: AI Visibility (target / leaderboard / historical) ----

interface AggMetric {
  key: string | number;
  mentions: number;
  ai_search_volume: number;
}

interface AggregatedMetrics {
  location?: AggMetric[];
  language?: AggMetric[];
  platform?: AggMetric[];
  sources_domain?: AggMetric[];
  search_results_domain?: AggMetric[];
  brand_entities_title?: AggMetric[];
  brand_entities_category?: AggMetric[];
  total?: { mentions: number; ai_search_volume: number };
}

interface TargetMetricsResult {
  total_count: number;
  aggregated_metrics: AggregatedMetrics;
}

interface LeaderboardItem {
  domain?: string;
  brand?: string;
  total: { mentions: number; ai_search_volume: number };
}

interface LeaderboardResult {
  domains: LeaderboardItem[];
  brands: LeaderboardItem[];
}

interface HistoricalItem {
  year: number;
  month: number;
  metrics: { mentions: number; ai_search_volume: number };
}

interface HistoricalResult {
  items_count: number;
  items: HistoricalItem[];
}

async function callLlmMentions<T>(
  fn: string, body: Record<string, unknown>, login: string, pass: string,
): Promise<{ result?: T; cost?: number; error?: string }> {
  return callDataForSeoFirst<T>(`ai_optimization/llm_mentions/${fn}/live`, body, { login, pass });
}

// ---- Tool 7: query_fan_out ----

interface FanOutMentionItem {
  question?: string;
  fan_out_queries?: string[];
}

interface FanOutQueryItem {
  keyword: string;
  ai_search_volume?: number;
  ai_monthly_searches?: MonthlyAiSearch[];
  seeds: string[];
  mentions: number;
}

interface SeedStat {
  seed: string;
  mentions: number;
  fanOutQueries: number;
  error?: string;
}

interface AiKeywordVolumeItem {
  keyword?: string;
  ai_search_volume?: number;
  ai_monthly_searches?: MonthlyAiSearch[];
}

/**
 * Mirrors `fetchFanOutMentions` in `src/app/dashboard/query-fan-out/page.tsx` (not exported, so
 * reimplemented here). The
 * live endpoint rejects more than one task per POST body ("You can set only one task at a time"),
 * so this is genuinely one billed call per seed, fired in parallel.
 */
async function fetchFanOutMentions(
  seeds: string[],
  platform: string,
  location: string,
  language: string,
  limit: number,
  login: string,
  pass: string,
): Promise<{ perSeed: Array<{ seed: string; items: FanOutMentionItem[]; error?: string; cost: number }>; totalCost: number }> {
  const creds = { login, pass };

  const perSeed = await Promise.all(seeds.map(async (seed) => {
    const targetObj = { keyword: seed, search_filter: 'include', search_scope: ['fan_out_queries'], match_type: 'word_match' };
    const body: Record<string, unknown> = { target: [targetObj], platform, limit };
    // ChatGPT isn't geo/language-targeted like Google AI is — the API rejects location_name/
    // language_name outright when platform is chat_gpt, so only send them for google.
    if (platform === 'google') {
      body.location_name = location;
      body.language_name = language;
    }

    const { result, cost, error } = await callDataForSeoFirst<{ items?: FanOutMentionItem[] }>(
      'ai_optimization/llm_mentions/search/live', body, creds,
    );
    if (error) return { seed, items: [] as FanOutMentionItem[], error, cost: 0 };
    return { seed, items: result?.items ?? [], cost: cost ?? 0 };
  }));

  const totalCost = perSeed.reduce((s, r) => s + r.cost, 0);
  return { perSeed, totalCost };
}

async function fetchFanOutKeywordVolume(
  keywords: string[],
  location: string,
  language: string,
  login: string,
  pass: string,
): Promise<{ items: AiKeywordVolumeItem[]; cost?: number; error?: string }> {
  if (keywords.length === 0) return { items: [] };
  const { result, cost, error } = await callDataForSeoFirst<{ items?: AiKeywordVolumeItem[] }>(
    'ai_optimization/ai_keyword_data/keywords_search_volume/live',
    { keywords, location_name: location, language_name: language },
    { login, pass },
  );
  if (error) return { items: [], error };
  return { items: result?.items ?? [], cost };
}

/** Runs both stages: discover fan-out queries per seed, then enrich the deduped set with AI search volume. */
async function runFanOut(
  seeds: string[],
  platform: string,
  location: string,
  language: string,
  limit: number,
  login: string,
  pass: string,
): Promise<{ items: FanOutQueryItem[]; seedStats: SeedStat[]; cost: number; error?: string }> {
  const { perSeed, totalCost: mentionsCost } = await fetchFanOutMentions(seeds, platform, location, language, limit, login, pass);

  const queryMap = new Map<string, FanOutQueryItem>();
  const seedStats: SeedStat[] = [];

  for (const { seed, items, error } of perSeed) {
    let fanOutCount = 0;
    for (const item of items) {
      for (const fq of item.fan_out_queries ?? []) {
        const keyword = fq?.trim();
        if (!keyword) continue;
        fanOutCount++;
        const key = keyword.toLowerCase();
        const existing = queryMap.get(key);
        if (existing) {
          if (!existing.seeds.includes(seed)) existing.seeds.push(seed);
          existing.mentions++;
        } else {
          queryMap.set(key, { keyword, seeds: [seed], mentions: 1 });
        }
      }
    }
    seedStats.push({ seed, mentions: items.length, fanOutQueries: fanOutCount, error });
  }

  // Most-surfaced queries first, so a truncation at the AI Keyword Data endpoint's cap drops the least relevant.
  const discovered = [...queryMap.values()].sort((a, b) => b.mentions - a.mentions).slice(0, KEYWORD_LIST_CAP);

  if (discovered.length === 0) {
    return { items: [], seedStats, cost: mentionsCost };
  }

  const volumeRes = await fetchFanOutKeywordVolume(discovered.map((d) => d.keyword), location, language, login, pass);
  if (volumeRes.error) {
    return { items: discovered, seedStats, cost: mentionsCost, error: volumeRes.error };
  }

  const volumeByKeyword = new Map(volumeRes.items.map((v) => [v.keyword?.toLowerCase() ?? '', v]));
  const merged = discovered.map((d) => {
    const v = volumeByKeyword.get(d.keyword.toLowerCase());
    return { ...d, ai_search_volume: v?.ai_search_volume, ai_monthly_searches: v?.ai_monthly_searches };
  });

  return { items: merged, seedStats, cost: mentionsCost + (volumeRes.cost ?? 0) };
}

// ---- Registration ----

export function registerAiVisibilityTools(server: McpServer) {
  server.registerTool(
    'get_ai_keyword_data',
    {
      title: 'Get AI Keyword Data',
      description:
        'PAID — one DataForSEO call billed per request (ai_optimization/ai_keyword_data/keywords_search_volume/live, batching all keywords into a single call), ' +
        'unless this exact keyword set + location + language was already searched in the last minute (cache hit, free). ' +
        `Search volume estimates for how keywords are used inside AI tools (ChatGPT, Gemini, etc). Up to ${KEYWORD_LIST_CAP} keywords per call.`,
      inputSchema: {
        keywords: z.array(z.string()).max(KEYWORD_LIST_CAP),
        location: z.string().optional().describe('Defaults to the saved Search Defaults location'),
        language: z.string().optional().describe('Defaults to the saved Search Defaults language'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ keywords, location, language, confirm }) => {
      const kwList = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, KEYWORD_LIST_CAP);
      if (kwList.length === 0) return toolError('No non-empty keywords provided.');

      const defaults = defaultGeo();
      const loc = location?.trim() || defaults.location;
      const lang = language?.trim() || defaults.language;

      const dedupeId = stableSearchId(['ai-keyword-data', kwList.join('\n'), loc, lang]);
      const cached = getAiKwDataResults<AiKeywordItem>(dedupeId);
      if (cached) {
        const cost = getAiKwDataHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_ai_keyword_data', { keywordCount: kwList.length, location: loc, language: lang, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callDataForSeoFirst<{ items?: AiKeywordItem[] }>(
        'ai_optimization/ai_keyword_data/keywords_search_volume/live',
        { keywords: kwList, location_name: loc, language_name: lang },
        { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);
      const items = result?.items ?? [];

      if (items.length > 0) {
        const label = kwList.slice(0, 3).join(', ') + (kwList.length > 3 ? '…' : '');
        const entry: AiKwDataEntry = { id: dedupeId, ts: Date.now(), keywords: label, location: loc, language: lang, count: items.length, cost };
        saveAiKwDataSearch(entry, items);
      }

      return toolResult({ items, cost });
    },
  );

  server.registerTool(
    'search_llm_mentions',
    {
      title: 'Search LLM mentions',
      description:
        'PAID — one DataForSEO call billed per request (ai_optimization/llm_mentions/search/live), ' +
        'unless this exact target + targetType + platform + location + language + limit was already searched in the last minute (cache hit, free). ' +
        'Finds how AI models (Google AI Overviews or ChatGPT) mention a keyword or domain, with sources and fan-out queries.',
      inputSchema: {
        target: z.string(),
        targetType: z.enum(['keyword', 'domain']).optional().describe('Default keyword'),
        platform: z.enum(['google', 'chat_gpt']).optional().describe('Default google'),
        location: z.string().optional().describe('Ignored for chat_gpt (forced to United States)'),
        language: z.string().optional().describe('Ignored for chat_gpt (forced to English)'),
        limit: z.number().optional().describe('1-100, default 20'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, targetType, platform, location, language, limit, confirm }) => {
      const targetValue = target.trim();
      if (!targetValue) return toolError('target must not be empty.');
      const tType = targetType ?? 'keyword';
      const plat = platform ?? 'google';
      const defaults = defaultGeo();
      // ChatGPT mentions are US/English only; the API rejects location_name/language_name for chat_gpt.
      const loc = plat === 'chat_gpt' ? 'United States' : (location?.trim() || defaults.location);
      const lang = plat === 'chat_gpt' ? 'English' : (language?.trim() || defaults.language);
      const lim = Math.min(Math.max(limit ?? 20, 1), 100);

      const dedupeId = stableSearchId(['ai-optimization', targetValue, tType, plat, loc, lang, lim]);
      const cached = getAiOptimizationResults<MentionItem>(dedupeId);
      if (cached) {
        const cost = getAiOptimizationHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cached, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('search_llm_mentions', { target: targetValue, targetType: tType, platform: plat, location: loc, language: lang, limit: lim, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const body: Record<string, unknown> = { target: [buildMentionsTargetObj(targetValue, tType)], platform: plat, limit: lim };
      if (plat === 'google') {
        body.location_name = loc;
        body.language_name = lang;
      }

      const { result, cost, error } = await callDataForSeoFirst<{ items?: MentionItem[] }>(
        'ai_optimization/llm_mentions/search/live', body, { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);
      const items = result?.items ?? [];

      const entry: AiOptimizationEntry = {
        id: dedupeId, ts: Date.now(), target: targetValue, targetType: tType, platform: plat, location: loc, language: lang, limit: lim, cost,
      };
      saveAiOptimizationSearch(entry, items);

      return toolResult({ items, cost });
    },
  );

  server.registerTool(
    'get_llm_response',
    {
      title: 'Get LLM response',
      description:
        'PAID — one DataForSEO call billed per request (ai_optimization/{platform}/llm_responses/live), ' +
        'unless this exact platform + model + prompt + systemMessage + webSearch + countryCode was already run in the last minute (cache hit, free). ' +
        'Asks ChatGPT, Claude, Gemini, or Perplexity a prompt directly and returns its full response with sources and token usage.',
      inputSchema: {
        platform: z.enum(['chat_gpt', 'claude', 'gemini', 'perplexity']).optional().describe('Default chat_gpt'),
        model: z.string().optional().describe('Defaults to a curated model for the platform, e.g. gpt-4o for chat_gpt'),
        prompt: z.string(),
        systemMessage: z.string().optional(),
        webSearch: z.boolean().optional().describe('Ignored for perplexity, which always searches the web'),
        countryCode: z.string().optional().describe('ISO country code for web search results, e.g. US — only sent when webSearch is on or platform is perplexity'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ platform, model, prompt, systemMessage, webSearch, countryCode, confirm }) => {
      const promptValue = prompt.trim();
      if (!promptValue) return toolError('prompt must not be empty.');
      const plat: LlmPlatform = platform && isValidPlatform(platform) ? platform : 'chat_gpt';
      const modelValue = model?.trim() || MODELS_BY_PLATFORM[plat][0];
      const sysMsg = systemMessage?.trim() ?? '';
      const wSearch = webSearch ?? false;
      const cc = countryCode?.trim() ?? '';

      const dedupeId = stableSearchId(['llm-responses', plat, modelValue, promptValue, sysMsg, wSearch, cc]);
      const cached = getLlmResponseResult<LlmResponseResult>(dedupeId);
      if (cached) {
        const cost = getLlmResponseHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ result: cached, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_llm_response', { platform: plat, model: modelValue, prompt: promptValue, webSearch: wSearch, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const body: Record<string, unknown> = { user_prompt: promptValue, model_name: modelValue };
      // Perplexity always searches the web, so the API rejects the web_search flag for it.
      if (plat !== 'perplexity') body.web_search = wSearch;
      if (sysMsg) body.system_message = sysMsg;
      if (cc && (wSearch || plat === 'perplexity')) body.web_search_country_iso_code = cc.toUpperCase();

      const { result, cost, error } = await callDataForSeoFirst<LlmResponseResult>(
        `ai_optimization/${plat}/llm_responses/live`, body, { login: creds.login, pass: creds.pass },
      );
      if (error) return toolError(error);

      if (result) {
        const entry: LlmResponseEntry = { id: dedupeId, ts: Date.now(), platform: plat, model: modelValue, prompt: promptValue, webSearch: wSearch, cost };
        saveLlmResponseSearch(entry, result);
      }

      return toolResult({ result, cost });
    },
  );

  server.registerTool(
    'get_ai_visibility_target_metrics',
    {
      title: 'Get AI Visibility target metrics',
      description:
        'PAID — one DataForSEO call billed per request (ai_optimization/llm_mentions/target_metrics/live), ' +
        'unless this exact target was already searched in the last minute (cache hit, free). ' +
        'Aggregated LLM-mention metrics (mentions, AI search volume) for one domain or keyword, broken down by platform, location, source domains, and brand entities. This is the "my domain/brand" mode of AI Visibility.',
      inputSchema: {
        target: z.string(),
        targetType: z.enum(['keyword', 'domain']).optional().describe('Default keyword'),
        platform: z.enum(['google', 'chat_gpt']).optional().describe('Default chat_gpt'),
        limit: z.number().optional().describe('Not sent to this endpoint — included only for cache-key parity with the app\'s other AI Visibility modes'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, targetType, platform, limit, confirm }) => {
      const targetValue = target.trim();
      if (!targetValue) return toolError('target must not be empty.');
      const tType = targetType ?? 'keyword';
      const plat = platform ?? 'chat_gpt';
      const lim = Math.min(Math.max(limit ?? 10, 1), 50);

      const dedupeId = stableSearchId(['ai-visibility', 'target', targetValue, tType, plat, lim]);
      const cached = getAiVisibilityResult<TargetMetricsResult>(dedupeId);
      if (cached) {
        const cost = getAiVisibilityHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ result: cached, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_ai_visibility_target_metrics', { target: targetValue, targetType: tType, platform: plat, billedCalls: 1 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const { result, cost, error } = await callLlmMentions<TargetMetricsResult>(
        'target_metrics', { target: [buildMentionsTargetObj(targetValue, tType)], platform: plat }, creds.login, creds.pass,
      );
      if (error) return toolError(error);

      if (result) {
        const entry: AiVisibilityEntry = { id: dedupeId, ts: Date.now(), mode: 'target', target: targetValue, platform: plat, cost };
        saveAiVisibilitySearch(entry, result);
      }

      return toolResult({ result, cost });
    },
  );

  server.registerTool(
    'get_ai_visibility_leaderboard',
    {
      title: 'Get AI Visibility leaderboard',
      description:
        'PAID — fires two DataForSEO calls in parallel and bills for both (ai_optimization/llm_mentions/top_mentioned_domains/live + top_mentioned_brands/live), ' +
        'unless this exact target was already searched in the last minute (cache hit, free). ' +
        'Top domains and brands mentioned by LLMs for a topic/keyword or domain — "who dominates this topic" mode of AI Visibility.',
      inputSchema: {
        target: z.string(),
        targetType: z.enum(['keyword', 'domain']).optional().describe('Default keyword'),
        platform: z.enum(['google', 'chat_gpt']).optional().describe('Default chat_gpt'),
        limit: z.number().optional().describe('Results per list, 1-50, default 10'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, targetType, platform, limit, confirm }) => {
      const targetValue = target.trim();
      if (!targetValue) return toolError('target must not be empty.');
      const tType = targetType ?? 'keyword';
      const plat = platform ?? 'chat_gpt';
      const lim = Math.min(Math.max(limit ?? 10, 1), 50);

      const dedupeId = stableSearchId(['ai-visibility', 'leaderboard', targetValue, tType, plat, lim]);
      const cached = getAiVisibilityResult<LeaderboardResult>(dedupeId);
      if (cached) {
        const cost = getAiVisibilityHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ result: cached, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_ai_visibility_leaderboard', { target: targetValue, targetType: tType, platform: plat, limit: lim, billedCalls: 2 });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const body = { target: [buildMentionsTargetObj(targetValue, tType)], platform: plat, limit: lim };
      const [domainsRes, brandsRes] = await Promise.all([
        callLlmMentions<{ items?: LeaderboardItem[] }>('top_mentioned_domains', body, creds.login, creds.pass),
        callLlmMentions<{ items?: LeaderboardItem[] }>('top_mentioned_brands', body, creds.login, creds.pass),
      ]);
      if (domainsRes.error || brandsRes.error) return toolError(domainsRes.error ?? brandsRes.error ?? 'Unknown error.');

      const result: LeaderboardResult = { domains: domainsRes.result?.items ?? [], brands: brandsRes.result?.items ?? [] };
      const cost = (domainsRes.cost ?? 0) + (brandsRes.cost ?? 0);

      const entry: AiVisibilityEntry = { id: dedupeId, ts: Date.now(), mode: 'leaderboard', target: targetValue, platform: plat, cost };
      saveAiVisibilitySearch(entry, result);

      return toolResult({ result, cost });
    },
  );

  server.registerTool(
    'get_ai_visibility_historical',
    {
      title: 'Get AI Visibility historical trend',
      description:
        'PAID — one DataForSEO call billed per request (ai_optimization/llm_mentions/historical/live), ' +
        'unless this exact target + location + language + date range was already searched in the last minute (cache hit, free). ' +
        'Monthly mentions and AI search volume trend for a domain, keyword, or brand — "trend over time" mode of AI Visibility.',
      inputSchema: {
        target: z.string(),
        targetType: z.enum(['keyword', 'domain']).optional().describe('Default keyword'),
        platform: z.enum(['google', 'chat_gpt']).optional().describe('Default chat_gpt'),
        location: z.string().optional().describe('Ignored for chat_gpt (forced to United States)'),
        language: z.string().optional().describe('Ignored for chat_gpt (forced to English)'),
        dateFrom: z.string().optional().describe('YYYY-MM-DD'),
        dateTo: z.string().optional().describe('YYYY-MM-DD'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ target, targetType, platform, location, language, dateFrom, dateTo, confirm }) => {
      const targetValue = target.trim();
      if (!targetValue) return toolError('target must not be empty.');
      const tType = targetType ?? 'keyword';
      const plat = platform ?? 'chat_gpt';
      const defaults = defaultGeo();
      const loc = plat === 'chat_gpt' ? 'United States' : (location?.trim() || defaults.location);
      const lang = plat === 'chat_gpt' ? 'English' : (language?.trim() || defaults.language);
      const dFrom = dateFrom?.trim() ?? '';
      const dTo = dateTo?.trim() ?? '';

      const dedupeId = stableSearchId(['ai-visibility', 'historical', targetValue, tType, plat, loc, lang, dFrom, dTo]);
      const cached = getAiVisibilityResult<HistoricalResult>(dedupeId);
      if (cached) {
        const cost = getAiVisibilityHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ result: cached, cost, cached: true });
      }

      if (!confirm) {
        return dryRun('get_ai_visibility_historical', {
          target: targetValue, targetType: tType, platform: plat, location: loc, language: lang, dateFrom: dFrom, dateTo: dTo, billedCalls: 1,
        });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const body: Record<string, unknown> = { target: [buildMentionsTargetObj(targetValue, tType)], platform: plat };
      // ChatGPT mentions are only tracked for United States / English, and the API rejects
      // location_name/language_name outright when platform is chat_gpt (same as the other LLM
      // Mentions endpoints) — so only send geo/language targeting for Google AI.
      if (plat === 'google') {
        body.location_name = loc;
        body.language_name = lang;
      }
      if (dFrom) body.date_from = dFrom;
      if (dTo) body.date_to = dTo;

      const { result, cost, error } = await callLlmMentions<HistoricalResult>('historical', body, creds.login, creds.pass);
      if (error) return toolError(error);

      if (result) {
        const entry: AiVisibilityEntry = { id: dedupeId, ts: Date.now(), mode: 'historical', target: targetValue, platform: plat, cost };
        saveAiVisibilitySearch(entry, result);
      }

      return toolResult({ result, cost });
    },
  );

  server.registerTool(
    'query_fan_out',
    {
      title: 'Query Fan-Out',
      description:
        `PAID and expensive — fires one DataForSEO call PER seed keyword in parallel (each seed is a separate billed lookup against ai_optimization/llm_mentions/search/live, hard-capped at ${FAN_OUT_SEED_CAP} seeds), ` +
        'plus one more enrichment call (ai_optimization/ai_keyword_data/keywords_search_volume/live) batching all discovered queries. Total billed calls = seedCount + 1. ' +
        'Skips billing entirely only on an exact cache hit (same seed set + platform + location + language + limit searched in the last minute). ' +
        'Discovers the hidden sub-queries AI models generate when answering prompts related to your seed keywords, and their AI search volume.',
      inputSchema: {
        seeds: z.array(z.string()).max(FAN_OUT_SEED_CAP),
        platform: z.enum(['google', 'chat_gpt']).optional().describe('Default google'),
        location: z.string().optional().describe('Ignored for chat_gpt (forced to United States)'),
        language: z.string().optional().describe('Ignored for chat_gpt (forced to English)'),
        limit: z.number().optional().describe('Mentions checked per seed, 1-100, default 20'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ seeds, platform, location, language, limit, confirm }) => {
      const seedList = [...new Set(seeds.map((s) => s.trim()).filter(Boolean))].slice(0, FAN_OUT_SEED_CAP);
      if (seedList.length === 0) return toolError('No non-empty seeds provided.');

      const plat = platform ?? 'google';
      const defaults = defaultGeo();
      // ChatGPT mentions are US/English only; the API rejects location_name/language_name for chat_gpt.
      const loc = plat === 'chat_gpt' ? 'United States' : (location?.trim() || defaults.location);
      const lang = plat === 'chat_gpt' ? 'English' : (language?.trim() || defaults.language);
      const lim = Math.min(Math.max(limit ?? 20, 1), 100);

      const dedupeId = stableSearchId(['query-fan-out', seedList.join('\n'), plat, loc, lang, lim]);
      const cachedItems = getFanOutResults<FanOutQueryItem>(dedupeId);
      const cachedStats = getFanOutSeedSummary<SeedStat>(dedupeId);
      if (cachedItems) {
        const cost = getFanOutHistory().find((e) => e.id === dedupeId)?.cost;
        return toolResult({ items: cachedItems, seedStats: cachedStats ?? [], cost, cached: true });
      }

      if (!confirm) {
        return dryRun('query_fan_out', {
          seedCount: seedList.length, platform: plat, location: loc, language: lang, billedCalls: seedList.length + 1,
        });
      }

      const creds = getCredentials();
      if (!creds) return missingCredentialsError();

      const result = await runFanOut(seedList, plat, loc, lang, lim, creds.login, creds.pass);

      // Mirrors the page: always persists (even on a partial/enrichment error), since per-seed
      // results and the discovered-but-unenriched keyword list are still useful and already paid for.
      const label = seedList.slice(0, 3).join(', ') + (seedList.length > 3 ? '…' : '');
      const entry: FanOutEntry = {
        id: dedupeId, ts: Date.now(), seeds: label, platform: plat, location: loc, language: lang,
        seedCount: seedList.length, queryCount: result.items.length, cost: result.cost,
      };
      saveFanOutSearch(entry, result.items, result.seedStats);

      if (result.error) return toolError(result.error);
      return toolResult({ items: result.items, seedStats: result.seedStats, cost: result.cost });
    },
  );
}
