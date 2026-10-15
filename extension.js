// `vscode` only exists inside the editor's extension host. Unit tests (node --test)
// load this file outside of it, so the require must not be fatal.
let vscode = null;
try {
  vscode = require("vscode");
} catch (_) {
  vscode = null;
}
const fs = require("fs");
const { execFile } = require("child_process");
const dns = require("dns");

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const USER_AGENT = "OrbitLyricsBox/1.0.2";
// A lyrics candidate whose duration differs from the player's by more than this is a different recording.
const DURATION_TOLERANCE_SEC = 3;
const FETCH_TIMEOUT_MS = 8000;
const EXEC_TIMEOUT_MS = 4000;
const RETRY_AFTER_ERROR_MS = 15000;
const MAX_RETRY_DELAY_MS = 120000;
const RETRY_5XX_DELAY_MS = 400;
const MAX_CACHE_ENTRIES = 300;

// Only successful lookups and definitive "not found" results are cached (never network errors).
const lyricsCache = new Map();
let lastKnownState = null;
let outputChannel = null;

/* ------------------------------------------------------------------ *
 * Title / artist cleaning
 * ------------------------------------------------------------------ */

const DASH_SPLIT = /\s+[-–—]\s+/;

// Always removed: pure noise that never appears in a lyrics database entry.
const NOISE_BRACKET = /\s*[\(\[](?:official(?:\s*(?:music\s*)?video|\s*audio|\s*lyric\s*(?:video)?|\s*visuali[sz]er|\s*clip)?|(?:lyrics?|audio|lyric)(?:\s*video)?|visuali[sz]er|visualiser|hd|4k|mv|hq|clip\s*officiel|video\s*oficial|vorsicht[^\)\]]*)[\)\]]/gi;
const COVER_BRACKET = /\s*[\(\[][^\)\]]*cover[^\)\]]*[\)\]]/gi;
// Remaster info never changes the lyrics or the timing, so it is always removed.
const REMASTER_BRACKET = /\s*[\(\[][^\)\]]*(?<![\p{L}\p{N}])re-?master(?:ed)?(?![\p{L}\p{N}])[^\)\]]*[\)\]]/giu;
// Version tags (remix, live, ...). Kept for the first lookup, removed for the fallback lookup.
const VERSION_BRACKET = /\s*[\(\[][^\)\]]*(?<![\p{L}\p{N}])(?:feat\.?|ft\.?|featuring|with|live|acoustic|version|mono|stereo|edit|remix|rmx|mix|dj|instrumental|extended|bootleg|mashup|sped\s*up|slowed|reverb|demo|session)(?![\p{L}\p{N}])[^\)\]]*[\)\]]/giu;
const TRAILING_FEAT = /\s*[-–]?\s*\b(?:feat\.?|ft\.?|featuring)\b.*$/i;
// "Title - Remastered 2009", "Title - Official Video": suffixes that carry no useful information.
const DROPPABLE_SUFFIX = /re-?master|^(?:official|lyrics?|audio|video|visuali[sz]er|hd|4k|mv)\b/i;
// Decides whether the text after " - " is a version tag (suffix) rather than the real title.
const TAG_LIKE_SUFFIX = /(?<![\p{L}\p{N}])(?:re-?master(?:ed)?|live|acoustic|edit|remix|rmx|mix|version|mono|stereo|demo|session|instrumental|extended|bootleg|mashup|radio|single|deluxe|bonus|official|lyrics?|audio|video|visuali[sz]er|feat\.?|ft\.?)(?![\p{L}\p{N}])/iu;

function collapseSpaces(str) {
  return str.replace(/\s{2,}/g, " ").trim();
}

function cleanArtistName(artist) {
  return String(artist || "")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\s*VEVO$/i, "")
    .replace(/\s*-\s*Topic$/i, "")
    .trim();
}

/**
 * Turns raw player metadata into lookup-ready values.
 * Returns titleVariants ordered from most to least specific:
 *   [0] keeps version tags (remix / live / acoustic / feat ...), without remaster or video noise
 *   [1] the same title with every version tag removed (only used as a duration-checked fallback)
 */
