const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const BASE = 'https://www.shademanga.com';

const embed = 'https://www.mp4upload.com/embed-bz5usnfha398.html';
const url = `${BASE}/api/anime/resolve?servidor=${encodeURIComponent('Mp4upload')}&embed=${encodeURIComponent(embed)}`;
const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BASE}/` } });
const j = await r.json();
console.log('resolve status:', r.status);
console.log(JSON.stringify(j, null, 2).slice(0, 800));
if (j?.url) {
  const p = new URL(j.url, BASE).toString();
  const rp = await fetch(p, { headers: { 'User-Agent': UA, Referer: `${BASE}/` }, redirect: 'follow' });
  console.log('proxy status:', rp.status, rp.headers.get('content-type'), rp.headers.get('content-length'));
  const buf = await rp.arrayBuffer();
  console.log('first bytes:', new TextDecoder().decode(buf.slice(0, 16)));
}
