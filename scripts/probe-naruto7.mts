import azanimex from '../src/providers/stream/azanimex.js';
import shademangaAnime from '../src/providers/stream/shademanga-anime.js';

async function main() {
  for (const [name, provider, args] of [
    ['shademanga-anime', shademangaAnime, { anilistId: 20, titles: ['Naruto'], episode: 1 }],
    ['shademanga-anime S2', shademangaAnime, { anilistId: 1735, titles: ['Naruto Shippuden'], episode: 5 }],
    ['azanimex', azanimex, { anilistId: 20, titles: ['Naruto'], episode: 1 }],
  ] as const) {
    console.log(`\n== ${name}: ${JSON.stringify(args)} ==`);
    const t0 = Date.now();
    const r = await (provider as any).single(args);
    console.log(`results: ${r.length} in ${Date.now() - t0} ms`);
    for (const x of r.slice(0, 6)) console.log(` - ${x.server} | ${x.audioLanguage} | ${String(x.url).slice(0, 95)}`);
  }
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
