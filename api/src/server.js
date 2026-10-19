/**
 * Latino in API form — Unified Streaming + Manga API
 *
 * Endpoints (all mirror /api/v3/toko/* contractually so browser tests in the
 * Tatakai repo work with only the path fragment swapped):
 *   GET /api/v3/health                        — Health check
 *   GET /api/v3/latino/stream                 — Stream sources only (SSE or JSON)
 *   GET /api/v3/latino/sources                — Alias of /stream (no torrent pool here)
 *   GET /download/:anilistId/:episode         — Download-ready media sources
 *   GET /api/v3/latino/debug                  — Raw diagnostics per provider
 *   GET /api/v3/latino/languages              — Language capabilities
 *   GET /api/v3/latino/providers              — Provider list
 *   GET /api/v3/latino/stream/:provider       — One provider only
 *   GET /api/v3/latino/index/episodes         — Episode index
 *   GET /api/v3/latino/manga/chapters         — Manga chapters (all providers, merged)
 *   GET /api/v3/latino/manga/pages            — Pages for one chapter (by chapterKey)
 *   GET /api/v3/latino/index/chapters         — Chapter index (alias of manga/chapters)
 *
 * Add ?stream=0 to any endpoint to get a plain JSON response instead of SSE.
 *
 * Cache: in-memory LRU, 10-min TTL for streams, 30-min for manga.
 */
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT || process.env.LATINO_API_PORT || 8098);
const HOST = process.env.LATINO_API_HOST || '0.0.0.0';

// ── Bundle loading ────────────────────────────────────────────────────────────

const LATINO_BUNDLE_SRC = [
  path.resolve(__dirname, '../dist/bundle.js'),
  path.resolve(__dirname, '../../dist/bundle.js'),
].find(existsSync) || path.resolve(__dirname, '../dist/bundle.js');
const LATINO_BUNDLE_DIR = path.join(os.tmpdir(), 'latino-api-bundle');

let _bundleLoadCount = 0;

function loadBundle() {
  if (!existsSync(LATINO_BUNDLE_SRC)) {
    throw new Error(
      `Latino bundle not found at ${LATINO_BUNDLE_SRC}. Run: npm run build (in tatakai-latino)`,
    );
  }
  mkdirSync(LATINO_BUNDLE_DIR, { recursive: true });

  // Write to a unique path each load so Node's require cache never blocks us
  _bundleLoadCount++;
  const LATINO_BUNDLE = path.join(LATINO_BUNDLE_DIR, `bundle-${_bundleLoadCount}.cjs`);
  copyFileSync(LATINO_BUNDLE_SRC, LATINO_BUNDLE);

  const mod = require(LATINO_BUNDLE);
  const Bundle = mod.default || mod.LatinoBundleClass || mod;
  const instance = typeof Bundle === 'function' ? new Bundle() : Bundle;
  if (!instance || typeof instance.single !== 'function') {
    throw new Error('Latino bundle does not expose single()');
  }
  return instance;
}

let latino = null;
function getLatino() {
  if (!latino) {
    try {
      latino = loadBundle();
      console.log(`[latino-api] bundle loaded (${latino.constructor?.name || 'latino'})`);
    } catch (err) {
      console.error('[latino-api] failed to load bundle:', err.message);
    }
  }
  return latino;
}

// ── In-Memory Cache ───────────────────────────────────────────────────────────

const STREAM_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MANGA_TTL_MS = 30 * 60 * 1000; // 30 minutes (chapter lists change rarely)
const MAX_CACHE_SIZE = 200;

const cache = new Map(); // key → { data, expiresAt }

function cacheKey(type, opts) {
  const providerOptions = opts.providerOptions || {};
  return [
    type,
    opts.anilistId,
    opts.episode,
    opts.resolution,
    (opts.providerOptions || {}).maxConcurrency ?? '',
    providerOptions.maxRetries ?? '',
    providerOptions.timeoutMs ?? '',
  ].join(':');
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttl) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ── AniList title pre-fetch ───────────────────────────────────────────────────

