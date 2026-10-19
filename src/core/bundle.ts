/**
 * Latino Bundle Class
 * Main entry point for the Latino extension runtime.
 * Mirrors TokoBundleClass but only carries stream + manga pools — this
 * extension ships no torrent or novel providers.
 */

import { detectSourceType } from '../utils/scraping/quality.js';
import { withProviderTimeout } from '../utils/common/timeout.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../utils/manga/manga-title-resolver.js';
import { enrichSourceTitles } from '../utils/scraping/anilist-titles.js';
import { setCloudflareBrowserRuntime } from '../utils/common/cf-bypass.js';
import { runProviders, runProvidersProgressive, resolveProviderRunOptions } from './provider-runner.js';
import { annotateResults, mergeMangaChapters } from './result-processor.js';

import {
  STREAM_PROVIDERS,
  MANGA_PROVIDERS,
  LEAD_STREAM_PROVIDERS,
  providerPriorityOf,
} from '../providers/registry.js';

import type {
  SourceOptions,
  SourceResult,
  LanguageCapability,
  MangaChapterEntry,
  MangaChapterParams,
  MangaPageEntry,
  PreviewResult,
  WebsiteIndexResult,
  ProviderDiagnostic,
  ProviderChunk,
  DebugProviderResult,
} from '../types/index.js';

// Worker sandbox globals injected by extension-worker-pool.cjs
declare const TATAKAI_API_BASE_URL: string | undefined;

class ChapterNotFoundError extends Error {
  constructor(chapterKey: string) {
    super(`Chapter not found: ${chapterKey}`);
    this.name = 'ChapterNotFoundError';
  }
}

/**
 * Stamp each result with the registry rank of the provider that produced it.
 * `result.source` is the provider's own name; `providerName` is only set by
 * providers that expose several servers, so prefer the former and fall back.
 */
function stampPriority(results: SourceResult[], providerName: string): SourceResult[] {
  const fallback = providerPriorityOf(providerName);
  return results.map(result => ({
    ...result,
    providerPriority: result.source
      ? providerPriorityOf(result.source)
      : fallback,
  }));
}

/**
 * Main Latino Bundle Class
 * Orchestrates provider execution and result aggregation
 */
export class LatinoBundleClass {
  configureBrowserRuntime(runtime: Parameters<typeof setCloudflareBrowserRuntime>[0]): void {
    setCloudflareBrowserRuntime(runtime);
  }

  validate(): { valid: boolean; reason?: string } {
    const totalProviders = STREAM_PROVIDERS.length + MANGA_PROVIDERS.length;
    if (totalProviders === 0) {
      return { valid: false, reason: 'No providers initialised' };
    }
    return { valid: true };
  }

  // ── Single Episode Sources ──────────────────────────────────────────────

