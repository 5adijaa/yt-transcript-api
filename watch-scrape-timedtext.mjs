import { fetch } from 'undici';

const input = process.argv[2] || 'iG9CE55wbtY';
const tgt   = process.argv[3] || 'en';

// allow full URL or ID
function toId(x) {
  try {
    if (/^[\w-]{10,}$/.test(x)) return x;
    const u = new URL(x);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    return u.searchParams.get('v');
  } catch { return x; }
}
const id = toId(input);

const headers = {
  // consent+language headers sometimes help
  'cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX',
  'accept-language': 'en',
  'user-agent': 'Mozilla/5.0',
};

const html = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers }).then(r=>r.text());

// parse ytcfg + player response
const cfg = html.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
const pr  = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s)?.[1];
const player = pr ? JSON.parse(pr) : {};

const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
console.log('tracks:', tracks.map(t => `${t.languageCode}:${t.kind||'speech'}`));

const track = tracks.find(t => t.languageCode === tgt) || tracks[0];
if (!track) {
  console.log('No captionTracks found.');
  process.exit(0);
}

const base = new URL(track.baseUrl);
const withParam = (u, k, v) => { const x=new URL(u); x.searchParams.set(k,v); return x; };

const tries = [
  base.toString(),
  withParam(base,'fmt','json3').toString(),
  withParam(base,'fmt','vtt').toString(),
  (()=>{ const u=new URL(base); u.searchParams.set('lang', tgt); u.searchParams.set('fmt','json3'); return u.toString(); })(),
  (()=>{ const u=new URL(base); u.searchParams.set('tlang', tgt); u.searchParams.set('fmt','json3'); return u.toString(); })(),
  // “classic” form (helps on some POPs)
  `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&lang=${encodeURIComponent(tgt)}&fmt=json3${track.kind?'&caps=asr&kind=asr':''}`,
];

let got = null, used = null;
for (const url of tries) {
  const r = await fetch(url, { headers });
  const txt = await r.text();
  console.log('try:', r.status, 'len=', txt.length, url.slice(0, 100)+'…');
  if (r.ok && txt.trim()) { got = txt; used = url; break; }
}

if (!got) {
  console.log('No captions returned from timedtext on this POP.');
  process.exit(0);
}

// parse json3 or vtt lightly
let items = [];
if (got.trim().startsWith('{')) {
  const j = JSON.parse(got);
  items = (j.events || []).flatMap(ev => {
    const seg = ev.segs?.[0]?.utf8?.trim();
    if (!seg) return [];
    const start = (ev.tStartMs || 0)/1000;
    const dur   = (ev.dDurationMs || ev.dur || 0)/1000;
    return [{ text: seg, offset: start, duration: dur }];
  });
} else {
  // VTT: very naive parse
  got.split('\n\n').forEach(block => {
    const m = block.match(/(\d+:\d+:\d+\.\d+)\s+-->\s+(\d+:\d+:\d+\.\d+)\s*\n([\s\S]+)/);
    if (!m) return;
    const text = m[3].trim().replace(/\n/g,' ');
    if (text) items.push({ text });
  });
}

console.log('items:', items.length);
console.log(items.slice(0,3));
