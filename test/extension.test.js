const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ext = require("../extension.js");

const {
  cleanTrackInfo, normalizeForMatch, artistMatches, rankCandidates, pickBestCandidate,
  parseLrc, lookupLyrics, fetchLyricsFromLRCLIB, LyricsController, parseBusctlMetadata,
  buildPlayerState, buildGenericPlayerState, isValidPlayerName, getWebviewContent
} = ext;

const tick = () => new Promise(resolve => setImmediate(resolve));

/* ---------- Task 1: baseline ---------- */

test("parseLrc: parses timestamps, skips empty lines, sorts by time", () => {
  const lines = parseLrc("[00:10.50] second\n[00:01.00] first\n[00:05.00]\nno timestamp\n[01:02.25]third");
  assert.deepEqual(lines, [
    { time: 1, text: "first" },
    { time: 10.5, text: "second" },
    { time: 62.25, text: "third" }
  ]);
  assert.deepEqual(parseLrc(""), []);
  assert.deepEqual(parseLrc(null), []);
});

test("normalizeForMatch: Latin text", () => {
  assert.equal(normalizeForMatch("  Beyoncé & Jay-Z!  "), "beyonce and jay z");
});

test("the webview script is syntactically valid", () => {
  const html = getWebviewContent();
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  assert.doesNotThrow(() => new vm.Script(script));
});

/* ---------- Task 2: title cleaning ---------- */

test("cleanTrackInfo: remaster suffix is not mistaken for the title", () => {
  const r = cleanTrackInfo("Yesterday - Remastered 2009", "The Beatles");
  assert.equal(r.title, "Yesterday");
  assert.deepEqual(r.titleVariants, ["Yesterday"]);
  assert.equal(r.artist, "The Beatles");
});

test("cleanTrackInfo: '- 2011 Remaster' and bracketed remaster are dropped", () => {
  assert.equal(cleanTrackInfo("Hello - 2011 Remaster", "Adele").title, "Hello");
  assert.equal(cleanTrackInfo("Hello (Remastered 2011)", "Adele").title, "Hello");
});

test("cleanTrackInfo: remix tag kept in the first variant, stripped in the second", () => {
  const r = cleanTrackInfo("Song (DJ Remix)", "Artist");
  assert.deepEqual(r.titleVariants, ["Song (DJ Remix)", "Song"]);
});

test("cleanTrackInfo: live / dash suffix kept in the first variant", () => {
  const r = cleanTrackInfo("Song - Live at Wembley", "Artist");
  assert.deepEqual(r.titleVariants, ["Song - Live at Wembley", "Song"]);
  assert.equal(cleanTrackInfo("Song - Radio Edit", "Artist").titleVariants[0], "Song - Radio Edit");
});

test("cleanTrackInfo: YouTube 'Artist - Title' with no / noisy artist", () => {
  const a = cleanTrackInfo("Coldplay - Yellow", "");
  assert.equal(a.title, "Yellow");
  assert.equal(a.artist, "Coldplay");
  assert.equal(a.artistFromTitle, true);
  const b = cleanTrackInfo("Adele - Hello", "AdeleVEVO");
  assert.equal(b.title, "Hello");
  assert.equal(b.artist, "Adele");
});

test("cleanTrackInfo: known artist repeated in the title is dropped", () => {
  const r = cleanTrackInfo("Adele - Hello", "Adele");
  assert.equal(r.title, "Hello");
  assert.equal(r.artistFromTitle, false);
});

test("cleanTrackInfo: VEVO / Topic suffix removed from artist", () => {
  assert.equal(cleanTrackInfo("Hello", "AdeleVEVO").artist, "Adele");
  assert.equal(cleanTrackInfo("Hello", "Adele - Topic").artist, "Adele");
});

test("cleanTrackInfo: feat. kept first, removed in fallback", () => {
  assert.deepEqual(cleanTrackInfo("Song (feat. Other)", "Artist").titleVariants, ["Song (feat. Other)", "Song"]);
  assert.deepEqual(cleanTrackInfo("Song feat. Other", "Artist").titleVariants, ["Song feat. Other", "Song"]);
});

test("cleanTrackInfo: video noise removed, hyphenated names untouched", () => {
  assert.deepEqual(cleanTrackInfo("Song [Official Video]", "Artist").titleVariants, ["Song"]);
  assert.deepEqual(cleanTrackInfo("Song (Official Music Video)", "Artist").titleVariants, ["Song"]);
  assert.deepEqual(cleanTrackInfo("Jay-Z Anthem", "Artist").titleVariants, ["Jay-Z Anthem"]);
});

