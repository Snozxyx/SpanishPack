/**
 * Simulates the in-app extension host path: bundle.streamAll with only the
 * app-supplied English title + anilistId (no API-layer title enrichment).
 */
import LatinoBundleClass from '../src/index.js';

const bundle = new LatinoBundleClass();

const chunks: any[] = [];
await bundle.streamAll(
  {
    anilistId: 108465,
    titles: ['Mushoku Tensei: Jobless Reincarnation'],
    episode: 1,
    resolution: '1080p',
    preferredLanguage: 'sub',
  } as any,
  (chunk) => {
    chunks.push(chunk);
    const d = (chunk as any).diagnostic;
    console.log(
      `[chunk] provider=${d?.provider} status=${d?.status} results=${chunk.results?.length ?? 0} ms=${d?.durationMs}`,
    );
    for (const s of chunk.results ?? []) {
      console.log(`   → ${s.sourceType} ${String(s.url).slice(0, 90)} lang=${s.language}`);
    }
  },
);
const total = chunks.reduce((n, c) => n + (c.results?.length ?? 0), 0);
console.log(`TOTAL sources: ${total}`);
