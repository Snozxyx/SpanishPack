import { fetchText, fetchResponse } from '../src/utils/http/fetch.js';

const MLB = 'https://www.mirrored.to';
const MLB_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://az-animex.com/',
};

// Hop 1: multilink page listing
let html = await fetchText(`${MLB}/multilinks/9282c01271`, { headers: MLB_HEADERS, timeoutMs: 15000 });
console.log('hop1 len:', html ? html.length : 'null');
if (html) {
  const links = [...html.matchAll(/mirrored\.to\/files\/([A-Za-z0-9]+)\/([^"'\s<>]+?)_links/g)];
  console.log('hop1 _links entries:', links.length, links.slice(0, 2).map((x) => x[0]).slice(0, 2));
  console.log('hop1 has dl=0:', html.includes('dl=0'), 'has hash:', html.includes('hash='));
}

// Hop 2: episode _links page (fid/fname from recon)
const fname = encodeURIComponent('[Az-Animex]_Mushoku_Tensei_III_-_Isekai_Ittara_Honki_Dasu_-_01_[Hakoniwa].mp4');
html = await fetchText(`${MLB}/files/74E83E48/${fname}_links`, { headers: MLB_HEADERS, timeoutMs: 15000 });
console.log('hop2 len:', html ? html.length : 'null');
if (html) {
  const h = html;
  const hd = h.match(/<h3 class="hdark">([^<]+)<\/h3>/);
  console.log('hop2 hdark:', hd ? hd[1] : null);
  const hh = h.match(/\/files\/74E83E48\/\?hash=([a-f0-9]{32})/);
  console.log('hop2 hash:', hh ? hh[1] : null);
  console.log('hop2 tmpID present:', h.includes('tmpID'));
}

// Hop 3: dl=0 page with the hash from recon
html = await fetchText(`${MLB}/files/74E83E48/?hash=7b82a19adf13964576b41ef27efbfb7f&dl=0`, { headers: MLB_HEADERS, timeoutMs: 15000 });
console.log('hop3 len:', html ? html.length : 'null');
if (html) {
  const tmp = html.match(/"([a-f0-9]{32})"\s*;\s*var/);
  console.log('hop3 tmpID regex hit:', tmp ? tmp[1] : null);
  const alt = html.match(/tmpID=([a-f0-9]{32})/);
  console.log('hop3 tmpID mirstats param:', alt ? alt[1] : null);
  console.log('hop3 mirstats present:', html.includes('mirstats'));
}