/* ---------- Task 3: strict matching ---------- */

test("normalizeForMatch: non-Latin text is not collapsed to an empty string", () => {
  assert.notEqual(normalizeForMatch("夜に駆ける"), "");
  assert.notEqual(normalizeForMatch("사랑해"), "");
  assert.notEqual(normalizeForMatch("Катюша"), "");
  assert.notEqual(normalizeForMatch("が"), normalizeForMatch("か")); // dakuten survives
});

test("artistMatches: equal, contained on word boundaries, never partial words", () => {
  assert.equal(artistMatches("The Beatles", ["The Beatles"]), true);
  assert.equal(artistMatches("A, B", ["A"]), true);
  assert.equal(artistMatches("A", ["A, B"]), true);
  assert.equal(artistMatches("Cat", ["Concatenate"]), false);
  assert.equal(artistMatches("Other Artist", ["Artist X"]), false);
  assert.equal(artistMatches("", ["A"]), false);
});

const cand = (over) => ({ trackName: "Song", artistName: "Artist", duration: 200, syncedLyrics: "[00:01.00] hi", plainLyrics: "hi", ...over });
const crit = { titles: ["Song"], artists: ["Artist"], duration: 200 };

test("rankCandidates: same title by another artist is rejected", () => {
  assert.deepEqual(rankCandidates([cand({ artistName: "Someone Else" })], crit), []);
});

test("rankCandidates: different title is rejected even if the artist matches", () => {
  assert.deepEqual(rankCandidates([cand({ trackName: "Song Two" })], crit), []);
  assert.deepEqual(rankCandidates([cand({ trackName: "Remastered 2009" })], crit), []);
});

test("rankCandidates: duration outside tolerance is rejected, inside accepted", () => {
  assert.deepEqual(rankCandidates([cand({ duration: 240 })], crit), []);
  assert.equal(rankCandidates([cand({ duration: 202.5 })], crit).length, 1);
  assert.deepEqual(rankCandidates([cand({ duration: 204 })], crit), []);
  assert.deepEqual(rankCandidates([cand({ duration: undefined })], crit), []);
});

test("rankCandidates: unknown player duration only needs title + artist", () => {
  assert.equal(rankCandidates([cand({ duration: 999 })], { ...crit, duration: 0 }).length, 1);
});

test("rankCandidates: fallback tier / missing artist require a known duration", () => {
  assert.deepEqual(rankCandidates([cand()], { ...crit, duration: 0, requireDuration: true }), []);
  assert.deepEqual(rankCandidates([cand()], { titles: ["Song"], artists: [], duration: 0 }), []);
  assert.equal(rankCandidates([cand()], { titles: ["Song"], artists: [], duration: 200 }).length, 1);
});

test("rankCandidates: closest duration first, then synced before plain", () => {
  const far = cand({ duration: 202, syncedLyrics: "[00:01.00] far" });
  const near = cand({ duration: 200, syncedLyrics: "[00:01.00] near" });
  assert.equal(pickBestCandidate([far, near], crit), near);
  const plain = cand({ duration: 200, syncedLyrics: null, plainLyrics: "plain" });
  const synced = cand({ duration: 200, syncedLyrics: "[00:01.00] s" });
  assert.equal(pickBestCandidate([plain, synced], crit), synced);
});

test("rankCandidates: Japanese / Korean titles match", () => {
  const c = cand({ trackName: "夜に駆ける", artistName: "YOASOBI" });
  assert.equal(rankCandidates([c], { titles: ["夜に駆ける"], artists: ["YOASOBI"], duration: 200 }).length, 1);
  const k = cand({ trackName: "사랑해", artistName: "가수" });
  assert.equal(rankCandidates([k], { titles: ["사랑해"], artists: ["가수"], duration: 200 }).length, 1);
});

// Fake LRCLIB: routes by endpoint, records the calls.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    const endpoint = u.pathname.replace("/api/", "");
    calls.push({ endpoint, params: Object.fromEntries(u.searchParams) });
    const r = routes(endpoint, Object.fromEntries(u.searchParams));
    if (r instanceof Error) throw r;
    if (r === null) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof r === "number") return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  impl.calls = calls;
  return impl;
}