function cleanTrackInfo(rawTitle, rawArtist) {
  const originalTitle = String(rawTitle || "")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .trim();
  let title = originalTitle;
  let artist = String(rawArtist || "")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .trim();
  const noisyArtist = !artist || /vevo|topic|various/i.test(artist);
  artist = cleanArtistName(artist);
  let artistFromTitle = false;
  let dashSuffix = "";

  const parts = title.split(DASH_SPLIT);
  if (parts.length > 1) {
    const head = parts[0].trim();
    const rest = parts.slice(1).join(" - ").trim();
    if (noisyArtist) {
      // YouTube style: "Artist - Title"
      artist = head;
      artistFromTitle = true;
      title = rest;
    } else if (artistMatches(head, [artist])) {
      // "Artist - Title" while the artist is already known
      title = rest;
    } else if (TAG_LIKE_SUFFIX.test(rest)) {
      // "Title - Remastered 2009" / "Title - Live at X": the suffix is a tag, not the title
      title = head;
      dashSuffix = rest;
    } else {
      // YouTube style "Artist - Title" where the channel name differs from the artist
      artist = head;
      artistFromTitle = true;
      title = rest;
    }
  }

  let core = title.replace(NOISE_BRACKET, "").replace(COVER_BRACKET, "").replace(REMASTER_BRACKET, "");
  core = collapseSpaces(core);
  if (!core) core = collapseSpaces(originalTitle);

  const keepSuffix = dashSuffix && !DROPPABLE_SUFFIX.test(dashSuffix);
  const withTags = keepSuffix ? `${core} - ${dashSuffix}` : core;
  const bare = collapseSpaces(core.replace(VERSION_BRACKET, "").replace(TRAILING_FEAT, "")) || core;

  const titleVariants = [];
  for (const v of [withTags, bare]) {
    if (v && !titleVariants.includes(v)) titleVariants.push(v);
  }

  return { title: titleVariants[0] || "", titleVariants, artist, artistFromTitle };
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

// Lowercase, strip Latin diacritics, unify "&"/"and" and drop punctuation.
// Unicode-aware so Japanese / Korean / Cyrillic titles do not collapse to an empty string.
function normalizeForMatch(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip Latin diacritics
    .normalize("NFC") // recompose (e.g. Japanese dakuten, Hangul)
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

// True if the candidate's artist equals, or contains / is contained by (on word boundaries),
// any of the wanted artists. Handles "A, B" vs "A".
function artistMatches(candidateArtist, artists) {
  const got = normalizeForMatch(candidateArtist);
  if (!got) return false;
  for (const artist of artists || []) {
    const want = normalizeForMatch(artist);
    if (!want) continue;
    if (got === want) return true;
    if ((` ${got} `).includes(` ${want} `) || (` ${want} `).includes(` ${got} `)) return true;
  }
  return false;
}

function isDurationOk(candidateDuration, wantDuration) {
  if (!wantDuration) return true; // the player gave no duration: nothing to verify against
  if (typeof candidateDuration !== "number" || !isFinite(candidateDuration)) return false;
  return Math.abs(candidateDuration - wantDuration) <= DURATION_TOLERANCE_SEC;
}

/**
 * Returns acceptable candidates, best first. A candidate must have lyrics, the SAME title,
 * a matching artist and (when known) a duration within DURATION_TOLERANCE_SEC.
 * Ranking: closest duration first, then synced lyrics before plain lyrics.
 */
function rankCandidates(list, { titles, artists, duration = 0, requireDuration = false }) {
  if (!Array.isArray(list)) return [];
  const wantTitles = new Set((titles || []).map(normalizeForMatch).filter(Boolean));
  if (wantTitles.size === 0) return [];
  const hasArtist = (artists || []).some(a => normalizeForMatch(a));
  // Without an artist the title alone is too weak: demand a verified duration.
  if ((requireDuration || !hasArtist) && !duration) return [];

  return list
    .filter(c => c && (c.syncedLyrics || c.plainLyrics))
    .filter(c => wantTitles.has(normalizeForMatch(c.trackName || c.name)))
    .filter(c => !hasArtist || artistMatches(c.artistName, artists))
    .filter(c => isDurationOk(c.duration, duration))
    .map(c => ({
      c,
      diff: duration && typeof c.duration === "number" ? Math.round(Math.abs(c.duration - duration)) : 0,
      synced: c.syncedLyrics ? 1 : 0
    }))
    .sort((a, b) => (a.diff - b.diff) || (b.synced - a.synced))
    .map(x => x.c);
}

function pickBestCandidate(list, criteria) {
  return rankCandidates(list, criteria)[0] || null;
}

/* ------------------------------------------------------------------ *
 * LRC parsing + LRCLIB lookup
 * ------------------------------------------------------------------ */

function parseLrc(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split("\n");
  const result = [];
  const timeRegex = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const text = match[3].trim();
      if (text) {
        result.push({
          time: minutes * 60 + seconds,
          text: text
        });
      }
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

function candidateToResult(data) {
  if (data && data.syncedLyrics) {
    const lines = parseLrc(data.syncedLyrics);
    if (lines.length) return { lines, synced: true };
  }
  if (data && data.plainLyrics) {
    const lines = data.plainLyrics
      .split("\n")
      .map(t => t.trim())
      .filter(Boolean)
      .map(text => ({ time: 0, text }));
    if (lines.length) return { lines, synced: false };
  }
  return null;
}

function firstUsableResult(candidates) {
  for (const c of candidates) {
    const result = candidateToResult(c);
    if (result) return result;
  }
  return null;
}

/**
 * Tiered, strict lookup. Resolves to { lines, synced } or null (definitively not found).
 * Rejects on network / server errors so callers can avoid caching them.
 *
 *  Tier A/B: title with version tags kept  -> /api/get, then /api/search
 *  Tier C:   title without version tags    -> same, but the duration MUST match
 */
async function lookupLyrics(track, { fetchImpl = fetch } = {}) {
  const titleVariants = (track && track.titleVariants) || [];
  const artists = ((track && track.artists) || []).filter(Boolean);
  const duration = (track && track.duration) || 0;
  const album = (track && track.album) || "";
  const primaryArtist = artists[0] || "";

  const getJson = async (endpoint, params) => {
    const qs = new URLSearchParams(params).toString();
    const init = { headers: { "User-Agent": USER_AGENT } };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    }
    const url = `https://lrclib.net/api/${endpoint}?${qs}`;
    let res;
    // LRCLIB answers 5xx intermittently; retry once before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetchImpl(url, init);
      if (res.status < 500) break;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, RETRY_5XX_DELAY_MS));
    }
    if (res.status === 404) return null; // definitive "not found"
    if (!res.ok) throw new Error(`LRCLIB ${endpoint} responded ${res.status}`);
    return res.json();
  };

  const tryTitle = async (title, { requireDuration, withAlbum }) => {
    const criteria = { titles: [title], artists, duration, requireDuration };

    // Exact lookup (LRCLIB matches duration within a couple of seconds).
    if (primaryArtist) {
      const params = { track_name: title, artist_name: primaryArtist };
      if (withAlbum && album) params.album_name = album;
      if (duration) params.duration = String(Math.round(duration));
      const exact = await getJson("get", params);
      const hit = firstUsableResult(rankCandidates(exact ? [exact] : [], criteria));
      if (hit) return hit;
    }

    // Search: structured query first, then free text.
    const searches = [];
    if (primaryArtist) searches.push({ track_name: title, artist_name: primaryArtist });
    else searches.push({ track_name: title });
    searches.push({ q: `${title} ${primaryArtist}`.trim() });
    for (const params of searches) {
      const list = await getJson("search", params);
      const hit = firstUsableResult(rankCandidates(list || [], criteria));
      if (hit) return hit;
    }
    return null;
  };

  for (let i = 0; i < titleVariants.length; i++) {
    const hit = await tryTitle(titleVariants[i], { requireDuration: i > 0, withAlbum: i === 0 });
    if (hit) return hit;
  }
  return null;
}

function lyricsCacheKey(track) {
  const title = (track.titleVariants && track.titleVariants[0]) || "";
  return [normalizeForMatch(title), normalizeForMatch((track.artists || []).join(" ")), Math.round(track.duration || 0)].join("____");
}

