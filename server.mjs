// Minimal US-hosted YouTube transcript API (WEB youtubei → timedtext fallback)
import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.use(cors());
app.use(morgan("dev"));

const PORT = process.env.PORT || 3001;

// ---------- helpers ----------
const UA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  // helps skip consent interstitial in some regions:
  cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX; PREF=hl=en; YSC=abc123;",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
};

function toId(x) {
  try {
    const s = String(x).trim();
    if (/^[\w-]{10,}$/.test(s)) return s;
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.pathname.includes("/shorts/")) return u.pathname.split("/shorts/")[1].split("/")[0];
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

function extractJSON(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}

function pickTrack(tracks, want) {
  const w = (want || "").toLowerCase();
  return (
    (w && tracks.find(t => (t.languageCode || "").toLowerCase() === w)) ||
    tracks.find(t => t.isDefault) ||
    tracks.find(t => (t.languageCode || "").startsWith("en")) ||
    tracks[0]
  );
}

// Build youtubei "params" when track.params is missing.
// Encodes field(1)=vssId, field(2)=languageCode → base64url(payload)
function makeParamsFromTrack(track) {
  try {
    const base = new URL(track.baseUrl);
    const vssId = track?.vssId || base.searchParams.get("vssId") || base.searchParams.get("vssids");
    const lang = track?.languageCode || "en";
    if (!vssId) return null;

    const enc = new TextEncoder();
    const vBytes = enc.encode(vssId);
    const lBytes = enc.encode(lang);

    const varint = (n) => {
      const out = [];
      let x = n >>> 0;
      while (x > 127) { out.push((x & 0x7f) | 0x80); x >>>= 7; }
      out.push(x);
      return out;
    };
    const field = (tag, bytes) => [tag, ...varint(bytes.length), ...bytes];
    const payload = Uint8Array.from([
      ...field(0x0A, vBytes),
      ...field(0x12, lBytes),
    ]);

    return Buffer.from(payload).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

function mapYoutubeiTranscript(json) {
  const groups =
    json?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer
      ?.body?.transcriptBodyRenderer?.cueGroups;

  const out = [];
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const cues = g?.transcriptCueGroupRenderer?.cues || [];
      for (const c of cues) {
        const cue = c?.transcriptCueRenderer;
        if (!cue) continue;
        const raw = (cue.cue?.simpleText ?? cue.simpleText ?? "").toString();
        const text = raw.replace(/\s+/g, " ").trim();
        const start = Number(cue.startOffsetMs || 0) / 1000;
        const dur = Number(cue.durationMs || 0) / 1000;
        if (text) out.push({ text, offset: start, duration: Math.max(0, dur) });
      }
    }
  }
  return out;
}

function mapJson3(data) {
  const ev = data?.events;
  if (!Array.isArray(ev)) return [];
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (!e?.segs) continue;
    const text = e.segs.map(s => s.utf8).join("").replace(/\s+/g," ").trim();
    if (!text) continue;
    const start = Number(e.tStartMs ?? 0);
    let dur = Number(e.dDurationMs ?? 0);
    if (!dur && i + 1 < ev.length && ev[i + 1]?.tStartMs != null) {
      dur = Number(ev[i + 1].tStartMs) - start;
    }
    out.push({ text, offset: start / 1000, duration: Math.max(0, dur / 1000) });
  }
  return out;
}

function parseVTT(vtt) {
  const re = /(\d{2}):(\d{2}):(\d{2}\.\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}\.\d{3})\s*\n([\s\S]*?)(?=\n\n|\n\d{2}:\d{2}:\d{2}\.|$)/g;
  const toSec = (h,m,s)=>Number(h)*3600+Number(m)*60+Number(s);
  const items = [];
  let m;
  while ((m = re.exec(vtt))) {
    const text = m[7].replace(/<\/?[^>]+>/g,"").replace(/\s+/g," ").trim();
    if (!text) continue;
    const start = toSec(m[1],m[2],m[3]), end = toSec(m[4],m[5],m[6]);
    items.push({ text, offset: start, duration: Math.max(0, end - start) });
  }
  return items;
}