const track = (over) => ({ titleVariants: ["Song (DJ Remix)", "Song"], artists: ["Artist"], duration: 200, album: "", ...over });

test("lookupLyrics: Tier A exact hit with the tagged title", async () => {
  const f = fakeFetch((e) => e === "get" ? cand({ trackName: "Song (DJ Remix)" }) : []);
  const r = await lookupLyrics(track(), { fetchImpl: f });
  assert.equal(r.synced, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.track_name, "Song (DJ Remix)");
});

test("lookupLyrics: Tier B search with the tagged title when /get misses", async () => {
  const f = fakeFetch((e) => e === "get" ? null : [cand({ trackName: "Song (DJ Remix)", duration: 201 })]);
  const r = await lookupLyrics(track(), { fetchImpl: f });
  assert.ok(r);
  assert.deepEqual(f.calls.map(c => c.endpoint), ["get", "search"]);
});

test("lookupLyrics: Tier C stripped title accepted only with matching duration", async () => {
  const studioSameLength = cand({ trackName: "Song", duration: 201 });
  const f = fakeFetch((e, p) => (e === "search" && p.track_name === "Song") ? [studioSameLength] : (e === "get" ? null : []));
  assert.ok(await lookupLyrics(track(), { fetchImpl: f }));

  const studioLonger = cand({ trackName: "Song", duration: 260 });
  const g = fakeFetch((e, p) => (e === "search" && p.track_name === "Song") ? [studioLonger] : (e === "get" ? null : []));
  assert.equal(await lookupLyrics(track(), { fetchImpl: g }), null);
});

test("lookupLyrics: Tier C is skipped when the player gives no duration", async () => {
  const f = fakeFetch((e, p) => (e === "search" && p.track_name === "Song") ? [cand({ trackName: "Song" })] : (e === "get" ? null : []));
  assert.equal(await lookupLyrics(track({ duration: 0 }), { fetchImpl: f }), null);
});

test("lookupLyrics: wrong-artist / wrong-title results end in null, not wrong lyrics", async () => {
  const f = fakeFetch((e) => e === "get" ? null : [cand({ artistName: "Other" }), cand({ trackName: "Another Song" })]);
  assert.equal(await lookupLyrics(track({ titleVariants: ["Song"] }), { fetchImpl: f }), null);
});

test("lookupLyrics: a transient 5xx is retried once and then succeeds", async () => {
  let n = 0;
  const f = async () => (++n === 1
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => cand({ trackName: "Song (DJ Remix)" }) });
  assert.ok(await lookupLyrics(track(), { fetchImpl: f }));
  assert.equal(n, 2);
});

test("lookupLyrics: server errors reject instead of returning 'not found'", async () => {
  await assert.rejects(lookupLyrics(track(), { fetchImpl: fakeFetch(() => 503) }), /503/);
  await assert.rejects(lookupLyrics(track(), { fetchImpl: fakeFetch(() => new Error("offline")) }), /offline/);
});

test("lookupLyrics: falls back to inverted artist and title when primary only has plain lyrics or misses", async () => {
  const f = fakeFetch((e, p) => {
    if (e === "get" && p.track_name === "Cup of Joe" && p.artist_name === "Multo") {
      return cand({ trackName: "Cup of Joe", artistName: "Multo", duration: 240, syncedLyrics: null, plainLyrics: "plain only" });
    }
    if (e === "search" && p.track_name === "Multo" && p.artist_name === "Cup of Joe") {
      return [cand({ trackName: "Multo", artistName: "Cup of Joe", duration: 240, syncedLyrics: "[00:22.76] synced lyrics", plainLyrics: "synced lyrics" })];
    }
    return null;
  });

  const res = await lookupLyrics({
    titleVariants: ["Cup of Joe"],
    artists: ["Multo"],
    duration: 240,
    album: ""
  }, { fetchImpl: f });

  assert.ok(res);
  assert.equal(res.synced, true);
  assert.equal(res.lines[0].text, "synced lyrics");
});

test("lookupLyrics: matches candidate track with version tags like (Unreleased) when duration is exact", async () => {
  const f = fakeFetch((e, p) => {
    if (e === "get") return null;
    if (e === "search" && p.track_name === "Where We Are") {
      return [cand({ trackName: "Where We Are (Unreleased)", artistName: "One Direction", duration: 222, syncedLyrics: "[00:03.99] Remember when", plainLyrics: "Remember when" })];
    }
    return null;
  });

  const res = await lookupLyrics({
    titleVariants: ["Where We Are"],
    artists: ["One Direction"],
    duration: 222,
    album: ""
  }, { fetchImpl: f });

  assert.ok(res);
  assert.equal(res.synced, true);
  assert.equal(res.lines[0].text, "Remember when");
});

