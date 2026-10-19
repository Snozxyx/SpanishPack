import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const res = await fetchResponse('https://www2.pelisforte.se/wp-content/themes/torofilm/public/js/torofilm-public.js?ver=1787553595', {
  headers: { 'User-Agent': UA },
  timeoutMs: 15000,
  redirect: 'follow',
});
const js = await res.text();
console.log('len:', js.length, 'status:', res.status);

// find search / ajax bits
for (const kw of ['admin-ajax', 'search', 's_term', 'action', 'ajaxSearch', 'search_series', 'wp-json']) {
  const idxs: number[] = [];
  let p = js.indexOf(kw);
  while (p >= 0 && idxs.length < 4) { idxs.push(p); p = js.indexOf(kw, p + kw.length); }
  for (const i of idxs) console.log(`~${kw} @${i}:`, js.slice(Math.max(0, i - 180), i + 260).replace(/\s+/g, ' ').slice(0, 380));
}