// ---------- routes ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send(
`YTScribe API ✅

Try:
/api/health
/api/transcript?v=<VIDEO_ID>&lang=auto`
  );
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/transcript", async (req, res) => {
  const v = req.query.v;
  const wantLang = (req.query.lang || "").toString().toLowerCase();

  const id = toId(v);
  if (!id) return res.status(400).json({ ok: false, error: 'Missing or invalid ?v=<videoId or YouTube URL>' });

  try {
    // 1) watch HTML from US region
    const watchUrl =
      `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` +
      `&hl=en&gl=US&bpctr=9999999999&has_verified=1`;
    const html = await fetch(watchUrl, { headers: UA_HEADERS }).then(r => r.text());

    // Consent-wall guard
    if (/consent/i.test(html) && !/ytInitialPlayerResponse/.test(html)) {
      return res.status(451).json({ ok: false, error: "Region/consent gating. Try again or different region." });
    }

    // 2) extract config + player
    const ytcfg = extractJSON(html, [/ytcfg\.set\(({.+?})\);/s]) || {};
    const player = extractJSON(html, [
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s,
      /"ytInitialPlayerResponse":\s*(\{.+?\})[,<]/s,
    ]) || {};

    const key = ytcfg.INNERTUBE_API_KEY;
    const clientVersion = ytcfg.INNERTUBE_CLIENT_VERSION;
    const clientName = ytcfg.INNERTUBE_CLIENT_NAME || "WEB";
    const visitorData = ytcfg.VISITOR_DATA;

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return res.json({ ok: true, items: [], note: "No caption tracks listed." });

    const track = pickTrack(tracks, wantLang);
    let params = track?.params || makeParamsFromTrack(track);

    // 3) try youtubei (WEB)
    if (key && clientVersion && params) {
      const headers = {
        ...UA_HEADERS,
        "content-type": "application/json",
        "x-goog-visitor-id": visitorData || "",
        "x-youtube-client-name": "1",
        "x-youtube-client-version": clientVersion,
      };
      const body = {
        context: {
          client: { hl: "en", gl: "US", clientName, clientVersion, visitorData }
        },
        videoId: id,
        params,
      };
      const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(key)}`;
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const raw = await r.text();
      if (r.ok) {
        try {
          const data = JSON.parse(raw);
          const items = mapYoutubeiTranscript(data);
          if (items.length) return res.json({ ok: true, items, source: "youtubei" });
        } catch {}
      }
      // If youtubei fails, we fall through to timedtext
    }

    // 4) timedtext fallback (as-is → json3 → vtt)
    const base = new URL(track.baseUrl);
    if (wantLang) base.searchParams.set("lang", wantLang);

    const candidates = [];
    candidates.push(base.toString());
    const uJson3 = new URL(base); uJson3.searchParams.set("fmt","json3"); candidates.push(uJson3.toString());
    const uVtt  = new URL(base);  uVtt.searchParams.set("fmt","vtt");    candidates.push(uVtt.toString());

    for (const u of candidates) {
      const r = await fetch(u, { headers: UA_HEADERS });
      const t = await r.text();
      if (!r.ok || !t) continue;

      if (t.trim().startsWith("{")) {
        try {
          const data = JSON.parse(t);
          const items = mapJson3(data);
          if (items.length) return res.json({ ok: true, items, source: "timedtext-json3" });
        } catch {}
      } else if (t.includes("WEBVTT")) {
        const items = parseVTT(t);
        if (items.length) return res.json({ ok: true, items, source: "timedtext-vtt" });
      }
    }

    // 5) nothing worked
    return res.json({ ok: false, error: "No captions available for this video/language." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});