/* ---------- Task 4: controller ---------- */

const mkState = (title, artist = "Artist", duration = 200) => ({
  rawTitle: title, rawArtist: artist, duration, title, artist,
  lookup: { titleVariants: [title], artists: [artist], duration, album: "" }
});
const lyr = (text) => ({ lines: [{ time: 1, text }], synced: true });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("controller: a late response for an old track never overwrites the current lyrics", async () => {
  const pending = {};
  const emitted = [];
  const c = new LyricsController({
    fetchLyrics: (lookup) => (pending[lookup.titleVariants[0]] = deferred()).promise,
    onLyrics: (snap) => emitted.push(snap)
  });
  c.update(mkState("A"));
  c.update(mkState("B"));
  c.update(mkState("C"));
  pending.C.resolve(lyr("lyrics of C"));
  await tick();
  pending.B.resolve(lyr("lyrics of B")); // arrives late
  pending.A.resolve(lyr("lyrics of A"));
  await tick();
  assert.equal(c.lyrics[0].text, "lyrics of C");
  assert.equal(c.status, "found");
  assert.equal(emitted.length, 1);
});

test("controller: lyrics are cleared the moment the track changes", async () => {
  const c = new LyricsController({ fetchLyrics: async () => lyr("old") });
  c.update(mkState("A"));
  await tick();
  assert.equal(c.lyrics.length, 1);
  const r = c.update(mkState("B"));
  assert.equal(r.changed, true);
  assert.deepEqual(r.lyrics, []);
  assert.equal(r.status, "loading");
  assert.deepEqual(c.lyrics, []);
});

test("controller: polling the same track does not start a second fetch", async () => {
  let fetches = 0;
  const d = deferred();
  const c = new LyricsController({ fetchLyrics: () => { fetches++; return d.promise; } });
  c.update(mkState("A"));
  c.update(mkState("A"));
  c.update(mkState("A"));
  assert.equal(fetches, 1);
  d.resolve(lyr("x"));
  await tick();
  c.update(mkState("A"));
  assert.equal(fetches, 1);
});

test("controller: empty result reports 'none'", async () => {
  const c = new LyricsController({ fetchLyrics: async () => ({ lines: [], synced: false }) });
  c.update(mkState("A"));
  await tick();
  assert.equal(c.status, "none");
});

test("controller: network error -> 'error', retried after the delay, then recovers", async () => {
  let now = 1000;
  let attempts = 0;
  const c = new LyricsController({
    fetchLyrics: async () => { attempts++; if (attempts === 1) throw new Error("offline"); return lyr("ok"); },
    now: () => now,
    retryAfterMs: 5000
  });
  c.update(mkState("A"));
  await tick();
  assert.equal(c.status, "error");
  now += 1000;
  c.update(mkState("A"));
  assert.equal(attempts, 1); // too early
  now += 5000;
  c.update(mkState("A"));
  await tick();
  assert.equal(attempts, 2);
  assert.equal(c.status, "found");
});

test("controller: network errors are not cached by fetchLyricsFromLRCLIB", async () => {
  const t = track({ titleVariants: ["Uncached Song"], artists: ["Uncached Artist"] });
  await assert.rejects(fetchLyricsFromLRCLIB(t, { fetchImpl: fakeFetch(() => 503) }));
  const ok = fakeFetch((e) => e === "get" ? cand({ trackName: "Uncached Song", artistName: "Uncached Artist" }) : []);
  const r = await fetchLyricsFromLRCLIB(t, { fetchImpl: ok });
  assert.equal(r.lines.length, 1);
  // definitive results ARE cached
  const again = await fetchLyricsFromLRCLIB(t, { fetchImpl: fakeFetch(() => 503) });
  assert.equal(again.lines.length, 1);
});

