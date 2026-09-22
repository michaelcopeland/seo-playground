/**
 * Authoritative per-endpoint batch caps, sourced from DataForSEO's documented max tasks/items
 * per request rather than copied from each page's UI-side `.slice(0, N)` — those were sized for
 * form-field usability, not necessarily the API's actual limit.
 */

/** `dataforseo_labs/*` and `keywords_data/*` bulk endpoints (keyword_overview, search_intent, etc). */
export const KEYWORD_LIST_CAP = 1000;

/** `backlinks/bulk_*` endpoints. */
export const BULK_TARGET_CAP = 1000;

/** `dataforseo_labs/google/page_intersection` — the UI caps this one tighter than its backlinks namesake. */
export const LABS_PAGE_INTERSECTION_CAP = 5;

/** `backlinks/page_intersection`. */
export const BACKLINKS_PAGE_INTERSECTION_CAP = 20;

/** Rank Tracker's `add_tracked_keywords` — mirrors `addKeywordAction`'s per-submission cap. */
export const RANK_TRACKER_ADD_CAP = 50;

/** Query Fan-Out: the endpoint rejects >1 task per POST, so every seed is its own billed call. */
export const FAN_OUT_SEED_CAP = 20;
