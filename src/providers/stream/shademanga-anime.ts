/**
 * ShadeManga Anime — https://www.shademanga.com  (SPANISH LATINO, SUB/DUB)
 *
 * ShadeManga's public JSON API also serves a full anime catalogue with
 * server-side video resolution. Verified live:
 *
 *   - search   `GET /api/anime?q=<query>&page=1&pageSize=20`
 *              → `{ items: [{ token, slug, titulo, portadaUrl }, …] }`
 *   - episode  `GET /api/anime/{token}/{num}` →
 *              `{ serie: {token, titulo, slug}, episodioId, numero, embeds: [
 *                 { servidor: "Mp4upload", embedUrl, idioma: "SUB"|"DUB" },
 *                 { servidor: "YourUpload", embedUrl, idioma }, …] }`
 *              `num` is the listing's own episode counter — each AniList title
 *              maps 1:1 to a shademanga listing (Naruto and Naruto Shippuden
 *              are separate rows), so the app-provided `opts.episode` can be
 *              called straight through without TMDB season flattening.
 *   - resolve  `GET /api/anime/resolve?servidor=<name>&embed=<url>` →
 *              `{ tipo: "mp4", url: "/api/anime/proxy?url=…&referer=…&sig=…",
 *                 original: "https://a4.mp4upload.com:183/…/video.mp4" }`
 *              `original` is the host's own direct link; `url` is the site's
 *              CDN proxy (verified 200 video/mp4). Unavailable hosts resolve to
 *              a `status`/`error` payload instead and are skipped.
 *
 * Both forms return plain MP4, so results are stamped `sourceType: 'mp4'` and
 * carry no extra headers (the proxy needs nothing, the original is a public
 * CDN). DUB rows are Latin American dubs → `es-419`; SUB rows → `ja` with
 * burned/dual subs.
 */
import type { StreamProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchJson, fetchResponse } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { normalizeTitle, scoreMatch } from '../../utils/scraping/title-normalizer.js';

const BASE = 'https://www.shademanga.com';
const PROVIDER_NAME = 'shademanga-anime';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const API_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json',
};

interface AnimeCandidate {
  token: string;
  slug: string;
  titulo: string;
}

interface EmbedRow {
  servidor: string;
  embedUrl: string;
  idioma: string | null;
}

interface ResolveResponse {
  tipo?: string;
  url?: string;
  original?: string;
  status?: string;
  error?: string;
}

/** One search against the anime catalogue (direct fetch, bypass fallback). */
async function searchAnime(q: string): Promise<any[] | null> {
  const url = `${BASE}/api/anime?q=${encodeURIComponent(q)}&page=1&pageSize=20`;
  try {
    const data = await fetchJson<any>(url, {
      headers: API_HEADERS,
      timeoutMs: 15000,
    });
    return data?.items ?? (Array.isArray(data) ? data : null);
  } catch {
    /* fall through to the bypass fetch */
  }
  const raw = await fetchTextWithBypass(url, {
    headers: API_HEADERS,
    timeoutMs: 15000,
  });
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data?.items ?? (Array.isArray(data) ? data : null);
  } catch {
    return null;
  }
}

/**
 * Search the catalogue by the provided titles.
 *
 * The API is a substring search, so long canonical titles
 * ("Mushoku Tensei: Jobless Reincarnation") match nothing while the
 * subtitle-free base ("Mushoku Tensei") matches the whole franchise. Each
 * title contributes a full + base query, searching until an exact
 * (normalized-equal) listing appears, and the final pick scores the pooled
 * candidates against every target title.
 */