test("controller: force bypasses the cache", async () => {
  const t = track({ titleVariants: ["Forced Song"], artists: ["Forced Artist"] });
  const first = fakeFetch((e) => e === "get" ? cand({ trackName: "Forced Song", artistName: "Forced Artist", syncedLyrics: "[00:01.00] one" }) : []);
  await fetchLyricsFromLRCLIB(t, { fetchImpl: first });
  const second = fakeFetch((e) => e === "get" ? cand({ trackName: "Forced Song", artistName: "Forced Artist", syncedLyrics: "[00:01.00] two" }) : []);
  const r = await fetchLyricsFromLRCLIB(t, { fetchImpl: second, force: true });
  assert.equal(r.lines[0].text, "two");
});

test("controller: a track without a title yields 'none' and no fetch", () => {
  let fetches = 0;
  const c = new LyricsController({ fetchLyrics: async () => { fetches++; return lyr("x"); } });
  const r = c.update({ rawTitle: "", rawArtist: "", duration: 0, lookup: {} });
  assert.equal(r.status, "none");
  assert.equal(fetches, 0);
});

/* ---------- Task 5: MPRIS parsing ---------- */

const META = 'a{sv} 7 "mpris:trackid" o "/org/mpris/MediaPlayer2/Track/1" "mpris:length" x 225000000 "mpris:artUrl" s "https://i.scdn.co/image/abc" "xesam:album" s "Some Album" "xesam:artist" as 2 "Artist One" "Artist Two" "xesam:title" s "Song" "xesam:url" s "https://open.spotify.com/track/1"';

test("parseBusctlMetadata: parses all fields and multiple artists", () => {
  const m = parseBusctlMetadata(META);
  assert.equal(m.title, "Song");
  assert.deepEqual(m.artists, ["Artist One", "Artist Two"]);
  assert.equal(m.album, "Some Album");
  assert.equal(m.artUrl, "https://i.scdn.co/image/abc");
  assert.equal(m.length, 225);
});

test("parseBusctlMetadata: escaped quotes and backslashes in the title", () => {
  const m = parseBusctlMetadata('a{sv} 2 "xesam:title" s "He said \\"hi\\" \\\\ ok" "xesam:artist" as 1 "A"');
  assert.equal(m.title, 'He said "hi" \\ ok');
  assert.deepEqual(m.artists, ["A"]);
});

test("parseBusctlMetadata: escaped single quotes in title (e.g. Don\x27t)", () => {
  const m = parseBusctlMetadata('a{sv} 1 "xesam:title" s "Don\\\x27t You Remember"');
  assert.equal(m.title, "Don't You Remember");
});

test("parseBusctlMetadata: missing album / length / artist", () => {
  const m = parseBusctlMetadata('a{sv} 1 "xesam:title" s "Only Title"');
  assert.equal(m.title, "Only Title");
  assert.equal(m.album, "");
  assert.equal(m.length, 0);
  assert.deepEqual(m.artists, []);
});

test("parseBusctlMetadata: a title equal to a key name is not misread", () => {
  const m = parseBusctlMetadata('a{sv} 2 "xesam:title" s "xesam:artist" "xesam:artist" as 1 "Real"');
  assert.equal(m.title, "xesam:artist");
  assert.deepEqual(m.artists, ["Real"]);
});

test("parseBusctlMetadata: garbage input does not throw", () => {
  assert.doesNotThrow(() => parseBusctlMetadata(""));
  assert.doesNotThrow(() => parseBusctlMetadata("Failed to get property"));
});

test("buildPlayerState: assembles state, lookup and display fields", () => {
  const s = buildPlayerState("org.mpris.MediaPlayer2.spotify", 's "Playing"', "x 12500000", META);
  assert.equal(s.status, "Playing");
  assert.equal(s.position, 12.5);
  assert.equal(s.playerName, "spotify");
  assert.equal(s.title, "Song");
  assert.equal(s.artist, "Artist One, Artist Two");
  assert.deepEqual(s.lookup.artists, ["Artist One", "Artist Two"]);
  assert.equal(s.lookup.duration, 225);
});

test("buildPlayerState: YouTube 'Artist - Title' uses the title's artist for lookup", () => {
  const meta = 'a{sv} 2 "xesam:title" s "Coldplay - Yellow" "xesam:artist" as 1 "Some Channel"';
  const s = buildPlayerState("org.mpris.MediaPlayer2.chromium.instance1", 's "Playing"', "x 0", meta);
  assert.equal(s.title, "Yellow");
  assert.equal(s.artist, "Coldplay");
  assert.deepEqual(s.lookup.artists, ["Coldplay"]);
});

