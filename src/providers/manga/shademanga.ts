/**
 * ShadeManga — https://www.shademanga.com (SPANISH MANGA)
 *
 * A Next-style SPA whose content lives entirely behind a same-origin JSON API
 * (`/api/...`). The public surface was verified live from a non-browser
 * client:
 *
 *   - search   `GET /api/series-locales/search-candidates?q=<query>&take=20`
 *              → `[{ id, publicId, titulo, titulosAlternativos, generos, portadaUrl }]`
 *   - chapters `GET /api/series-locales/{numericId}/capitulos`
 *              → `[{ id, publicId, numeroCapitulo, titulo, totalPaginas,
 *                    fechaSubida, grupoScan: { nombre, slug } }]`
 *   - pages    `GET /api/series-locales/capitulo/{chapterPublicId}/paginas`
 *              → `{ paginas: ["https://cdn.shademanga.com/mangas/.../0001.webp?v=…"] }`
 *
 * Panels are on the site's own CDN (`cdn.shademanga.com`), served without a
 * token — no Referer replay needed.
 *
 * The apex host 404s some of these routes while `www.` always answers, so the
 * provider pins the `www` origin. No AniList id mapping on the site itself —
 * fuzzy title match through the shared resolver (`titulo` + `titulosAlternativos`).
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchJson } from '../../utils/http/fetch.js';
import { normalizeTitle } from '../../utils/scraping/title-normalizer.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.shademanga.com';
const API = `${BASE}/api`;
const PROVIDER_NAME = 'shademanga';

interface ShadeCandidate {
  id: number;
  publicId: string;
  titulo: string;
  titulosAlternativos?: string | null;
}

interface ShadeChapter {
  id: number;
  publicId: string;
  numeroCapitulo: number | string;
  titulo?: string | null;
  totalPaginas?: number | null;
  fechaSubida?: string | null;
  grupoScan?: { nombre?: string | null; slug?: string | null } | null;
}

/** Search the public catalogue for a title. */
async function search(query: string): Promise<ShadeCandidate[]> {
  const hits = await fetchJson<ShadeCandidate[]>(
    `${API}/series-locales/search-candidates?q=${encodeURIComponent(query)}&take=20`,
    { timeoutMs: 12000 }
  );
  return Array.isArray(hits) ? hits : [];
}

/** Best candidate across the queried titles (exact normalized hit wins first). */
async function resolveCandidate(params: MangaChapterParams): Promise<ShadeCandidate | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: ShadeCandidate[] = [];
  const seen = new Set<number>();
  for (const title of titles.slice(0, 3)) {
    for (const cand of await search(title)) {
      if (!Number.isFinite(cand?.id) || seen.has(cand.id)) continue;
      seen.add(cand.id);
      pool.push(cand);
    }
  }

  const namesOf = (c: ShadeCandidate): string[] =>
    [c.titulo, ...(c.titulosAlternativos || '').split(/[,;]|\|\s*/)].filter(
      (n): n is string => Boolean(n && n.trim()),
    );

  // Exact normalized equality is the common case on this site (ids are exact
  // title slugs), so try a direct hit before the generic fuzzy score.
  const normTargets = titles.map(normalizeTitle);
  for (const candidate of pool) {
    for (const name of namesOf(candidate)) {
      if (normTargets.includes(normalizeTitle(name))) return candidate;
    }
  }

  const best = pickBestMangaCandidate(titles, pool, namesOf, 0.6);
  return best ? best.candidate : null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE, 'https://shademanga.com'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const candidate = await resolveCandidate(params);
      if (!candidate) return [];

      const chapters = await fetchJson<ShadeChapter[]>(
        `${API}/series-locales/${candidate.id}/capitulos`,
        { timeoutMs: 15000 }
      );
      if (!Array.isArray(chapters) || chapters.length === 0) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      for (const ch of chapters) {
        const publicCapId = String(ch.publicId || ch.id || '').trim();
        if (!publicCapId) continue;

        const num = parseFloat(String(ch.numeroCapitulo ?? '').replace(/[^\d.]/g, ''));
        if (!Number.isFinite(num)) continue;

        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${publicCapId}`,
          providerChapterId: publicCapId,
          language: 'es',
          scanlator: ch.grupoScan?.nombre || ch.grupoScan?.slug || null,
          releaseDate: ch.fechaSubida ? ch.fechaSubida.slice(0, 10) : null,
        };

        const entry: MangaChapterEntry = {
          number: num,
          title: ch.titulo && ch.titulo !== '.' ? ch.titulo : null,
          volume: null,
          sources: [source],
        };
        const existing = byNumber.get(num);
        if (existing) existing.sources.push(...entry.sources);
        else byNumber.set(num, entry);
      }

      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const capId = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!capId) return [];

      const data = await fetchJson<{ paginas?: string[] }>(
        `${API}/series-locales/capitulo/${encodeURIComponent(capId)}/paginas`,
        { timeoutMs: 15000 }
      );
      const urls = Array.isArray(data?.paginas) ? data.paginas : [];
      return urls.filter(u => /^https?:\/\//.test(u)).map((url, i) => ({
        pageNumber: i + 1,
        imageUrl: url,
      }));
    } catch {
      return [];
    }
  },
};

export default provider;
