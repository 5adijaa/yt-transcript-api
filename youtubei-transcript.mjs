import { fetch } from 'undici';

const input = process.argv[2] || 'iG9CE55wbtY';
const id = /^[\w-]{10,}$/.test(input) ? input : new URL(input).searchParams.get('v');

const headers = {
  'cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX',
  'accept-language': 'en',
  'x-youtube-client-name': '1',
  'user-agent': 'Mozilla/5.0',
};

const html = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers }).then(r=>r.text());
const cfg = html.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
const pr  = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s)?.[1];
const ytcfg = cfg ? JSON.parse(cfg) : {};
const player = pr ? JSON.parse(pr) : {};

const key   = ytcfg.INNERTUBE_API_KEY;
const ver   = ytcfg.INNERTUBE_CLIENT_VERSION;
const visit = ytcfg.VISITOR_DATA;
const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
const track  = tracks[0];
console.log('track:', track?.languageCode, track?.kind, track?.name?.simpleText);

if (!key || !track) {
  console.log('No key or track; cannot call youtubei.');
  process.exit(0);
}

const body = {
  context: { client: {
    hl: 'en', gl: 'US',
    clientName: 'WEB',
    clientVersion: ver,
    visitorData: visit
  }},
  videoId: id,
  ...(track.params ? { params: track.params } : {})
};

const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${key}`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    ...headers,
    'content-type': 'application/json',
    'x-youtube-client-version': ver,
  },
  body: JSON.stringify(body)
});

if (!res.ok) {
  console.log('youtubei status:', res.status, await res.text().catch(()=>'')); 
  process.exit(0);
}
const data = await res.json();
const groups = data.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer
  ?.body?.transcriptBodyRenderer?.cueGroups || [];

const items = groups.flatMap(g => {
  const cue = g?.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
  if (!cue) return [];
  const text = (cue.cue?.simpleText || '').trim();
  return text ? [{ text }] : [];
});
console.log('youtubei items:', items.length);
console.log(items.slice(0,3));