test("buildPlayerState: no metadata falls back to display placeholders", () => {
  const s = buildPlayerState("org.mpris.MediaPlayer2.vlc", "", "", "");
  assert.equal(s.title, "Unknown Track");
  assert.equal(s.artist, "Unknown Artist");
  assert.equal(s.status, "Stopped");
});

test("buildGenericPlayerState: handles comma-separated artists and formats lookup", () => {
  const s = buildGenericPlayerState({
    player: "darwin:spotify",
    playerName: "spotify",
    status: "Playing",
    position: 45.5,
    duration: 210,
    rawTitle: "My Universe",
    rawArtist: "Coldplay, BTS",
    album: "Music of the Spheres",
    artUrl: "https://example.com/cover.jpg"
  });
  assert.equal(s.title, "My Universe");
  assert.equal(s.artist, "Coldplay, BTS");
  assert.deepEqual(s.lookup.artists, ["Coldplay, BTS", "Coldplay", "BTS"]);
  assert.equal(s.lookup.duration, 210);
  assert.equal(s.position, 45.5);
  assert.equal(s.status, "Playing");
});

test("isValidPlayerName: only well-formed MPRIS names are accepted", () => {
  assert.equal(isValidPlayerName("org.mpris.MediaPlayer2.spotify"), true);
  assert.equal(isValidPlayerName("org.mpris.MediaPlayer2.chromium.instance123"), true);
  assert.equal(isValidPlayerName('org.mpris.MediaPlayer2.x"; rm -rf ~; "'), false);
  assert.equal(isValidPlayerName("something.else"), false);
  assert.equal(isValidPlayerName(undefined), false);
});

test("cleanTrackInfo: 'Artist - Title' when the channel name is not the artist", () => {
  const r = cleanTrackInfo("Coldplay - Yellow", "Some Channel");
  assert.equal(r.title, "Yellow");
  assert.equal(r.artist, "Coldplay");
  assert.equal(r.artistFromTitle, true);
  // while a tag-like suffix is still treated as a suffix
  const s = cleanTrackInfo("Yellow - Live at Wembley", "Coldplay");
  assert.equal(s.artist, "Coldplay");
  assert.equal(s.artistFromTitle, false);
  assert.equal(s.titleVariants[1], "Yellow");
});

test("controller: retry delay backs off after repeated failures", async () => {
  let now = 0;
  let attempts = 0;
  const c = new LyricsController({ fetchLyrics: async () => { attempts++; throw new Error("down"); }, now: () => now, retryAfterMs: 1000 });
  c.update(mkState("A"));
  await tick();
  assert.equal(c.retryAt, 1000);
  now = 1000;
  c.update(mkState("A"));
  await tick();
  assert.equal(c.retryAt, 1000 + 2000);
  assert.equal(attempts, 2);
});

test("buildGenericPlayerState: handles Apple Music macOS format with exact seconds duration", () => {
  const s = buildGenericPlayerState({
    player: "darwin:music",
    playerName: "music",
    status: "Playing",
    position: 42.8,
    duration: 215.5,
    rawTitle: "Viva La Vida",
    rawArtist: "Coldplay",
    album: "Viva La Vida or Death and All His Friends",
    artUrl: ""
  });
  assert.equal(s.player, "darwin:music");
  assert.equal(s.playerName, "music");
  assert.equal(s.title, "Viva La Vida");
  assert.equal(s.artist, "Coldplay");
  assert.equal(s.position, 42.8);
  assert.equal(s.duration, 215.5);
  assert.equal(s.lookup.duration, 215.5);
  assert.equal(s.status, "Playing");
});

test("buildGenericPlayerState: handles Windows SMTC format with fractional live position", () => {
  const s = buildGenericPlayerState({
    player: "win32:Spotify.exe",
    playerName: "spotify",
    status: "Playing",
    position: 88.4,
    duration: 240.0,
    rawTitle: "Starboy",
    rawArtist: "The Weeknd, Daft Punk",
    album: "Starboy",
    artUrl: ""
  });
  assert.equal(s.player, "win32:Spotify.exe");
  assert.equal(s.playerName, "spotify");
  assert.equal(s.title, "Starboy");
  assert.equal(s.artist, "The Weeknd, Daft Punk");
  assert.equal(s.position, 88.4);
  assert.equal(s.duration, 240);
  assert.equal(s.status, "Playing");
  assert.deepEqual(s.lookup.artists, ["The Weeknd, Daft Punk", "The Weeknd", "Daft Punk"]);
});