async function fetchLyricsFromLRCLIB(track, { force = false, fetchImpl } = {}) {
  const key = lyricsCacheKey(track);
  if (!force && lyricsCache.has(key)) return lyricsCache.get(key);

  const found = await lookupLyrics(track, { fetchImpl }); // throws on network errors: not cached
  const result = found || { lines: [], synced: false };
  if (lyricsCache.size >= MAX_CACHE_ENTRIES) {
    lyricsCache.delete(lyricsCache.keys().next().value);
  }
  lyricsCache.set(key, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * Track-change controller (race-free)
 * ------------------------------------------------------------------ */

function trackKeyOf(state) {
  return `${state.rawTitle || ""}____${state.rawArtist || ""}____${Math.round(state.duration || 0)}`;
}

/**
 * Owns the lyrics of the CURRENT track. Every fetch carries a generation token; a response
 * from an older generation (fast skipping A -> B -> C) is discarded, and the lyrics are cleared
 * the moment the track changes so the previous song's lyrics never sit under a new title.
 * status: "idle" | "loading" | "found" | "none" | "error"
 */
class LyricsController {
  constructor({ fetchLyrics, onLyrics, log = () => {}, now = Date.now, retryAfterMs = RETRY_AFTER_ERROR_MS }) {
    this.fetchLyrics = fetchLyrics;
    this.onLyrics = onLyrics || (() => {});
    this.log = log;
    this.now = now;
    this.retryAfterMs = retryAfterMs;
    this.generation = 0;
    this.inflight = false;
    this.retryAt = 0;
    this.failures = 0;
    this.key = null;
    this.lyrics = [];
    this.synced = false;
    this.status = "idle";
  }

  get snapshot() {
    return { lyrics: this.lyrics, synced: this.synced, status: this.status };
  }

  // Called on every poll. Returns the snapshot plus `changed` (true when lyrics were reset / refetched).
  update(state, { force = false } = {}) {
    const key = trackKeyOf(state);
    const trackChanged = key !== this.key;

    if (!state.rawTitle) {
      if (trackChanged || force) {
        this.generation++;
        this.inflight = false;
        this.key = key;
        this.lyrics = [];
        this.synced = false;
        this.status = "none";
        return { changed: true, ...this.snapshot };
      }
      return { changed: false, ...this.snapshot };
    }

    const retry = !trackChanged && !force && this.status === "error" && !this.inflight && this.now() >= this.retryAt;
    if (!trackChanged && !force && !retry) {
      return { changed: false, ...this.snapshot };
    }

    if (trackChanged || force) this.failures = 0;
    this.key = key;
    this.lyrics = [];
    this.synced = false;
    this.status = "loading";
    this._startFetch(state, force);
    return { changed: true, ...this.snapshot };
  }

  _startFetch(state, force) {
    const gen = ++this.generation;
    this.inflight = true;
    this.log(`Fetching lyrics for: ${state.title} - ${state.artist}`);

    let pending;
    try {
      pending = Promise.resolve(this.fetchLyrics(state.lookup, { force }));
    } catch (err) {
      pending = Promise.reject(err);
    }

    pending
      .then(result => {
        if (gen !== this.generation) return; // a newer track took over: drop this response
        this.inflight = false;
        this.lyrics = result.lines;
        this.synced = !!result.synced;
        this.status = result.lines.length ? "found" : "none";
        this.log(`Got ${result.lines.length} lyric lines (synced: ${this.synced})`);
        this.onLyrics(this.snapshot);
      })
      .catch(err => {
        if (gen !== this.generation) return;
        this.inflight = false;
        this.lyrics = [];
        this.synced = false;
        this.status = "error";
        this.retryAt = this.now() + Math.min(this.retryAfterMs * Math.pow(2, this.failures), MAX_RETRY_DELAY_MS);
        this.failures++;
        this.log(`Lyrics fetch failed: ${err && err.message}`);
        this.onLyrics(this.snapshot);
      });
  }
}

/* ------------------------------------------------------------------ *
 * MPRIS (busctl) access and parsing
 * ------------------------------------------------------------------ */

const PLAYER_NAME_RE = /^org\.mpris\.MediaPlayer2\.[A-Za-z0-9_.\-]+$/;

function isValidPlayerName(name) {
  return typeof name === "string" && PLAYER_NAME_RE.test(name);
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || "");
    });
  });
}

function busctlGet(player, property) {
  return run("busctl", ["--user", "get-property", player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", property]);
}

function unescapeBusctl(str) {
  if (!str) return "";
  const bytes = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\") {
      const next3 = str.slice(i + 1, i + 4);
      if (/^[0-3][0-7]{2}$/.test(next3)) {
        bytes.push(parseInt(next3, 8));
        i += 4;
        continue;
      }
      const next2 = str.slice(i + 1, i + 3);
      if (/^[0-7]{2}$/.test(next2)) {
        bytes.push(parseInt(next2, 8));
        i += 3;
        continue;
      }
      if (str[i + 1] === "x" && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 2, i + 4))) {
        bytes.push(parseInt(str.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      if (str[i + 1] === "n") { bytes.push(10); i += 2; continue; }
      if (str[i + 1] === "t") { bytes.push(9); i += 2; continue; }
      if (str[i + 1] === "r") { bytes.push(13); i += 2; continue; }
      if (str[i + 1] === "\\" || str[i + 1] === "\"" || str[i + 1] === "'") {
        bytes.push(str.charCodeAt(i + 1));
        i += 2;
        continue;
      }
    }
    const code = str.codePointAt(i);
    const buf = Buffer.from(String.fromCodePoint(code));
    for (const b of buf) bytes.push(b);
    i += String.fromCodePoint(code).length;
  }
  return Buffer.from(bytes).toString("utf-8");
}

// Splits busctl output into quoted strings (unescaped) and bare words.
function tokenizeBusctl(output) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^\s"]+)/g;
  let m;
  while ((m = re.exec(output || "")) !== null) {
    if (m[1] !== undefined) tokens.push({ v: unescapeBusctl(m[1]), q: true });
    else tokens.push({ v: m[2], q: false });
  }
  return tokens;
}

// Parses `busctl get-property ... Metadata` ( a{sv} N "key" type value ... ) into plain fields.
function parseBusctlMetadata(output) {
  const out = { title: "", artists: [], album: "", artUrl: "", length: 0 };
  const tokens = tokenizeBusctl(output);
  let i = 0;
  if (tokens[0] && tokens[0].v === "a{sv}") i = 2; // skip type + entry count
  while (i + 1 < tokens.length) {
    const key = tokens[i];
    const type = tokens[i + 1];
    if (!key.q || type.q) break;
    i += 2;
    let value;
    if (type.v.length > 1 && type.v[0] === "a" && type.v[1] !== "{") {
      // Array of simple values: `as 2 "A" "B"`
      const count = parseInt((tokens[i] || {}).v, 10);
      if (!isFinite(count)) break;
      i += 1;
      value = tokens.slice(i, i + count).map(t => t.v);
      i += count;
    } else if (type.v.length === 1) {
      if (i >= tokens.length) break;
      value = tokens[i].v;
      i += 1;
    } else {
      break; // nested / unsupported type: stop, keep what we have
    }
    switch (key.v) {
      case "xesam:title": if (typeof value === "string") out.title = value; break;
      case "xesam:artist": if (Array.isArray(value)) out.artists = value.filter(Boolean); break;
      case "xesam:album": if (typeof value === "string") out.album = value; break;
      case "mpris:artUrl": if (typeof value === "string") out.artUrl = value; break;
      case "mpris:length": {
        const n = parseInt(value, 10);
        if (isFinite(n)) out.length = n / 1000000;
        break;
      }
      default: break;
    }
  }
  return out;
}

function parseStringProperty(output) {
  const m = /\bs\s+"((?:[^"\\]|\\.)*)"/.exec(output || "");
  return m ? unescapeBusctl(m[1]) : "";
}

function parseIntegerProperty(output) {
  const m = /\b[xtiun]\s+(-?\d+)/.exec(output || "");
  return m ? parseInt(m[1], 10) : 0;
}

