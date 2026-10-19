import { fetchText, loadHtml } from '../src/utils/http/fetch.js';

const BASE = 'https://az-animex.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const html = await fetchText(`${BASE}/?s=mushoku`, {
  headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9', Referer: `${BASE}/` },
  timeoutMs: 15000,
});
console.log('html len:', html ? html.length : 'null');
if (html) {
  const $ = loadHtml(html);
  const lis = $('li.wp-block-post');
  console.log('li.wp-block-post count:', lis.length);
  lis.each((i, el) => {
    if (i > 4) return;
    const li = $(el);
    console.log('li', i, 'firstA href=', li.find('a').first().attr('href'), 'alt=', li.find('img').first().attr('alt'));
  });
  console.log('anchors w/ mirrored:', $('a[href*="mirrored to"], a[href*="mirrored.to"]').length);
  // test root include s
}
