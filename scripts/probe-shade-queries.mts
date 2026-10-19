import { enrichSourceTitles } from '../src/utils/scraping/anilist-titles.js';
import { fetchJson } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const opts = await enrichSourceTitles({
  anilistId: 108465,
  titles: ['Mushoku Tensei: Jobless Reincarnation'],
  episode: 1,
} as any);
console.log('enriched titles:', JSON.stringify(opts.titles, null, 2));

for (const t of opts.titles.slice(0, 5)) {
  const q = encodeURIComponent(t.slice(0, 60));
  let rows: any = null;
  try {
    const data = await fetchJson<any>(`https://www.shademanga.com/api/anime?q=${q}&page=1&pageSize=20`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeoutMs: 15000,
    });
    rows = data?.items ?? data;
  } catch (e: any) {
    rows = `ERR ${e?.message}`;
  }
  const list = Array.isArray(rows) ? rows : null;
  console.log(`\nq="${t}" → ${list ? list.length + ' rows' : rows}`);
  if (list) for (const r of list.slice(0, 5)) console.log(`   ${r.token} | ${r.titulo}`);
}