// Builds the player state from the raw busctl outputs (pure, unit-testable).
function buildPlayerState(player, statusOut, positionOut, metadataOut) {
  const status = parseStringProperty(statusOut) || "Stopped";
  const position = parseIntegerProperty(positionOut) / 1000000;
  const meta = parseBusctlMetadata(metadataOut);

  let artUrl = meta.artUrl || "";
  if (artUrl && artUrl.startsWith("file://")) {
    try {
      const localPath = decodeURIComponent(artUrl.replace(/^file:\/\//, ""));
      if (fs.existsSync(localPath)) {
        const buf = fs.readFileSync(localPath);
        let mime = "image/jpeg";
        if (buf[0] === 0x89 && buf[1] === 0x50) mime = "image/png";
        else if (buf[0] === 0x47 && buf[1] === 0x49) mime = "image/gif";
        else if (buf[0] === 0x52 && buf[1] === 0x49) mime = "image/webp";
        artUrl = `data:${mime};base64,${buf.toString("base64")}`;
      }
    } catch (_) {}
  }
  meta.artUrl = artUrl;

  const rawTitle = meta.title;
  const rawArtist = meta.artists.join(", ");
  const cleaned = cleanTrackInfo(rawTitle, meta.artists[0] || "");

  let artists;
  if (cleaned.artistFromTitle) {
    artists = [cleaned.artist];
  } else {
    artists = [cleaned.artist, ...meta.artists.map(cleanArtistName)];
  }
  artists = artists.filter((a, idx) => a && artists.indexOf(a) === idx);

  const displayArtist = cleaned.artistFromTitle
    ? cleaned.artist
    : (meta.artists.map(cleanArtistName).filter(Boolean).join(", "));

  return {
    player,
    playerName: player.split(".").pop(),
    status,
    position,
    rawTitle,
    rawArtist,
    title: cleaned.title || rawTitle || "Unknown Track",
    artist: displayArtist || "Unknown Artist",
    artUrl: meta.artUrl,
    duration: meta.length || 0,
    album: meta.album || "",
    lookup: {
      titleVariants: cleaned.titleVariants,
      artists,
      duration: meta.length || 0,
      album: meta.album || ""
    }
  };
}

async function getActivePlayer() {
  let listing;
  try {
    listing = await run("busctl", ["--user", "list"]);
  } catch (_) {
    return null;
  }
  const players = [];
  for (const line of listing.split("\n")) {
    const match = line.match(/(org\.mpris\.MediaPlayer2\.[^\s]+)/);
    if (match && isValidPlayerName(match[1]) && !players.includes(match[1])) players.push(match[1]);
  }
  if (players.length === 0) return null;

  const statuses = await Promise.all(players.map(p =>
    busctlGet(p, "PlaybackStatus")
      .then(out => ({ p, playing: out.includes('"Playing"') }))
      .catch(() => ({ p, playing: false }))
  ));
  return (statuses.find(s => s.playing) || statuses[0]).p;
}

async function getPlayerState(player) {
  if (!isValidPlayerName(player)) return null;
  try {
    const [statusOut, positionOut, metadataOut] = await Promise.all([
      busctlGet(player, "PlaybackStatus"),
      busctlGet(player, "Position").catch(() => ""), // some players do not expose Position
      busctlGet(player, "Metadata")
    ]);
    return buildPlayerState(player, statusOut, positionOut, metadataOut);
  } catch (_) {
    return null;
  }
}

function sendPlayerCommand(player, command, extraArgs = []) {
  if (!isValidPlayerName(player)) return;
  run("busctl", ["--user", "call", player, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", command, ...extraArgs])
    .catch(err => console.error("[LyricsBox] Command error:", command, err));
}

/* ------------------------------------------------------------------ *
 * Webview provider
 * ------------------------------------------------------------------ */

function toViewState(state) {
  const { lookup, ...viewState } = state; // the lookup data is host-side only
  return viewState;
}

class LyricsBoxViewProvider {
  constructor(extensionUri, controller) {
    this._extensionUri = extensionUri;
    this._controller = controller;
    this._views = [];
  }

  _sendCurrent() {
    const snap = this._controller.snapshot;
    if (lastKnownState) {
      this.postMessage({
        type: "state",
        state: toViewState(lastKnownState),
        lyrics: snap.lyrics,
        synced: snap.synced,
        lyricsStatus: snap.status
      });
    } else {
      // Placeholder so the webview is not blank before the first poll completes
      this.postMessage({
        type: "state",
        state: { title: "Loading...", artist: "", status: "Stopped", position: 0, duration: 0 },
        lyrics: [],
        synced: false,
        lyricsStatus: "loading"
      });
    }
  }

  resolveWebviewView(webviewView) {
    // Track all opened webview panels (Explorer + Sidebar)
    this._views.push(webviewView);
    webviewView.onDidDispose(() => {
      this._views = this._views.filter(v => v !== webviewView);
    }, null, []);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Small delay to ensure webview JS is loaded
    setTimeout(() => this._sendCurrent(), 200);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!lastKnownState || !lastKnownState.player) return;
      const player = lastKnownState.player;

      if (msg.type === "playPause") {
        sendPlayerCommand(player, "PlayPause");
      } else if (msg.type === "next") {
        sendPlayerCommand(player, "Next");
      } else if (msg.type === "previous") {
        sendPlayerCommand(player, "Previous");
      } else if (msg.type === "seek") {
        const offsetMicro = Math.round((Number(msg.position) - (lastKnownState.position || 0)) * 1000000);
        if (!Number.isFinite(offsetMicro)) return;
        sendPlayerCommand(player, "Seek", ["x", String(offsetMicro)]);
      }
    });

    this._sendCurrent();
  }

  postMessage(message) {
    for (const v of this._views) {
      try { v.webview.postMessage(message); } catch (_) {}
    }
  }

  _getHtmlForWebview(webview) {
    return getWebviewContent();
  }
}

function getWebviewContent() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: blob: vscode-resource: vscode-webview-resource:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lyrics Box</title>
  <style>
    /*
     * APPLE MUSIC DARK THEME (iOS Inspired)
     * Elegant, refined, monochrome with soft opacities and frosted glass.
     * Non-garish: zero neon colors, strictly curated dark slate and silver/white.
     */
    :root {
      --ios-font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, sans-serif;
      --ios-bg: #0d0e12;
      --ios-card-bg: rgba(255, 255, 255, 0.04);
      --ios-card-border: rgba(255, 255, 255, 0.08);
      --ios-card-highlight: rgba(255, 255, 255, 0.06);
      --ios-text-primary: #ffffff;
      --ios-text-secondary: rgba(255, 255, 255, 0.62);
      --ios-text-tertiary: rgba(255, 255, 255, 0.38);
      --ios-text-dim: rgba(255, 255, 255, 0.22);
      --ios-accent: rgba(255, 255, 255, 0.95);
      --ios-radius: 12px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: var(--ios-font);
      -webkit-font-smoothing: antialiased;
    }

    body {
      background: radial-gradient(circle at 50% 0%, rgba(35, 42, 54, 0.35) 0%, rgba(13, 14, 18, 0.98) 100%);
      color: var(--ios-text-primary);
      padding: 8px;
      overflow: hidden;
      user-select: none;
      font-size: 11px;
      height: 100vh;
    }

    .container {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 7px;
      width: 100%;
    }

    /* ===== TOP: APPLE MUSIC PLAYER CARD ===== */
    .player-card {
      background: var(--ios-card-bg);
      border: 1px solid var(--ios-card-border);
      border-radius: var(--ios-radius);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      flex-shrink: 0;
    }

    .track-meta-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .art-wrapper {
      width: 44px;
      height: 44px;
      border-radius: 9px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    #albumArt {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: none;
    }

    .art-fallback {
      font-size: 18px;
      color: var(--ios-text-tertiary);
      display: block;
    }

    .track-details {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }

    .track-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--ios-text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: -0.2px;
    }

    .track-artist {
      font-size: 11px;
      font-weight: 500;
      color: var(--ios-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: -0.1px;
    }

    /* iOS Scrubber Progress Bar */
    .scrubber-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 1px;
    }

    .progress-bar-container {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      transition: height 0.15s ease;
    }

    .progress-bar-container:hover {
      height: 6px;
    }

    .progress-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0%;
      background: var(--ios-accent);
      border-radius: 999px;
      transition: width 0.1s linear;
    }

    .transport-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .time-label {
      font-size: 9.5px;
      font-weight: 500;
      color: var(--ios-text-tertiary);
      font-variant-numeric: tabular-nums;
      min-width: 28px;
    }

    .time-label.right {
      text-align: right;
    }

    .controls-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .ctrl-btn {
      background: none;
      border: none;
      color: var(--ios-text-secondary);
      cursor: pointer;
      font-size: 13px;
      padding: 3px;
      line-height: 1;
      border-radius: 6px;
      transition: color 0.15s ease, transform 0.1s ease;
    }

    .ctrl-btn:hover {
      color: var(--ios-text-primary);
      transform: scale(1.1);
    }

    .ctrl-btn:active {
      transform: scale(0.95);
    }

    .ctrl-play {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.12);
      color: var(--ios-text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      transition: background 0.15s ease, transform 0.1s ease;
    }

    .ctrl-play:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: scale(1.08);
    }

    /* ===== CENTER: APPLE MUSIC LYRICS CARD ===== */
    .lyrics-card {
      background: var(--ios-card-bg);
      border: 1px solid var(--ios-card-border);
      border-radius: var(--ios-radius);
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .lyrics-top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid var(--ios-card-border);
      flex-shrink: 0;
    }

    .lyrics-badge {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.8px;
      color: var(--ios-text-tertiary);
      display: inline-flex;
      align-items: center;
      gap: 5px;
      line-height: 1;
    }

    .lyrics-badge-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.5);
    }

    .lyrics-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .offset-stepper {
      display: inline-flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      padding: 1px 4px;
      gap: 3px;
      height: 20px;
      box-sizing: border-box;
    }

    .stepper-btn {
      background: rgba(255, 255, 255, 0.06);
      border: none;
      color: var(--ios-text-secondary);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      width: 15px;
      height: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 50%;
      padding: 0;
      transition: all 0.15s ease;
      user-select: none;
    }

    .stepper-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.2);
    }

    .stepper-btn:active {
      transform: scale(0.88);
    }

    .stepper-val {
      font-size: 9px;
      font-weight: 600;
      color: var(--ios-text-secondary);
      font-variant-numeric: tabular-nums;
      padding: 0 2px;
      cursor: pointer;
      user-select: none;
      min-width: 25px;
      text-align: center;
      letter-spacing: -0.2px;
      transition: color 0.15s ease;
    }

    .stepper-val:hover {
      color: #ffffff;
    }

    .stepper-val.active-offset {
      color: #ffffff;
      font-weight: 700;
    }

    .toggle-view-btn {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--ios-text-secondary);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.6px;
      padding: 2px 7px;
      height: 19px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .toggle-view-btn:hover {
      color: var(--ios-text-primary);
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.25);
    }

    /* Lyrics stream with Apple Music edge mask */
    .lyrics-viewport {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 12px 10px;
      position: relative;
      scroll-behavior: smooth;
      scrollbar-width: none;
      -ms-overflow-style: none;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 8%, black 93%, transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0%, black 8%, black 93%, transparent 100%);
    }

    .lyrics-viewport::-webkit-scrollbar,
    .full-lyrics-container::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }

    .full-lyrics-container {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .lyrics-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding-top: 15px;
      padding-bottom: 45px;
    }

    .lyric-item {
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.42;
      color: rgba(255, 255, 255, 0.35);
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.25s ease, font-size 0.25s ease;
      letter-spacing: -0.2px;
      word-break: break-word;
    }

    .lyric-item:hover {
      color: rgba(255, 255, 255, 0.7);
    }

    /* Active line in Apple Music style: crisp pure white, sharp, no fog/blur shadow */
    .lyric-item.active {
      font-size: 15.5px;
      font-weight: 700;
      line-height: 1.45;
      color: #ffffff;
      background: transparent;
      border: none;
      padding: 6px 8px;
      text-shadow: none;
    }

    .lyric-empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      gap: 6px;
      color: var(--ios-text-tertiary);
      font-size: 12px;
      padding: 20px;
    }

    .lyric-empty-icon {
      font-size: 22px;
      opacity: 0.6;
    }

    /* Full lyrics view - matches live sync Apple Music aesthetics */
    .full-lyrics-container {
      display: none;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 16px 12px 45px 12px;
      flex-direction: column;
      gap: 5px;
      scroll-behavior: smooth;
      scrollbar-width: none;
      -ms-overflow-style: none;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%);
    }

    .full-lyric-line {
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.38;
      color: rgba(255, 255, 255, 0.35);
      padding: 5px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.25s ease, font-size 0.25s ease;
      letter-spacing: -0.2px;
    }

    .full-lyric-line:hover {
      color: rgba(255, 255, 255, 0.7);
    }

    .full-lyric-line.active {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.38;
      color: #ffffff;
      background: transparent;
      border: none;
      padding-left: 8px;
      text-shadow: none;
    }

    /* ===== BOTTOM: APPLE MUSIC STATUS FOOTER ===== */
    .footer-bar {
      background: var(--ios-card-bg);
      border: 1px solid var(--ios-card-border);
      border-radius: var(--ios-radius);
      padding: 5px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      font-size: 9.5px;
      color: var(--ios-text-tertiary);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .source-info {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* 4-bar sound wave */
    .eq-wave {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      height: 12px;
    }

    .eq-bar {
      width: 2.5px;
      background: rgba(255, 255, 255, 0.82);
      border-radius: 1px;
      height: 3px;
      animation: eqBounce 0.8s ease-in-out infinite alternate;
    }

    .eq-bar:nth-child(1) { animation-duration: 0.65s; animation-delay: 0.1s; }
    .eq-bar:nth-child(2) { animation-duration: 0.85s; animation-delay: 0.25s; }
    .eq-bar:nth-child(3) { animation-duration: 0.6s; animation-delay: 0.05s; }
    .eq-bar:nth-child(4) { animation-duration: 0.9s; animation-delay: 0.35s; }

    .eq-wave.paused .eq-bar {
      animation-play-state: paused;
      height: 3px !important;
      opacity: 0.35;
    }

    @keyframes eqBounce {
      0% { height: 3px; }
      50% { height: 11px; }
      100% { height: 5px; }
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .status-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.3);
    }

    .status-dot.playing {
      background: #ffffff;
      box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
    }

    .status-dot.paused {
      background: rgba(255, 255, 255, 0.3);
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- ===== TOP: APPLE MUSIC PLAYER CARD ===== -->
    <div class="player-card">
      <div class="track-meta-row">
        <div class="art-wrapper">
          <img id="albumArt" alt="art" />
          <span class="art-fallback" id="artFallback"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.35"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></span>
        </div>
        <div class="track-details">
          <div class="track-title" id="trackTitle">NO TRACK</div>
          <div class="track-artist" id="trackArtist">—</div>
        </div>
      </div>

      <div class="scrubber-wrap">
        <div class="progress-bar-container" id="progressTrack" title="Seek">
          <div class="progress-fill" id="progressFill"></div>
        </div>
        <div class="transport-row">
          <span class="time-label" id="timeCurrent">0:00</span>
          <div class="controls-group">
            <button class="ctrl-btn" id="prevBtn" title="Previous">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button class="ctrl-btn ctrl-play" id="playPauseBtn" title="Play / Pause">
              <svg id="playIcon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><path d="M8 5v14l11-7z"/></svg>
              <svg id="pauseIcon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>
            <button class="ctrl-btn" id="nextBtn" title="Next">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
          </div>
          <span class="time-label right" id="timeTotal">0:00</span>
        </div>
      </div>
    </div>

    <!-- ===== CENTER: APPLE MUSIC LYRICS CARD ===== -->
    <div class="lyrics-card">
      <div class="lyrics-top-bar">
        <div class="lyrics-badge">
          <div class="lyrics-badge-dot"></div>
          <span id="lyricsBadgeText">LIVE SYNC</span>
        </div>
        <div class="lyrics-actions">
          <div class="offset-stepper" title="Sync offset: [−] lambatkan / [+] percepat">
            <button class="stepper-btn" id="offsetMinusBtn" title="Lambatkan (−0.1s)">−</button>
            <span class="stepper-val" id="offsetLabel" title="Klik untuk reset (0.0s)">0.0s</span>
            <button class="stepper-btn" id="offsetPlusBtn" title="Percepat (+0.1s)">+</button>
          </div>
          <button class="toggle-view-btn" id="toggleViewBtn" title="Toggle Full / Live Lyrics">FULL</button>
        </div>
      </div>

      <!-- Live Synced Scroll Viewport -->
      <div class="lyrics-viewport" id="subtitleBox">
        <div class="lyrics-list" id="lyricsFlow">
          <div class="lyric-empty-state">
            <div class="lyric-empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></div>
            <div>CONNECTING TO PLAYER...</div>
          </div>
        </div>
      </div>

      <!-- Static Full Lyrics Container -->
      <div class="full-lyrics-container" id="fullLyricsContainer"></div>
    </div>

    <!-- ===== BOTTOM: STATUS FOOTER ===== -->
    <div class="footer-bar">
      <div class="source-info">
        <div class="eq-wave" id="eqBars">
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
        </div>
        <span id="playerSource">APPLE MUSIC LINK</span>
      </div>
      <div class="status-badge">
        <div class="status-dot playing" id="statusDot"></div>
        <span id="statusInfo">IDLE</span>
      </div>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let lyrics = [];
    let currentPosition = 0;
    let trackDuration = 0;
    let playbackStatus = "Stopped";
    let lastTickTime = performance.now();
    let currentActiveIndex = -1;
    let showFullLyrics = false;
    let isSynced = true;
    let receivedState = false;
    let lyricsStatus = "loading"; // loading | found | none | error
    let userScrollUntil = 0;

    // DOM Elements
    const statusDot = document.getElementById("statusDot");
    const playerSource = document.getElementById("playerSource");
    const albumArt = document.getElementById("albumArt");
    const artFallback = document.getElementById("artFallback");
    const trackTitle = document.getElementById("trackTitle");
    const trackArtist = document.getElementById("trackArtist");
    const timeCurrent = document.getElementById("timeCurrent");
    const timeTotal = document.getElementById("timeTotal");
    const progressFill = document.getElementById("progressFill");
    const progressTrack = document.getElementById("progressTrack");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");
    const eqBars = document.getElementById("eqBars");
    const statusInfo = document.getElementById("statusInfo");
    const toggleViewBtn = document.getElementById("toggleViewBtn");
    const subtitleBox = document.getElementById("subtitleBox");
    const lyricsFlow = document.getElementById("lyricsFlow");
    const fullLyricsContainer = document.getElementById("fullLyricsContainer");
    const lyricsBadgeText = document.getElementById("lyricsBadgeText");
    const offsetMinusBtn = document.getElementById("offsetMinusBtn");
    const offsetPlusBtn = document.getElementById("offsetPlusBtn");
    const offsetLabel = document.getElementById("offsetLabel");

    let userOffset = 0;
    try {
      const savedState = vscode.getState();
      if (savedState && typeof savedState.userOffset === "number") {
        userOffset = savedState.userOffset;
      }
    } catch (_) {}

    function updateOffsetDisplay() {
      const val = Math.abs(userOffset) < 0.01 ? 0 : userOffset;
      const formatted = (val > 0 ? "+" : "") + val.toFixed(1) + "s";
      offsetLabel.innerText = formatted;
      if (val !== 0) {
        offsetLabel.classList.add("active-offset");
      } else {
        offsetLabel.classList.remove("active-offset");
      }
      try {
        vscode.setState({ ...(vscode.getState() || {}), userOffset: val });
      } catch (_) {}
    }

    updateOffsetDisplay();

    offsetMinusBtn.addEventListener("click", () => {
      userOffset = Math.round((userOffset - 0.1) * 10) / 10;
      updateOffsetDisplay();
      currentActiveIndex = -2;
      updateActiveLyric(currentPosition);
    });

    offsetPlusBtn.addEventListener("click", () => {
      userOffset = Math.round((userOffset + 0.1) * 10) / 10;
      updateOffsetDisplay();
      currentActiveIndex = -2;
      updateActiveLyric(currentPosition);
    });

    offsetLabel.addEventListener("click", () => {
      userOffset = 0;
      updateOffsetDisplay();
      currentActiveIndex = -2;
      updateActiveLyric(currentPosition);
    });

    function formatTime(sec) {
      if (!sec || isNaN(sec)) return "0:00";
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ":" + (s < 10 ? "0" : "") + s;
    }

    // Transport buttons
    playPauseBtn.addEventListener("click", () => vscode.postMessage({ type: "playPause" }));
    prevBtn.addEventListener("click", () => vscode.postMessage({ type: "previous" }));
    nextBtn.addEventListener("click", () => vscode.postMessage({ type: "next" }));

    // User scroll detector so auto-scroll does not fight manual scroll
    subtitleBox.addEventListener("wheel", () => {
      userScrollUntil = Date.now() + 3200;
    }, { passive: true });

    subtitleBox.addEventListener("touchmove", () => {
      userScrollUntil = Date.now() + 3200;
    }, { passive: true });

    fullLyricsContainer.addEventListener("wheel", () => {
      userScrollUntil = Date.now() + 3200;
    }, { passive: true });

    fullLyricsContainer.addEventListener("touchmove", () => {
      userScrollUntil = Date.now() + 3200;
    }, { passive: true });

    toggleViewBtn.addEventListener("click", () => {
      showFullLyrics = !showFullLyrics;
      if (showFullLyrics) {
        subtitleBox.style.display = "none";
        fullLyricsContainer.style.display = "flex";
        toggleViewBtn.innerText = "SYNC";
        renderFullLyricsList();
      } else {
        subtitleBox.style.display = "block";
        fullLyricsContainer.style.display = "none";
        toggleViewBtn.innerText = "FULL";
        renderLyricsFlow();
      }
    });

    // Scrubber click to seek
    progressTrack.addEventListener("click", (e) => {
      if (!trackDuration) return;
      const rect = progressTrack.getBoundingClientRect();
      const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetSec = clickRatio * trackDuration;
      vscode.postMessage({ type: "seek", position: targetSec });
    });

    // Handle messages from Extension Host
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "state") {
        receivedState = true;
        if (typeof msg.synced === "boolean") isSynced = msg.synced;
        if (msg.lyricsStatus) lyricsStatus = msg.lyricsStatus;
        updateState(msg.state, msg.lyrics);
      } else if (msg.type === "lyricsLoaded") {
        lyrics = msg.lyrics || [];
        if (typeof msg.synced === "boolean") isSynced = msg.synced;
        if (msg.lyricsStatus) lyricsStatus = msg.lyricsStatus;
        currentActiveIndex = -2;
        renderLyricsFlow();
        if (showFullLyrics) renderFullLyricsList();
      }
    });

    function updateState(state, newLyrics) {
      if (!state) return;

      playbackStatus = state.status || "Stopped";
      currentPosition = state.position || 0;
      trackDuration = state.duration || 0;
      lastTickTime = performance.now();

      if (newLyrics) {
        lyrics = newLyrics;
        currentActiveIndex = -2;
        renderLyricsFlow();
        if (showFullLyrics) renderFullLyricsList();
      }

      // Title & Artist
      const displayTitle = (state.title || "NO TRACK").replace(/\\'/g, "'").replace(/\\"/g, '"');
      const displayArtistText = (state.artist || "—").replace(/\\'/g, "'").replace(/\\"/g, '"');
      trackTitle.innerText = displayTitle;
      trackArtist.innerText = displayArtistText;
      let friendlyName = (state.playerName || "PLAYER").toUpperCase();
      const rawP = (state.player || "").toLowerCase();
      if (rawP.includes("spotify")) friendlyName = "SPOTIFY";
      else if (rawP.includes("chromium")) friendlyName = "CHROMIUM";
      else if (rawP.includes("chrome")) friendlyName = "CHROME";
      else if (rawP.includes("firefox")) friendlyName = "FIREFOX";
      else if (rawP.includes("brave")) friendlyName = "BRAVE";
      else if (rawP.includes("edge")) friendlyName = "EDGE";
      else if (rawP.includes("vlc")) friendlyName = "VLC";
      playerSource.innerText = friendlyName + " • LINK";
      timeTotal.innerText = formatTime(trackDuration);

      // Album Art
      if (state.artUrl) {
        albumArt.src = state.artUrl;
        albumArt.style.display = "block";
        artFallback.style.display = "none";
      } else {
        albumArt.style.display = "none";
        albumArt.removeAttribute("src");
        artFallback.style.display = "block";
      }

      // Playback Status Indicator
      const playIcon = document.getElementById("playIcon");
      const pauseIcon = document.getElementById("pauseIcon");

      if (playbackStatus === "Playing") {
        statusDot.className = "status-dot playing";
        eqBars.classList.remove("paused");
        statusInfo.innerText = "PLAYING";
        if (playIcon) playIcon.style.display = "none";
        if (pauseIcon) pauseIcon.style.display = "block";
      } else {
        statusDot.className = "status-dot paused";
        eqBars.classList.add("paused");
        statusInfo.innerText = (playbackStatus || "PAUSED").toUpperCase();
        if (playIcon) playIcon.style.display = "block";
        if (pauseIcon) pauseIcon.style.display = "none";
      }

      updateActiveLyric(currentPosition);
    }

    function renderLyricsFlow() {
      lyricsFlow.innerHTML = "";
      if (!lyrics || !lyrics.length) {
        let msg = "LISTENING FOR TRACK...";
        let icon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
        if (lyricsStatus === "none") {
          msg = "NO LYRICS FOUND";
          icon = "✕";
        } else if (lyricsStatus === "loading") {
          msg = "FETCHING LYRICS...";
          icon = "⋯";
        } else if (lyricsStatus === "error") {
          msg = "RETRYING SEARCH...";
          icon = "⚠";
        }
        lyricsFlow.innerHTML = '<div class="lyric-empty-state"><div class="lyric-empty-icon">' + icon + '</div><div>' + msg + '</div></div>';
        lyricsBadgeText.innerText = isSynced ? "LYRICS" : "PLAIN";
        return;
      }

      lyricsBadgeText.innerText = isSynced ? "LIVE SYNC" : "PLAIN";

      lyrics.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "lyric-item" + (idx === currentActiveIndex ? " active" : "");
        div.innerText = item.text;
        div.setAttribute("data-idx", idx);
        div.addEventListener("click", () => {
          vscode.postMessage({ type: "seek", position: item.time });
        });
        lyricsFlow.appendChild(div);
      });
    }

    function renderFullLyricsList() {
      fullLyricsContainer.innerHTML = "";
      if (!lyrics.length) {
        fullLyricsContainer.innerHTML = '<div class="lyric-empty-state"><div>NO LYRICS FOUND</div></div>';
        return;
      }

      lyrics.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "full-lyric-line" + (idx === currentActiveIndex ? " active" : "");
        div.innerText = item.text;
        div.addEventListener("click", () => {
          vscode.postMessage({ type: "seek", position: item.time });
        });
        fullLyricsContainer.appendChild(div);
      });
    }

    const BASE_ADVANCE_OFFSET = 0.35;

    function updateActiveLyric(pos) {
      if (!lyrics || !lyrics.length || !isSynced) return;

      const effectivePos = pos + BASE_ADVANCE_OFFSET + userOffset;

      // Find current active line
      let activeIdx = -1;
      for (let i = 0; i < lyrics.length; i++) {
        if (lyrics[i].time <= effectivePos) {
          activeIdx = i;
        } else {
          break;
        }
      }

      if (activeIdx !== currentActiveIndex) {
        currentActiveIndex = activeIdx;

        // Update live scroll list classes
        const items = lyricsFlow.querySelectorAll(".lyric-item");
        items.forEach((el, idx) => {
          if (idx === activeIdx) {
            el.classList.add("active");
            // Only auto-scroll if user has not recently scrolled manually
            if (Date.now() > userScrollUntil) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          } else {
            el.classList.remove("active");
          }
        });

        // Update full lyrics list if active
        if (showFullLyrics) {
          const fullItems = fullLyricsContainer.querySelectorAll(".full-lyric-line");
          fullItems.forEach((el, idx) => {
            if (idx === activeIdx) {
              el.classList.add("active");
              if (Date.now() > userScrollUntil) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            } else {
              el.classList.remove("active");
            }
          });
        }
      }
    }

    // Smooth Clock & Scrubber Loop
    function frameLoop(now) {
      const delta = (now - lastTickTime) / 1000;
      lastTickTime = now;

      if (playbackStatus === "Playing") {
        currentPosition += delta;
        if (trackDuration && currentPosition > trackDuration) {
          currentPosition = trackDuration;
        }

        timeCurrent.innerText = formatTime(currentPosition);

        if (trackDuration > 0) {
          const pct = Math.max(0, Math.min(100, (currentPosition / trackDuration) * 100));
          progressFill.style.width = pct + "%";
        }

        updateActiveLyric(currentPosition);
      }

      requestAnimationFrame(frameLoop);
    }

    requestAnimationFrame(frameLoop);

    setTimeout(() => {
      if (!receivedState) {
        trackTitle.innerText = "WAITING...";
        trackArtist.innerText = "Connecting to player";
      }
    }, 1200);
  </script>
