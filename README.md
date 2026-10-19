# Latino — Spanish/Latino Tatakai Extension

Standalone Tatakai extension (`tatakai.extension.latino`, sideload as `dist/latino.kai`)
covering Spanish/Latino anime streaming and manga reading.

## Stream providers (priority order)

| Provider | Source | Notes |
| --- | --- | --- |
| `azanimex` | az-animex.com + `mirrored.to` mirror chain | Spanish hardsub (fansub burn-in). Full chain: WP search → multilinks → per-episode file links → mirstats host table → getlink → host resolvers (StreamTape & friends) → direct mp4, plus custom-embed fallback. |
| `shademanga-anime` | shademanga.com public anime API | SUB/DUB embeds per server (`Mp4upload`, `YourUpload`) → `/api/anime/resolve` → direct MP4 + site CDN proxy. Episode numbers are the listing's own counter (one AniList title per listing), so `episode` passes straight through. |
| `pelisforte` | www2.pelisforte.se (`mp4.nu` player) | AniList→ani.zip stagione/episodio (S/E) + localized `es` titles. Episode page audio tabs (Español Latino / Castellano / Subtitulado) → `mp4.nu` packed JWPlayer → m3u8/mp4 + captions, plus embed fallback. |
| `sololatino` | sololatino.net | Best-effort (site is Cloudflare-gated from datacenter egress; uses the shared browser bypass). `/serie/{slug}/temporada-N/episodio-N` pages → generic embed harvest → direct + embed fallback. |

## Manga providers

| Provider | Source | Notes |
| --- | --- | --- |
| `yupmanga` | yupmanga.com | Search via `busqueda-avanzada`, chapters via `ajax/load_chapters.php`, pages via `image-proxy-v2.php?chapter={code}&page=N` (requires site Referer; proxy registry handles hot-linking). |
| `shademanga` | shademanga.com public API | `api/series-locales/search-candidates` → `/{id}/capitulos` → `/capitulo/{id}/paginas` (CDN webp, no Referer). |

## Mapping

AniList-keyed lookups are converted through the shared `api.ani.zip` mapping:
TMDB/TVDB season + episode for the TV-style sites, and localized (`es`) titles
for searching Spanish-language sites.

## Build

```
npm install
npm run build   # → dist/latino.kai
```

## App integration (generic — no app edits)

The desktop app discovers extensions automatically: the extension host mounts
every installed `.kai` under its manifest's `apiServer.namespace` (here
`latino`), and the Watch page subscribes to whichever namespaces report
`sources`/`stream` routes. Nothing in the app lists extension names, so any
future extension works the same way. An extension needs exactly:

| Requirement | Where | Notes |
| --- | --- | --- |
| Unique `apiServer.namespace` + `sources`/`stream` routes | `manifest.json` | Discovery + in-app health both key off this. |
| `sourcesAll(opts, onChunk)` and `batch(opts)` on the bundle class | `src/core/bundle.ts` | The host's `/sources` route calls `sourcesAll` and falls back to `batch` — without them every request answers with a synthetic `fallback` diagnostic and zero sources. (This bit us first.) |
| Providers search from `opts.titles` and emit standard chunk diagnostics | `src/providers/*` | Substr/LIKE-style site searches should try a subtitle-free base title (`Mushoku Tensei: Jobless Reincarnation` → `Mushoku Tensei`). |
| Bundle-level AniList title enrichment | `src/utils/scraping/anilist-titles.ts` | The in-app host forwards only what the Watch page sends (one English title + id), so the bundle itself resolves AniList canonical titles/synonyms and merges them first. The standalone API used to do this at the API layer; the bundle now does it itself, so both paths behave identically. |

Install/upgrade inside the app (or copy `dist/bundle.js` into
`%APPDATA%\Tatakai\extensions\<id>\`) and restart — the registry reads the
bundle from disk at resolve time.

## Test API (same shape as toko)

`api/` runs the same bundle as an HTTP server so everything is testable from a
browser (Express + SSE, namespace `latino` instead of `toko`):

```
npm run start    # from api/  (or: node api/src/start.js) — port 8098
```

Endpoints (add `?stream=0` for plain JSON instead of SSE):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v3/health` | bundle load state + mounted namespace/route list |
| `GET /api/v3/latino/sources` | what the app calls: all providers, progressive SSE (`?anilistId=20&episode=1&titles[]=Naruto`) |
| `GET /api/v3/latino/stream` | all stream providers progressively (same params) |
| `GET /api/v3/latino/stream/:provider` | one provider only (`azanimex`, `shademanga-anime`, …) |
| `GET /download/:anilistId/:episode` | download-ready mp4/hls sources (`&type=mp4&lang=es-419`) |
| `GET /api/v3/latino/debug` | per-provider diagnostics |
| `GET /api/v3/latino/languages` | language capabilities |
| `GET /api/v3/latino/providers` | provider names + priorities |
| `GET /api/v3/latino/index/episodes` | listing probe (`getWebsiteEpisodeIndex`) |
| `GET /api/v3/latino/manga/chapters` | merged chapters (`<titles[]='Dandadan'>`) |
| `GET /api/v3/latino/manga/pages` | pages for `<chapterKey>` (`shademanga:TdsIdk`) |
| `POST /api/v3/latino/reload` | hot-reload `dist/bundle.js` after a rebuild (clears cache) |

Cache: in-memory LRU (10 min streams, 30 min manga). `DELETE /api/v3/latino/cache`
clears it.
