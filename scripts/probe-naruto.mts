import azanimex from '../src/providers/stream/azanimex.js';
import shademanga from '../src/providers/manga/shademanga.js';
import { fetchText, loadHtml } from '../src/utils/http/fetch.js';
import { resolveTmdbTarget } from '../src/utils/mapping/anizip.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

async function main() {
  // What does ani.zip give for Naruto (AniList 20) and Shippuden (1735)?
  for (const id of [20, 1735]) {
    try {
      const t = await resolveTmdbTarget({ anilistId: id, episode: 1, titles: ['Naruto'], language: 'es' });
      console.log(`anilist ${id} =>`, JSON.stringify({ type: t.type, season: (t as any).season, episode: (t as any).episode, titles: t.titles.slice(0, 3) }));
    } catch (e: any) {
      console.log(`anilist ${id} ERROR`, e?.message || e);
    }
  }

  console.log('\n== azanimex single: Naruto (AniList 20, ep 1) ==');
  const r1 = await azanimex.single({ anilistId: 20, titles: ['Naruto'], episode: 1, resolution: '1080p' } as any);
  console.log('results:', r1.length);
  for (const r of r1.slice(0, 3)) console.log(' -', r.server, r.sourceType, String(r.url).slice(0, 90));

  console.log('\n== azanimex raw search ?s=naruto ==');
  const html = await fetchText('https://az-animex.com/?s=naruto', { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000 });
  if (html) {
    const $ = loadHtml(html);
    const lis = $('li.wp-block-post');
    console.log('wp-block-post count:', lis.length);
    lis.each((i, el) => {
      if (i > 6) return;
      console.log(' ', ($(el).find('img').first().attr('alt') || '').slice(0, 70));
    });
  } else {
    console.log('search fetch failed');
  }

  console.log('\n== shademanga chapters: Naruto ==');
  const ch = await shademanga.getChapters({ titles: ['Naruto'] } as any);
  console.log('chapters:', ch.length, ch[0]?.sources?.[0]?.chapterKey);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