const anilistTitleCache = new Map(); // anilistId → { titles, expiresAt }
const ANILIST_TITLE_TTL = 60 * 60 * 1000; // 1 hour

// Must stay identical to `usefulSynonyms` in
// desktop/runtime/extension-api-host/host-server.cjs — when these two diverge,
// this endpoint and the in-app host return different results for the same show,
// which is indistinguishable from the app dropping sources.
const LATIN_TITLE_RE = /^[\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\p{S}]+$/u;

function isAbbreviation(s) {
  if (/\s/.test(s)) return false;
  if (s.length <= 4) return true;
  return s.length <= 6 && s === s.toUpperCase() && /[A-Z]/.test(s);
}

function usefulSynonyms(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && LATIN_TITLE_RE.test(s) && !isAbbreviation(s))
    .slice(0, 2);
}

async function fetchAniListTitles(anilistId) {
  if (!anilistId || anilistId <= 0) return [];

  const cached = anilistTitleCache.get(anilistId);
  if (cached && Date.now() < cached.expiresAt) return cached.titles;

  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: `query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji userPreferred native } synonyms } }`,
        variables: { id: anilistId },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const payload = await res.json();
    const media = payload?.data?.Media;
    const t = media?.title;
    // Canonical titles first — synonyms go last.
    const titles = [t?.english, t?.romaji, t?.userPreferred, t?.native, ...usefulSynonyms(media?.synonyms)]
      .filter(Boolean)
      .map((v) => String(v).trim())
      .filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);

    anilistTitleCache.set(anilistId, { titles, expiresAt: Date.now() + ANILIST_TITLE_TTL });
    return titles;
  } catch {
    return [];
  }
}

// ── Language helpers ──────────────────────────────────────────────────────────

const LANG_LABEL_MAP = {
  ja: 'Japanese', en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', it: 'Italian', ko: 'Korean', und: 'Unknown',
};

const LANG_FLAG_MAP = {
  ja: '🇯🇵', en: '🇬🇧', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪',
  pt: '🇵🇹', it: '🇮🇹', ko: '🇰🇷', und: '🌐',
};

/**
 * Provider-level default language inference when no audioLanguage is set.
 * Every Latino provider deals in Spanish-language content; hardsub fansubs
 * (azanimex) are Spanish audio with burned subtitles.
 */
const PROVIDER_DEFAULT_LANG = {
  azanimex:          { code: 'es',     name: 'Spanish (fansub hardsub)', isDub: false },
  pelisforte:        { code: 'es-419', name: 'Español Latino',           isDub: true },
  'sololatino-spa':  { code: 'es-419', name: 'Latino',                   isDub: true },
  'shademangaanime': { code: 'es-419', name: 'Latino (Doblado)',         isDub: false },
};