</body>
</html>`;
}

function activate(context) {
  // Create output channel for debugging
  outputChannel = vscode.window.createOutputChannel("Lyrics Box");
  outputChannel.appendLine("[LyricsBox] Extension activated");
  const log = (message) => outputChannel.appendLine(`[LyricsBox] ${message}`);

  let provider = null;
  const controller = new LyricsController({
    fetchLyrics: (lookup, opts) => fetchLyricsFromLRCLIB(lookup, opts),
    onLyrics: (snap) => {
      if (!provider) return;
      provider.postMessage({
        type: "lyricsLoaded",
        lyrics: snap.lyrics,
        synced: snap.synced,
        lyricsStatus: snap.status
      });
    },
    log
  });
  provider = new LyricsBoxViewProvider(context.extensionUri, controller);

  // Register view for both Explorer and Activity Bar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lyricsBoxExplorer", provider),
    vscode.window.registerWebviewViewProvider("lyricsBoxSidebar", provider)
  );

  const pushState = (state, result) => {
    provider.postMessage({
      type: "state",
      state: toViewState(state),
      // Lyrics are only included when they were reset; async results arrive as "lyricsLoaded"
      lyrics: result.changed ? result.lyrics : undefined,
      synced: result.synced,
      lyricsStatus: result.status
    });
  };

  // Command palette: re-fetch lyrics for the current track, bypassing the cache
  context.subscriptions.push(
    // Command palette / Title bar: re-fetch lyrics for current track
    vscode.commands.registerCommand("orbit-lyrics.refresh", async () => {
      const player = await getActivePlayer();
      if (!player) return;
      const state = await getPlayerState(player);
      if (!state) return;
      lastKnownState = state;
      pushState(state, controller.update(state, { force: true }));
    }),
    vscode.commands.registerCommand("antigravityLyrics.refresh", async () => {
      vscode.commands.executeCommand("orbit-lyrics.refresh");
    }),
    // Media controls
    vscode.commands.registerCommand("orbit-lyrics.playPause", async () => {
      if (lastKnownState && lastKnownState.player) {
        sendPlayerCommand(lastKnownState.player, "PlayPause");
      }
    }),
    vscode.commands.registerCommand("orbit-lyrics.next", async () => {
      if (lastKnownState && lastKnownState.player) {
        sendPlayerCommand(lastKnownState.player, "Next");
      }
    }),
    vscode.commands.registerCommand("orbit-lyrics.previous", async () => {
      if (lastKnownState && lastKnownState.player) {
        sendPlayerCommand(lastKnownState.player, "Previous");
      }
    })
  );

  // Background polling (every 1s). Ticks never overlap, and lyrics are fetched in the
  // background so a slow request cannot stall position updates.
  let ticking = false;
  let lastLoggedError = "";

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const player = await getActivePlayer();
      if (!player) {
        if (lastKnownState && lastKnownState.status !== "Stopped") {
          lastKnownState.status = "Stopped";
          provider.postMessage({
            type: "state",
            state: toViewState(lastKnownState),
            synced: controller.synced,
            lyricsStatus: controller.status
          });
        }
        return;
      }

      const state = await getPlayerState(player);
      if (!state) {
        if (lastLoggedError !== "state") {
          lastLoggedError = "state";
          log(`Could not get player state for ${player}`);
        }
        return;
      }
      lastLoggedError = "";

      lastKnownState = state;
      pushState(state, controller.update(state));
    } catch (e) {
      log(`Loop error: ${e.message}`);
    } finally {
      ticking = false;
    }
  };

  tick();
  const interval = setInterval(tick, 1000);

  context.subscriptions.push({
    dispose: () => clearInterval(interval)
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  // exported for unit tests
  cleanTrackInfo,
  cleanArtistName,
  normalizeForMatch,
  artistMatches,
  isDurationOk,
  rankCandidates,
  pickBestCandidate,
  parseLrc,
  lookupLyrics,
  fetchLyricsFromLRCLIB,
  LyricsController,
  parseBusctlMetadata,
  buildPlayerState,
  isValidPlayerName,
  getWebviewContent,
  DURATION_TOLERANCE_SEC
};
