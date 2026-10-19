/**
 * AniList anime title resolution for stream providers.
 *
 * The in-app extension host forwards only what the Watch page sends — usually
 * one English title. Providers search Spanish-language catalogues, where the
 * romaji/alternate titles are what actually match, so the bundle enriches the
 * search titles from the AniList id before fanning out. Mirrors the merge
 * order of the standalone API (`anilist titles first, caller titles after`)
 * and the synonym filter of `usefulSynonyms` in
 * desktop/runtime/extension-api-host/host-server.cjs.
 */

import { fetchResponse } from '../http/fetch.js';
import type { SourceOptions } from '../../types/index.js';

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

const LATIN_TITLE_RE = /^[\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\p{S}]+$/u;

function isAbbreviation(s: string): boolean {
  if (/\s/.test(s)) return false;
  if (s.length <= 4) return true;
  return s.length <= 6 && s === s.toUpperCase() && /[A-Z]/.test(s);
}

function usefulSynonyms(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && LATIN_TITLE_RE.test(s) && !isAbbreviation(s))
    .slice(0, 2);
}

// AniList id → titles, cached for the worker's lifetime. Titles never change,
// so a permanent per-process cache is safe and spares the GraphQL round trip
// on every provider fan-out.
const titleCache = new Map<number, string[]>();

export async function resolveAnimeTitles(anilistId: number | undefined | null): Promise<string[]> {
  const id = Number(anilistId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const cached = titleCache.get(id);
  if (cached) return cached;

  try {
    const res = await fetchResponse(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: `query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji userPreferred native } synonyms } }`,
        variables: { id },
      }),
      timeoutMs: 5000,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data?: { Media?: { title?: Record<string, string | null>; synonyms?: string[] } };
    };
    const media = data?.data?.Media;
    const t = media?.title;
    if (!t) return [];

    // Canonical titles first — synonyms go last.
    const titles = Array.from(new Set(
      [t.english, t.romaji, t.userPreferred, t.native, ...usefulSynonyms(media?.synonyms)]
        .filter((v): v is string => Boolean(v && v.trim()))
        .map((v) => v.trim()),
    ));
    titleCache.set(id, titles);
    return titles;
  } catch {
    return [];
  }
}

/**
 * Merge caller titles with AniList canonical titles — AniList first (most
 * canonical, and what matches the Spanish catalogues), caller extras after.
 * Returns the original options object when there is nothing to add.
 */
export async function enrichSourceTitles<T extends { anilistId?: number; titles?: string[] }>(
  opts: T,
): Promise<T> {
  const caller = (opts.titles ?? []).filter(Boolean);
  const resolved = await resolveAnimeTitles(opts.anilistId);
  if (resolved.length === 0) {
    return caller.length ? { ...opts, titles: caller } : opts;
  }

  // Canonical (long) titles rarely match substring-only site searches —
  // "Mushoku Tensei: Jobless Reincarnation" hits nothing on a LIKE-'%q%'
  // backend while "Mushoku Tensei" does. Append subtitle-free base variants
  // after the canonical set so search-looping providers can fall back to them.
  const bases = resolved
    .map((t) => t.split(/[:\u2013\u2014]+/)[0]?.trim() ?? '')
    .filter((b) => b.length >= 4 && !resolved.some((r) => r.toLowerCase() === b.toLowerCase()));

  const seen = new Set<string>();
  const merged = [...resolved, ...bases, ...caller].filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...opts, titles: merged };
}
