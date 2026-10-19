import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const BASE = 'https://www2.pelisforte.se';

// 1. get nonce from a plain page (home)
const page = await fetchResponse(`${BASE}/`, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000, redirect: 'follow' });
const html = await page.text();
const jarCookie = page.headers.get('set-cookie');
const nonce = html.match(/"content_nonce":"([0-9a-f]+)"/)?.[1];
console.log('status:', page.status, 'nonce:', nonce);
console.log('set-cookie:', jarCookie);

// 2. call admin-ajax search suggest
const body = new URLSearchParams({ action: 'action_tr_search_suggest', nonce: nonce || '', term: 'naruto' });
const res = await fetchResponse(`${BASE}/wp-admin/admin-ajax.php`, {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${BASE}/`,
    ...(jarCookie ? { Cookie: jarCookie } : {}),
  },
  body,
  timeoutMs: 15000,
  redirect: 'follow',
});
const out = await res.text();
console.log('ajax status:', res.status, 'len:', out.length);
console.log(out.slice(0, 1200));
