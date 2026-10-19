/**
 * Central provider registry for the Latino extension.
 * Order is priority order — every result is stamped with `providerPriority`
 * derived from its index (see `providerPriorityOf` in this module).
 */

import type { StreamProvider, MangaProvider } from '../types/index.js';

import azanimex from './stream/azanimex.js';
import pelisforte from './stream/pelisforte.js';
import sololatino from './stream/sololatino.js';
import shademangaAnime from './stream/shademanga-anime.js';
import yupmanga from './manga/yupmanga.js';
import shademanga from './manga/shademanga.js';

export const STREAM_PROVIDERS: StreamProvider[] = [
  azanimex,
  shademangaAnime,
  pelisforte,
  sololatino,
];

export const MANGA_PROVIDERS: MangaProvider[] = [
  shademanga,
  yupmanga,
];

const STREAM_RANK = new Map(STREAM_PROVIDERS.map((p, i) => [p.name, i]));
const UNRANKED = STREAM_PROVIDERS.length + 1000;

/**
 * Providers that get a head start when the progressive runner streams chunks —
 * nothing here resolves faster than the index-based slot list, so no lead.
 */
export const LEAD_STREAM_PROVIDERS: string[] = [];

export function providerPriorityOf(providerName: string | undefined | null): number {
  const name = String(providerName || '').trim().toLowerCase();
  if (!name) return UNRANKED;
  const stream = STREAM_RANK.get(name);
  if (stream !== undefined) return stream;
  const base = name.split('-')[0];
  return STREAM_RANK.get(base) ?? UNRANKED;
}