async function findToken(titles: string[]): Promise<string | null> {
  const pool = new Map<string, AnimeCandidate>();
  const normTargets = titles.map(normalizeTitle).filter(Boolean);

  const exactHit = (): string | null => {
    for (const row of pool.values()) {
      const norm = normalizeTitle(row.titulo);
      if (norm && normTargets.some((t) => t === norm)) return row.token;
    }
    return null;
  };

  const queries: string[] = [];
  for (const title of titles.slice(0, 2)) {
    const clean = title.trim();
    if (!clean) continue;
    queries.push(clean);
    const base = clean.split(/[:\u2013\u2014]+/)[0]?.trim();
    if (base && base.length >= 4 && base !== clean) queries.push(base);
  }

  const seenQ = new Set<string>();
  for (const q of queries) {
    const key = q.toLowerCase();
    if (seenQ.has(key)) continue;
    seenQ.add(key);

    const rows = await searchAnime(q);
    if (!rows) continue;
    for (const row of rows) {
      if (row?.token && row?.titulo) {
        pool.set(row.token, { token: row.token, slug: row.slug || '', titulo: String(row.titulo) });
      }
    }
    if (pool.size > 0) {
      const hit = exactHit();
      if (hit) return hit;
    }
  }

  if (pool.size === 0) return null;

  let best: { token: string; score: number } | null = null;
  for (const row of pool.values()) {
    const norm = normalizeTitle(row.titulo);
    let score = 0;
    for (const t of normTargets) score = Math.max(score, scoreMatch(t, norm));
    if (!best || score > best.score) best = { token: row.token, score };
  }
  return best && best.score >= 0.62 ? best.token : null;
}

/** Resolve one embed to site-proxy + original direct mp4. */
async function resolveEmbed(row: EmbedRow): Promise<ResolveResponse | null> {
  const params = new URLSearchParams({ servidor: row.servidor, embed: row.embedUrl });
  try {
    const res = await fetchResponse(`${BASE}/api/anime/resolve?${params.toString()}`, {
      headers: { ...API_HEADERS, Referer: `${BASE}/` },
      timeoutMs: 20000,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ResolveResponse;
    if (!data || (!data.url && !data.original)) return null;
    return data;
  } catch {
    return null;
  }
}

const provider: StreamProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const episode = Number(opts.episode);
      if (!Number.isFinite(episode) || episode <= 0) return [];

      const token = await findToken(opts.titles);
      if (!token) return [];

      let episodeData: any = null;
      try {
        episodeData = await fetchJson<any>(`${BASE}/api/anime/${token}/${episode}`, {
          headers: API_HEADERS,
          timeoutMs: 15000,
        });
      } catch {
        episodeData = null;
      }
      if (!episodeData) return [];

      const embeds: EmbedRow[] = Array.isArray(episodeData.embeds) ? episodeData.embeds : [];
      if (embeds.length === 0) return [];

      // Resolve at most 4 embeds, DUB-first for a Latino catalogue.
      const picked = [...embeds].slice(0, 4);
      const results: SourceResult[] = [];
      let serverIndex = 1;

      for (const row of picked) {
        if (!row?.embedUrl || !row?.servidor) continue;
        const resolved = await resolveEmbed(row);
        if (!resolved) continue;

        const dubbed = String(row.idioma || '').toUpperCase() === 'DUB';
        const audioLanguage = dubbed ? 'es-419' : 'ja';
        const languageLabel = dubbed ? 'Latino (Doblado)' : 'Subtitulado';
        const serverLabel = `${row.servidor} ${dubbed ? 'DUB' : 'SUB'}`;

        // Original link first when the host exposed one, then the site proxy.
        if (resolved.original && /^https?:\/\//.test(resolved.original)) {
          results.push({
            source: PROVIDER_NAME,
            url: resolved.original,
            quality: 'auto',
            headers: { 'User-Agent': UA, Referer: 'https://www.mp4upload.com/' },
            subtitles: [],
            audioLanguage,
            language: languageLabel,
            sourceType: 'mp4',
            server: `${serverLabel} (directo)`,
            providerName: PROVIDER_NAME,
          });
        }
        if (resolved.url) {
          const proxyUrl = resolved.url.startsWith('/') ? `${BASE}${resolved.url}` : resolved.url;
          results.push({
            source: PROVIDER_NAME,
            url: proxyUrl,
            quality: 'auto',
            headers: { 'User-Agent': UA },
            subtitles: [],
            audioLanguage,
            language: languageLabel,
            sourceType: 'mp4',
            server: `${serverLabel} (proxy)`,
            providerName: PROVIDER_NAME,
          });
        }

        serverIndex++;
        if (results.length >= 6) break;
      }

      return results;
    } catch {
      return [];
    }
  },

  getLanguages: async () => [
    { language: 'es-419', label: 'Latino (Doblado)', type: 'audio' },
    { language: 'ja', label: 'Subtitulado', type: 'audio' },
  ],
};

export default provider;
