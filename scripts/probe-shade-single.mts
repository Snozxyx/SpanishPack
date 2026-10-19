import provider from '../src/providers/stream/shademanga-anime.js';
import { enrichSourceTitles } from '../src/utils/scraping/anilist-titles.js';

const opts = await enrichSourceTitles({
  anilistId: 108465,
  titles: ['Mushoku Tensei: Jobless Reincarnation'],
  episode: 1,
  resolution: '1080p',
} as any);
console.log('titles:', opts.titles.slice(0, 4));

// findToken isn't exported — drive it through single() and time it.
const t0 = Date.now();
const res = await provider.single(opts as any);
console.log(`single() → ${res.length} results in ${Date.now() - t0}ms`);
for (const s of res) console.log(`   ${s.sourceType} ${String(s.url).slice(0, 80)} ${s.language}`);