function providerKeyOf(source) {
  return (source.providerName || source.source || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function inferLanguage(source) {
  const known = PROVIDER_DEFAULT_LANG[providerKeyOf(source)];
  if (known) return known;

  const langLabel = String(source.language || '').toLowerCase();
  if (/latino/.test(langLabel))     return { code: 'es-419', name: 'Español Latino', isDub: true };
  if (/castellano/.test(langLabel)) return { code: 'es',     name: 'Castellano',     isDub: true };
  if (/doblado|dub/.test(langLabel)) return { code: 'es-419', name: 'Latino (Doblado)', isDub: true };
  if (/sub/.test(langLabel))        return { code: 'ja',     name: 'Japanese',       isDub: false };

  return { code: 'es-419', name: 'Español Latino', isDub: true };
}

const isHls = (url) => /\.m3u8($|[?#/])/i.test(String(url || ''));

function resolveSourceType(s) {
  if (s.sourceType === 'hls' || (!s.sourceType && isHls(s.url))) return 'hls';
  if (s.sourceType === 'mp4' || (!s.sourceType && /\.(mp4|m4v|webm|mkv)($|[?#])/i.test(s.url || ''))) return 'mp4';
  if (s.sourceType === 'custom') return 'embed';
  return 'embed';
}

function hasUsableUrl(source) {
  return source && typeof source.url === 'string' && source.url.trim().length > 0;
}

/** Full normalization of a raw SourceResult from a provider */
function normalizeSource(s) {
  const type = resolveSourceType(s);

  // Resolve language
  let langCode = s.audioLanguage;
  let langName = s.language;
  let isDub = false;

  const SUBBED_RE = /hardsub|fansub|softsub|subt[íi]tul|subtitl|subbed/i;
  if (!langCode || langCode === 'und') {
    const inferred = inferLanguage(s);
    langCode = inferred.code;
    langName = langName || inferred.name;
    isDub = inferred.isDub;
  } else {
    langName = langName || LANG_LABEL_MAP[langCode] || langCode.toUpperCase();
    // Dubs are voiced casts (Latino/Castellano); anything explicitly subbed is not.
    isDub = langCode !== 'ja' && langCode !== 'und' && !SUBBED_RE.test(String(langName));
  }

  const flag =
    langCode === 'es-419' ? '🇲🇽' : LANG_FLAG_MAP[langCode] || '🌐';
  const cleanLangName = (langName || '').replace(/\s+dub$/i, '').trim();
  const isDubLabel = isDub ? ' Dub' : '';
  const languageLabel = `${flag} ${cleanLangName}${isDubLabel}`.replace(/\s+/g, ' ').trim();

  const providerName = s.providerName || s.source || 'latino';
  const providerKey = String(providerName).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const server = s.server || s.source || providerKey;

  return {
    ...s,
    url: String(s.url || '').trim(),
    providerName,
    providerKey,
    server,
    audioLanguage: langCode,
    language: langName,
    languageLabel,
    isDub,
    type,
    isM3U8: type === 'hls',
    isEmbed: type === 'embed',
    isTorrent: false,
  };
}

function categorize(sources) {
  const byLanguage = {};
  const byType = {};

  for (const s of sources) {
    const langKey = s.audioLanguage || 'und';
    (byLanguage[langKey] ||= {
      code: langKey,
      label: s.language || LANG_LABEL_MAP[langKey] || langKey,
      flag: langKey === 'es-419' ? '🇲🇽' : LANG_FLAG_MAP[langKey] || '🌐',
      isDub: s.isDub,
      sources: [],
    }).sources.push(s);

    const typeKey = s.type || 'embed';
    (byType[typeKey] ||= []).push(s);
  }

  return { byLanguage, byType };
}

// ── Request option parsing ────────────────────────────────────────────────────

function parseTitles(query) {
  const raw = query['titles[]'] || query.titles;
  if (!raw) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

async function optionsFromReq(req, overrides = {}) {
  const anilistId = Number(overrides.anilistId ?? req.query.anilistId);
  const safeAnilistId = Number.isFinite(anilistId) && anilistId > 0 ? anilistId : 0;

  // Merge caller-provided titles with AniList-fetched canonical titles
  const callerTitles = parseTitles(req.query).filter(Boolean);
  const anilistTitles = await fetchAniListTitles(safeAnilistId);

  // Deduplicate: AniList titles first (most canonical), then caller titles
  const seen = new Set(anilistTitles.map((t) => t.toLowerCase()));
  const extraTitles = callerTitles.filter((t) => t && !seen.has(t.toLowerCase()));
  const titles = [...anilistTitles, ...extraTitles];

  const providerOptions = { maxConcurrency: 2, timeoutMs: 15_000 };
  for (const key of ['maxConcurrency', 'maxRetries', 'retryDelayMs', 'timeoutMs']) {
    const raw = req.query[key];
    if (raw == null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) providerOptions[key] = value;
  }

  return {
    anilistId: safeAnilistId,
    titles,
    episode:
      overrides.episode != null
        ? Number(overrides.episode)
        : req.query.episode
          ? Number(req.query.episode)
          : 1,
    resolution: String(req.query.resolution || '1080p'),
    preferredLanguage: req.query.preferredLanguage ? String(req.query.preferredLanguage) : undefined,
    preferredLanguages: req.query.preferredLanguages
      ? String(req.query.preferredLanguages).split(',')
      : undefined,
    ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
  };
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function buildFinalResponse(allSources, providerStatus, cached) {
  const normalized = allSources.filter(hasUsableUrl).map(normalizeSource);
  const { byLanguage, byType } = categorize(normalized);
  return {
    sources: normalized,
    byLanguage,
    byType,
    providerStatus,
    count: normalized.length,
    cached,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Download endpoint helpers ────────────────────────────────────────────────

const DOWNLOAD_TYPES = new Set(['all', 'stream', 'hls', 'm3u8', 'mp4']);

function normalizedQueryValue(value) {
  return String(value || '').trim().toLowerCase();
}

function splitQueryValues(value) {
  return String(value || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function languageMatches(source, requestedLanguages) {
  if (requestedLanguages.length === 0) return true;

  const values = [
    source.audioLanguage,
    source.language,
    ...(Array.isArray(source.subtitles)
      ? source.subtitles.flatMap((track) => [track.language, track.label])
      : []),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return requestedLanguages.some((requested) =>
    values.some(
      (value) => value === requested || value.startsWith(`${requested}-`) || value.includes(requested),
    ),
  );
}

function downloadTypeMatches(source, requestedType) {
  if (requestedType === 'all' || requestedType === 'stream') return source.type === 'hls' || source.type === 'mp4';
  if (requestedType === 'hls' || requestedType === 'm3u8') return source.type === 'hls';
  if (requestedType === 'mp4') return source.type === 'mp4';
  return false;
}

function normalizeDownloadSource(source) {
  const subtitles = Array.isArray(source.subtitles)
    ? source.subtitles
        .filter((track) => track && track.url)
        .map((track) => ({
          url: String(track.url),
          label: String(track.label || track.language || 'Unknown'),
          language: String(track.language || 'und'),
          default: Boolean(track.default),
        }))
    : [];

  return {
    url: source.url,
    source: source.source,
    providerName: source.providerName,
    providerKey: source.providerKey,
    server: source.server,
    type: source.type,
    quality: source.quality,
    headers: source.headers || {},
    audioLanguage: source.audioLanguage || 'und',
    language: source.language || LANG_LABEL_MAP[source.audioLanguage] || 'Unknown',
    languageLabel: source.languageLabel,
    isDub: Boolean(source.isDub),
    subtitles,
  };
}

function collectSubtitles(sources) {
  const seen = new Set();
  const subtitles = [];

  for (const source of sources) {
    for (const subtitle of source.subtitles || []) {
      const key = `${subtitle.url}\u0000${subtitle.language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subtitles.push({
        ...subtitle,
        providerName: source.providerName,
        source: source.source,
      });
    }
  }

  return subtitles;
}

function buildDownloadResponse(sources, opts, requestedLanguage, requestedType, cached) {
  const filtered = sources
    .filter((source) => downloadTypeMatches(source, requestedType))
    .filter((source) => languageMatches(source, requestedLanguage))
    .map(normalizeDownloadSource);

  const languages = [
    ...new Map(
      filtered.map((source) => [
        source.audioLanguage,
        {
          code: source.audioLanguage,
          label: source.language,
          isDub: source.isDub,
          providers: [source.providerName],
        },
      ]),
    ).values(),
  ].map((language) => ({
    ...language,
    providers: [...new Set(language.providers)],
  }));

  return {
    anilistId: opts.anilistId,
    episode: opts.episode,
    lang: requestedLanguage.length ? requestedLanguage : null,
    type: requestedType,
    count: filtered.length,
    cached,
    fetchedAt: new Date().toISOString(),
    languages,
    subtitles: collectSubtitles(filtered),
    sources: filtered,
  };
}

// ── Manga helpers ─────────────────────────────────────────────────────────────
//
// Manga runs over the same bundle as streams, but a different contract:
// `getMangaChapters` returns nested MangaChapterEntry[] and `getMangaPages`
// returns a bare MangaPageEntry[]. Flattened to one row per source so an HTTP
// caller and the in-app host see the same JSON.

/** Build MangaChapterParams from the request query. */
function mangaParamsFromReq(req) {
  const anilistId = Number(req.query.anilistId);
  const malId = Number(req.query.malId);
  const titles = parseTitles(req.query).filter(Boolean);
  return {
    ...(Number.isFinite(anilistId) && anilistId > 0 ? { anilistId } : {}),
    ...(Number.isFinite(malId) && malId > 0 ? { malId } : {}),
    ...(req.query.title ? { title: String(req.query.title) } : {}),
    ...(titles.length ? { titles } : {}),
  };
}

/** Flatten nested MangaChapterEntry[] to one row per source. */
function flattenMangaChapters(entries) {
  const rows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sources = Array.isArray(entry?.sources) ? entry.sources : [];
    for (const src of sources) {
      if (!src?.chapterKey) continue;
      rows.push({
        number: entry.number,
        title: entry.title ?? null,
        volume: entry.volume ?? null,
        provider: src.provider ?? null,
        chapterKey: src.chapterKey,
        providerChapterId: src.providerChapterId ?? src.chapterKey,
        language: src.language ?? null,
        scanlator: src.scanlator ?? null,
        releaseDate: src.releaseDate ?? null,
      });
    }
  }
  return rows;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/api/v3/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'latino-api',
    latino: !!getLatino(),
    cacheSize: cache.size,
    namespaces: [
      {
        namespace: 'latino',
        capabilities: ['manga'],
        routes: ['sources', 'stream', 'download', 'debug', 'languages', 'providers', 'manga/chapters', 'manga/pages', 'index/episodes', 'index/chapters'],
      },
    ],
  });
});

// ── Generic progressive handler ───────────────────────────────────────────────

async function handleSourceRequest(req, res, mode = 'stream') {
  const t = getLatino();
  const empty = {
    sources: [],
    byLanguage: {},
    byType: {},
    providerStatus: [],
    count: 0,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };

  if (!t) return res.json(empty);

  const opts = await optionsFromReq(req);
  const useSSE = req.query.stream !== '0';
  const key = cacheKey(mode, opts);

  // Cache hit?
  const hit = cacheGet(key);
  if (hit) {
    hit.cached = true;
    if (useSSE) {
      startSSE(res);
      for (const source of hit.sources) {
        sseEvent(res, 'source', normalizeSource(source));
      }
      sseEvent(res, 'done', { totalCount: hit.count, cached: true });
      return res.end();
    }
    return res.json(hit);
  }

  const allSources = [];
  const providerStatus = [];

  function onChunk(chunk) {
    providerStatus.push(chunk.diagnostic);
    for (const s of chunk.results) {
      if (!hasUsableUrl(s)) continue;
      allSources.push(s);
      if (useSSE) {
        sseEvent(res, 'source', normalizeSource(s));
      }
    }
    if (useSSE) {
      sseEvent(res, 'provider_status', chunk.diagnostic);
    }
  }

  if (useSSE) startSSE(res);

  try {
    if (typeof t.streamAll === 'function') {
      await t.streamAll(opts, onChunk);
    } else {
      const raw = await t.single(opts);
      for (const s of raw) allSources.push(s);
    }
  } catch (err) {
    console.error(`[latino/${mode}]`, err.message);
    if (useSSE) {
      sseEvent(res, 'error', { message: err.message });
      return res.end();
    }
    return res.status(502).json({ ...empty, error: err.message });
  }

  const result = buildFinalResponse(allSources, providerStatus, false);
  cacheSet(key, result, STREAM_TTL_MS);

  if (useSSE) {
    sseEvent(res, 'done', { totalCount: result.count, cached: false });
    return res.end();
  }

  return res.json(result);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/v3/latino/stream — stream sources only */
app.get('/api/v3/latino/stream', async (req, res) => {
  try { await handleSourceRequest(req, res, 'stream'); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

/** GET /api/v3/latino/sources — alias (single stream-only bundle) */
app.get('/api/v3/latino/sources', async (req, res) => {
  try { await handleSourceRequest(req, res, 'sources'); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

/**
 * GET /download/:anilistId/:episode — direct HLS/MP4 sources for one episode.
 * `lang` accepts a language code or name, comma-separated. `type` accepts
 * all, stream, hls/m3u8, mp4. Returns source links + headers rather than
 * proxying media bytes. SSE by default; `stream=0` for plain JSON.
 */
async function handleDownloadRequest(req, res) {
  const anilistId = Number(req.params.anilistId);
  const episode = Number(req.params.episode);

  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return res.status(400).json({ error: 'anilistId must be a positive integer' });
  }
  if (!Number.isFinite(episode) || episode <= 0) {
    return res.status(400).json({ error: 'episode must be a positive number' });
  }

  const requestedType = normalizedQueryValue(req.query.type) || 'all';
  if (!DOWNLOAD_TYPES.has(requestedType)) {
    return res.status(400).json({
      error: `type must be one of: ${[...DOWNLOAD_TYPES].join(', ')}`,
    });
  }

  const requestedLanguage = splitQueryValues(req.query.lang);
  const t = getLatino();
  if (!t) return res.status(503).json({ error: 'Latino bundle is unavailable' });
  const useSSE = req.query.stream !== '0';

  try {
    const opts = await optionsFromReq(req, { anilistId, episode });
    const key = cacheKey('download', opts);
    let result = cacheGet(key);
    let cached = true;

    if (result) {
      result.cached = true;
      const cachedResponse = buildDownloadResponse(result.sources, opts, requestedLanguage, requestedType, true);
      if (useSSE) {
        startSSE(res);
        for (const source of cachedResponse.sources) {
          sseEvent(res, 'source', source);
        }
        sseEvent(res, 'done', {
          totalCount: cachedResponse.count,
          cached: true,
          languages: cachedResponse.languages,
          subtitles: cachedResponse.subtitles,
        });
        return res.end();
      }
      return res.json(cachedResponse);
    }

    const allSources = [];
    const providerStatus = [];
    cached = false;
    if (useSSE) startSSE(res);

    const onChunk = (chunk) => {
      providerStatus.push(chunk.diagnostic);
      for (const source of chunk.results) {
        if (!hasUsableUrl(source)) continue;
        allSources.push(source);
        const normalized = normalizeSource(source);
        if (downloadTypeMatches(normalized, requestedType) && languageMatches(normalized, requestedLanguage) && useSSE) {
          sseEvent(res, 'source', normalizeDownloadSource(normalized));
        }
      }
      if (useSSE) sseEvent(res, 'provider_status', chunk.diagnostic);
    };

    try {
      if (typeof t.streamAll === 'function') {
        await t.streamAll(opts, onChunk);
      } else {
        const rawSources = await t.single(opts);
        onChunk({
          results: rawSources,
          diagnostic: { provider: 'latino', status: 'success', durationMs: 0, attempts: 1, resultCount: rawSources.length },
        });
      }
    } catch (err) {
      console.error('[latino/download]', err.message);
      if (useSSE) {
        sseEvent(res, 'error', { message: err.message });
        return res.end();
      }
      return res.status(502).json({ error: err.message });
    }

    result = buildFinalResponse(allSources, providerStatus, false);
    cacheSet(key, result, STREAM_TTL_MS);

    const response = buildDownloadResponse(result.sources, opts, requestedLanguage, requestedType, cached);
    if (useSSE) {
      sseEvent(res, 'done', {
        totalCount: response.count,
        cached: false,
        languages: response.languages,
        subtitles: response.subtitles,
      });
      return res.end();
    }

    return res.json(response);
  } catch (err) {
    console.error('[latino/download]', err.message);
    if (useSSE && !res.headersSent) startSSE(res);
    if (useSSE) {
      sseEvent(res, 'error', { message: err.message });
      return res.end();
    }
    return res.status(502).json({ error: err.message });
  }
}

app.get(['/download/:anilistId/:episode', '/api/v3/latino/download/:anilistId/:episode'], handleDownloadRequest);

/** GET /api/v3/latino/debug — raw diagnostics per provider */
app.get('/api/v3/latino/debug', async (req, res) => {
  const t = getLatino();
  if (!t) return res.json({ results: [], diagnostics: [] });
  try {
    const opts = await optionsFromReq(req);
    const result = typeof t.debugSingle === 'function'
      ? await t.debugSingle(opts)
      : { results: await t.single(opts), diagnostics: [] };
    res.json({
      ...result,
      results: result.results.map(normalizeSource),
    });
  } catch (err) {
    res.status(502).json({ results: [], diagnostics: [], error: err.message });
  }
});

/** GET /api/v3/latino/languages — language capabilities */
app.get('/api/v3/latino/languages', async (req, res) => {
  const t = getLatino();
  if (!t || typeof t.getLanguages !== 'function') return res.json({ languages: [] });
  try {
    const opts = await optionsFromReq(req);
    res.json({ languages: (await t.getLanguages(opts)) || [] });
  } catch (err) {
    res.status(502).json({ languages: [], error: err.message });
  }
});

/** GET /api/v3/latino/providers — provider list with priorities */
app.get('/api/v3/latino/providers', async (_req, res) => {
  const t = getLatino();
  if (!t || typeof t.listProviders !== 'function') return res.json({ providers: [] });
  try {
    res.json({ providers: await t.listProviders() });
  } catch (err) {
    res.status(502).json({ providers: [], error: err.message });
  }
});

/** GET /api/v3/latino/stream/:provider — single provider run */
app.get('/api/v3/latino/stream/:provider', async (req, res) => {
  const t = getLatino();
  if (!t || typeof t.runProvider !== 'function') {
    return res.status(501).json({ sources: [], providerStatus: [], error: 'runProvider unavailable in this bundle' });
  }
  try {
    const opts = await optionsFromReq(req);
    const chunk = await t.runProvider(String(req.params.provider), opts);
    return res.json({
      provider: chunk.provider,
      kind: chunk.kind,
      sources: (chunk.results || []).filter(hasUsableUrl).map(normalizeSource),
      diagnostic: chunk.diagnostic ?? null,
      count: (chunk.results || []).filter(hasUsableUrl).length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ sources: [], providerStatus: [], error: err.message });
  }
});

// Episode index — delegate to the bundle when available.
app.get('/api/v3/latino/index/episodes', async (req, res) => {
  const t = getLatino();
  const opts = await optionsFromReq(req);
  try {
    if (t && typeof t.getWebsiteEpisodeIndex === 'function') {
      const idx = await t.getWebsiteEpisodeIndex({ anilistId: opts.anilistId, titles: opts.titles });
      if (idx && idx.episodeCount > 0) return res.json(idx);
    }
  } catch { /* fall through */ }
  res.json({ provider: null, episodeCount: 0, episodes: [] });
});

/**
 * GET /api/v3/latino/manga/chapters — chapters from all manga providers, merged.
 *
 * Response: { provider, providers, chapterCount, chapters: [{ number, title,
 * volume, provider, chapterKey, providerChapterId, language, scanlator,
 * releaseDate }] }
 */
async function handleMangaChapters(req, res) {
  const t = getLatino();
  const empty = { provider: null, providers: [], chapterCount: 0, chapters: [] };
  if (!t || typeof t.getMangaChapters !== 'function') return res.json(empty);

  const params = mangaParamsFromReq(req);
  const key = `manga-chapters:${params.anilistId ?? ''}:${params.malId ?? ''}:${params.title ?? ''}:${(params.titles || []).join('|')}`;

  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    const entries = await t.getMangaChapters(params);
    const chapters = flattenMangaChapters(entries);
    const providers = [...new Set(chapters.map((c) => c.provider).filter(Boolean))];
    const result = {
      provider: providers[0] || null,
      providers,
      chapterCount: chapters.length,
      chapters,
      cached: false,
      fetchedAt: new Date().toISOString(),
    };
    if (chapters.length > 0) cacheSet(key, result, MANGA_TTL_MS);
    return res.json(result);
  } catch (err) {
    console.error('[latino/manga/chapters]', err.message);
    return res.status(502).json({ ...empty, error: err.message });
  }
}

/**
 * GET /api/v3/latino/manga/pages — pages for one chapter.
 *
 * Response: { pageCount, pages: [{ pageNumber, imageUrl, headers, width, height }] }
 * `headers` are the CDN replay headers (e.g. Referer for yupmanga).
 */
async function handleMangaPages(req, res) {
  const t = getLatino();
  const empty = { pageCount: 0, pages: [] };
  if (!t || typeof t.getMangaPages !== 'function') return res.json(empty);

  const chapterKey = String(req.query.chapterKey || '').trim();
  if (!chapterKey) return res.status(400).json({ ...empty, error: 'chapterKey is required' });

  const anilistId = Number(req.query.anilistId);
  const params = {
    chapterKey,
    ...(req.query.provider ? { provider: String(req.query.provider) } : {}),
    ...(req.query.providerChapterId ? { providerChapterId: String(req.query.providerChapterId) } : {}),
    ...(Number.isFinite(anilistId) && anilistId > 0 ? { anilistId } : {}),
  };
  const key = `manga-pages:${chapterKey}`;

  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    const rawPages = await t.getMangaPages(params);
    const pages = (Array.isArray(rawPages) ? rawPages : [])
      .map((p, idx) => {
        const imageUrl = String(p?.imageUrl || '');
        if (!imageUrl) return null;
        return {
          pageNumber: Number.isFinite(p.pageNumber) ? p.pageNumber : idx + 1,
          imageUrl,
          headers: p.headers && typeof p.headers === 'object' ? p.headers : {},
          width: p.width ?? null,
          height: p.height ?? null,
        };
      })
      .filter(Boolean);

    const result = { pageCount: pages.length, pages, cached: false, fetchedAt: new Date().toISOString() };
    if (pages.length > 0) cacheSet(key, result, MANGA_TTL_MS);
    return res.json(result);
  } catch (err) {
    console.error('[latino/manga/pages]', err.message);
    // getMangaPages throws ChapterNotFoundError when the provider yields nothing.
    const status = /not found/i.test(err.message) ? 404 : 502;
    return res.status(status).json({ ...empty, error: err.message });
  }
}

app.get('/api/v3/latino/manga/chapters', handleMangaChapters);
app.get('/api/v3/latino/manga/pages', handleMangaPages);

// Chapter index — alias of manga/chapters for parity with index/episodes.
app.get('/api/v3/latino/index/chapters', handleMangaChapters);

// Cache management
app.delete('/api/v3/latino/cache', (_req, res) => {
  const size = cache.size;
  cache.clear();
  anilistTitleCache.clear();
  res.json({ cleared: size });
});

app.get('/api/v3/latino/cache/stats', (_req, res) => {
  res.json({ size: cache.size, maxSize: MAX_CACHE_SIZE });
});

// Hot-reload the bundle without restarting the server
app.post('/api/v3/latino/reload', (_req, res) => {
  try {
    const prev = latino;
    latino = null; // force re-load
    cache.clear();
    anilistTitleCache.clear();
    const next = getLatino();
    if (!next) {
      latino = prev; // revert on failure
      return res.status(500).json({ ok: false, error: 'Bundle reload failed — check logs' });
    }
    console.log('[latino-api] bundle reloaded');
    return res.json({ ok: true, reloaded: true, cacheCleared: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.use('/api/v3', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, HOST, () => {
  console.log(`[latino-api] listening on http://${HOST}:${PORT}/api/v3`);
  console.log(`[latino-api] endpoints: /stream  /stream/:provider  /sources  /download/:anilistId/:episode  /debug  /languages  /providers  /manga/chapters  /manga/pages  /index/episodes  /health`);
  getLatino();
});

export { app };
