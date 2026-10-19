import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const BASE = 'https://www2.pelisforte.se';

const page = await fetchResponse(`${BASE}/`, { headers: { 'User-Agent': UA }, timeoutMs: 15000, redirect: 'follow' });
const html = await page.text();
const nonce = html.match(/"content_nonce":"([0-9a-f]+)"/)?.[1];

for (const term of ['calamar', 'el juego del calamar', 'mushoku', 'dandadan', 'kaigai', 'naruto']) {
  const body = new URLSearchParams({ action: 'action_tr_search_suggest', nonce: nonce!, term });
  const res = await fetchResponse(`${BASE}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/` },
    body,
    timeoutMs: 15000,
    redirect: 'follow',
  });
  const out = await res.text();
  const hrefs = [...out.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  console.log(term, '=>', res.status, out.length < 200 ? out.replace(/<[^>]+>/g, ' ').trim().slice(0, 60) : `${hrefs.length} hrefs`, hrefs.slice(0, 3));
}