  async single(rawOpts: SourceOptions): Promise<SourceResult[]> {
    const opts = await enrichSourceTitles(rawOpts);
    const results = await runProviders(
      STREAM_PROVIDERS,
      async p => stampPriority(await p.single(opts), p.name),
      undefined,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return annotateResults(results);
  }

  async debugSingle(rawOpts: SourceOptions): Promise<DebugProviderResult<SourceResult>> {
    const opts = await enrichSourceTitles(rawOpts);
    const diagnostics: ProviderDiagnostic[] = [];
    const results = await runProviders(
      STREAM_PROVIDERS,
      async p => stampPriority(await p.single(opts), p.name),
      diagnostics,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return { results: annotateResults(results), diagnostics };
  }

  async streamAll(
    rawOpts: SourceOptions,
    onChunk: (chunk: ProviderChunk<SourceResult>) => void
  ): Promise<SourceResult[]> {
    const opts = await enrichSourceTitles(rawOpts);
    const options = resolveProviderRunOptions(opts.providerOptions);
    return runProvidersProgressive(
      STREAM_PROVIDERS,
      async p => stampPriority(annotateResults(await p.single(opts)), p.name),
      onChunk,
      options,
      { lead: LEAD_STREAM_PROVIDERS, priorityOf: providerPriorityOf }
    );
  }

  /**
   * `route=sources` entry point the extension host's /sources handler calls.
   * Same pool as streamAll — this extension ships no torrent pool — but the
   * method must exist: without it the host falls back to `batch()`, which is
   * also absent, so every /sources request answered with a synthetic
   * "fallback" diagnostic and zero sources.
   */
  async sourcesAll(
    opts: SourceOptions,
    onChunk: (chunk: ProviderChunk<SourceResult>) => void
  ): Promise<SourceResult[]> {
    return this.streamAll(opts, onChunk);
  }

  /** Non-progressive aggregate — alias of single() (no torrent pool). */
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    return this.single(opts);
  }

  /** Movies (no episode constraint) — same pool as `single`. */
  async movie(rawOpts: SourceOptions): Promise<SourceResult[]> {
    const opts = await enrichSourceTitles(rawOpts);
    const results = await runProviders(
      STREAM_PROVIDERS,
      p => (p.movie ? p.movie(opts) : p.single(opts)),
      undefined,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return annotateResults(results);
  }

  // ── Per-provider introspection & execution ──────────────────────────────

  listProviders(): Array<{ name: string; kind: 'stream' | 'manga'; priority: number }> {
    return [
      ...STREAM_PROVIDERS.map(p => ({ name: p.name, kind: 'stream' as const, priority: providerPriorityOf(p.name) })),
      ...MANGA_PROVIDERS.map((p, i) => ({ name: p.name, kind: 'manga' as const, priority: i })),
    ];
  }

  async runProvider(
    providerName: string,
    rawOpts: SourceOptions
  ): Promise<ProviderChunk<SourceResult> & { kind: 'stream' }> {
    const opts = await enrichSourceTitles(rawOpts);
    const wanted = String(providerName || '').trim().toLowerCase();
    if (!wanted) throw new Error('provider name is required');

    const provider = STREAM_PROVIDERS.find(p => p.name.toLowerCase() === wanted);
    if (!provider) throw new Error(`unknown provider: ${providerName}`);

    const options = resolveProviderRunOptions(opts.providerOptions);
    let chunk: ProviderChunk<SourceResult> | undefined;
    const capture = (c: ProviderChunk<SourceResult>) => { chunk = c; };

    await runProvidersProgressive(
      [provider],
      async p => stampPriority(annotateResults(await p.single(opts)), p.name),
      capture,
      options,
      { priorityOf: providerPriorityOf }
    );

    return {
      provider: provider.name,
      kind: 'stream',
      results: chunk?.results ?? [],
      diagnostic: chunk?.diagnostic ?? {
        provider: provider.name,
        status: 'empty',
        durationMs: 0,
        resultCount: 0,
        attempts: 0,
      },
    };
  }

  // ── Language Capabilities ───────────────────────────────────────────────

  async getLanguages(rawOpts: SourceOptions): Promise<LanguageCapability[]> {
    const opts = await enrichSourceTitles(rawOpts);
    return runProviders(
      STREAM_PROVIDERS,
      p => (p.getLanguages ? p.getLanguages(opts) : Promise.resolve([])),
      undefined,
      resolveProviderRunOptions(opts.providerOptions)
    );
  }

  // ── Manga Support ───────────────────────────────────────────────────────

  /** Resolve AniList titles once up front so the fan-out shares one round trip. */
  private async enrichMangaParams(params: MangaChapterParams): Promise<MangaChapterParams> {
    if (params.titles && params.titles.length > 0) return params;
    try {
      const titles = await resolveMangaTitles(params);
      return titles.length > 0 ? { ...params, titles } : params;
    } catch {
      return params;
    }
  }

  async getMangaChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    const enriched = await this.enrichMangaParams(params);
    const all = await runProviders(
      MANGA_PROVIDERS,
      p => p.getChapters(enriched)
    ) as MangaChapterEntry[];
    return mergeMangaChapters(all);
  }

  async debugMangaChapters(
    params: MangaChapterParams
  ): Promise<DebugProviderResult<MangaChapterEntry>> {
    const enriched = await this.enrichMangaParams(params);
    const diagnostics: ProviderDiagnostic[] = [];
    const all = await runProviders(
      MANGA_PROVIDERS,
      p => p.getChapters(enriched),
      diagnostics
    ) as MangaChapterEntry[];
    return { results: mergeMangaChapters(all), diagnostics };
  }

  /** Pages for one chapter; parses chapterKey as "<provider>:<providerChapterId>". */
  async getMangaPages(params: {
    chapterKey: string;
    provider?: string;
    providerChapterId?: string;
    anilistId?: number;
  }): Promise<MangaPageEntry[]> {
    const { chapterKey } = params;

    let providerName = params.provider;
    if (!providerName) {
      const colonIdx = chapterKey.indexOf(':');
      providerName = colonIdx >= 0 ? chapterKey.slice(0, colonIdx) : chapterKey;
    }

    const provider = MANGA_PROVIDERS.find(p => p.name === providerName);
    if (!provider) throw new ChapterNotFoundError(chapterKey);

    const pages = await provider.getPages(chapterKey);
    if (pages.length === 0) throw new ChapterNotFoundError(chapterKey);

    return pages;
  }

  // ── Preview & Indexing ──────────────────────────────────────────────────

  async getPreviewSource(params: {
    anilistId: number;
    titles: string[];
    episode?: number;
  }): Promise<PreviewResult> {
    const NULL_RESULT: PreviewResult = {
      provider: null,
      streamUrl: null,
      isHls: false,
      previewTimestampSec: 0,
    };

    try {
      const opts = await enrichSourceTitles({
        anilistId: params.anilistId,
        titles: params.titles,
        episode: params.episode,
        resolution: '1080p',
      });

      const results = await runProviders(
        STREAM_PROVIDERS,
        p => p.single(opts)
      ) as SourceResult[];

      const first = results.find(r => r.url && r.sourceType !== 'torrent');
      if (!first) return NULL_RESULT;

      return {
        provider: first.source,
        streamUrl: first.url,
        isHls: detectSourceType(first.url) === 'hls',
        previewTimestampSec: 0,
      };
    } catch {
      return NULL_RESULT;
    }
  }

  async getWebsiteEpisodeIndex(params: {
    anilistId: number;
    tatakaiId?: string;
    titles: string[];
  }): Promise<WebsiteIndexResult> {
    const NULL_RESULT: WebsiteIndexResult = {
      provider: null,
      episodeCount: 0,
      episodes: [],
    };

    try {
      if (typeof TATAKAI_API_BASE_URL !== 'undefined' && TATAKAI_API_BASE_URL) {
        const url = new URL('/latino/index/episodes', TATAKAI_API_BASE_URL);
        url.searchParams.set('anilistId', String(params.anilistId));
        if (params.tatakaiId) url.searchParams.set('tatakaiId', params.tatakaiId);
        params.titles.forEach(t => url.searchParams.append('titles[]', t));

        try {
          const res = await fetch(url.toString());
          if (res.ok) {
            const data = await res.json() as WebsiteIndexResult;
            if (data.provider && data.episodeCount > 0) return data;
          }
        } catch {
          // fall through to direct provider probe
        }
      }

      const opts = await enrichSourceTitles({
        anilistId: params.anilistId,
        titles: params.titles,
        episode: 1,
        resolution: '1080p',
      });

      for (const p of STREAM_PROVIDERS.slice(0, 3)) {
        try {
          const results = await withProviderTimeout(p.single(opts), 15_000);
          if (results.length > 0) {
            return {
              provider: p.name,
              episodeCount: 1,
              episodes: [{ number: 1 }],
            };
          }
        } catch {
          continue;
        }
      }

      return NULL_RESULT;
    } catch {
      return NULL_RESULT;
    }
  }
}
