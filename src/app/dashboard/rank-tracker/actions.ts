'use server';

import {
  getCredentials, getTrackedKeywords, addTrackedKeyword,
  removeTrackedKeyword, saveRankCheck, getSetting, setSetting,
  addTargetDomain, removeTargetDomain,
} from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

interface SerpItem {
  type: string;
  rank_absolute: number;
  url?: string;
  title?: string;
  domain?: string;
}

interface SerpResponse {
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: Array<{ items?: SerpItem[] }>;
  }>;
}

function cleanDomain(d: string) {
  return d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

/**
 * Checks each keyword against DataForSEO's `live` (synchronous) SERP endpoint, one task per
 * request. The live endpoint accepts an array of tasks but executes only index 0 and returns
 * `40000 You can set only one task at a time` for the rest, so batching silently dropped every
 * keyword after the first. Failures are logged instead of being treated as "not ranking".
 */
async function checkKeywordsBatch(
  keywords: Array<{ id: number; keyword: string; domain: string; location: string; language: string }>,
) {
  const creds = getCredentials();
  if (!creds || keywords.length === 0) return;

  const depth = parseInt(getSetting('rank_tracker_depth') ?? '100', 10);
  const auth = btoa(`${creds.login}:${creds.pass}`);

  for (const kw of keywords) {
    let res: Response;
    try {
      res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          keyword: kw.keyword,
          location_name: kw.location,
          language_name: kw.language,
          depth,
        }]),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      console.error(`[rank-tracker] SERP request failed for "${kw.keyword}" (${kw.domain}):`, err);
      continue;
    }
    if (!res.ok) {
      console.error(`[rank-tracker] SERP request for "${kw.keyword}" (${kw.domain}) returned HTTP ${res.status} ${res.statusText}`);
      continue;
    }

    const data = await res.json() as SerpResponse;
    const task = data.tasks?.[0];

    // Skip saving if the task itself returned an API-level error (preserves existing data)
    if (task?.status_code !== 20000) {
      console.error(`[rank-tracker] SERP check failed for "${kw.keyword}" (${kw.domain}): ${task?.status_code ?? 'no task'} ${task?.status_message ?? ''}`);
      continue;
    }

    const items = task?.result?.[0]?.items ?? [];
    const cost = task?.cost ?? null;

    // Split by '/' so a tracked domain like "example.com/page" still matches
    const domain = cleanDomain(kw.domain).split('/')[0];
    const hit = items.find((item) => {
      if (item.type !== 'organic') return false;
      const d = cleanDomain(item.domain ?? item.url ?? '').split('/')[0];
      return d === domain || d.endsWith('.' + domain);
    });

    saveRankCheck(kw.id, hit?.rank_absolute ?? null, hit?.url ?? null, hit?.title ?? null, cost);
  }
}

export async function saveDepthAction(formData: FormData) {
  const depth = formData.get('rank_tracker_depth') as string;
  const valid = ['10', '20', '50', '100'];
  if (valid.includes(depth)) setSetting('rank_tracker_depth', depth);
  revalidatePath('/dashboard/rank-tracker');
}

export async function addDomainAction(formData: FormData) {
  const domain = (formData.get('domain') as string)?.trim();
  if (!domain) return;
  addTargetDomain(domain);
  revalidatePath('/dashboard/rank-tracker');
  redirect(`/dashboard/rank-tracker?domain=${encodeURIComponent(domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''))}`);
}

export async function removeDomainAction(formData: FormData) {
  const domain = formData.get('domain') as string;
  if (!domain) return;
  removeTargetDomain(domain);
  redirect('/dashboard/rank-tracker');
}

export async function addKeywordAction(formData: FormData) {
  const raw = (formData.get('keywords') as string) ?? '';
  const domain = (formData.get('domain') as string)?.trim();
  const location = (formData.get('location') as string)?.trim() || 'France';
  const language = (formData.get('language') as string)?.trim() || 'French';

  if (!domain) return;
  addTargetDomain(domain);

  const kwList = raw.split('\n').map((k) => k.trim()).filter(Boolean).slice(0, 50);
  if (kwList.length === 0) return;

  const toCheck: Array<{ id: number; keyword: string; domain: string; location: string; language: string }> = [];
  for (const keyword of kwList) {
    const id = addTrackedKeyword(keyword, domain, location, language);
    toCheck.push({ id, keyword, domain, location, language });
  }

  await checkKeywordsBatch(toCheck);
  revalidatePath('/dashboard/rank-tracker');
}

export async function removeKeywordAction(formData: FormData) {
  const id = Number(formData.get('id'));
  if (!id) return;
  removeTrackedKeyword(id);
  revalidatePath('/dashboard/rank-tracker');
}

export async function checkOneAction(formData: FormData) {
  const id = Number(formData.get('id'));
  const keyword = formData.get('keyword') as string;
  const domain = formData.get('domain') as string;
  const location = formData.get('location') as string;
  const language = formData.get('language') as string;
  if (!id || !keyword || !domain) return;
  await checkKeywordsBatch([{ id, keyword, domain, location, language }]);
  revalidatePath('/dashboard/rank-tracker');
}

export async function checkAllAction(formData: FormData) {
  const domain = (formData.get('domain') as string | null)?.trim() ?? '';
  const keywords = getTrackedKeywords();
  await checkKeywordsBatch(keywords);
  redirect(domain ? `/dashboard/rank-tracker?domain=${encodeURIComponent(domain)}` : '/dashboard/rank-tracker');
}

export async function checkDomainAction(formData: FormData) {
  const domain = formData.get('domain') as string;
  if (!domain) return;
  const keywords = getTrackedKeywords().filter((k) => k.domain === domain);
  await checkKeywordsBatch(keywords);
  redirect(`/dashboard/rank-tracker?domain=${encodeURIComponent(domain)}`);
}
