/// <reference path="./kino.d.ts" />
// Kino plugin: Megadede.
// Port of the CloudStream provider "MegadedeProvider" (megadede.mobi): movies, series and anime in Spanish.
// Home: one row per list (Películas, Series, Animes). Search, series with seasons and episodes.
//
// The site shows the video through embedded players. Every page lists some servers directly
// (changeServer('...')) and one "/vidurl/" page (Embed69) that hides the real links behind a small
// proof-of-work and AES encryption. resolve() reads both, picks the best language (LAT > ESP > SUB),
// tries the fast direct resolvers first (StreamWish, Vidhide, Voe...), then Kino's hidden browser
// (kino.browser.capture), and lists the remaining servers as labelled lazy copies.
//
// Refs: movie "mg:/pelicula/slug-xxxx"  series "mg:/serie/slug-xxxx" or "mg:/anime/slug-xxxx"
//       episode "mg:/serie/slug-xxxx/temporada/1/capitulo/2"
//       server "srv:<n>:<ref>" (a lazy copy: server number n of that page)
//       rows "list:peliculas" "list:series" "list:animes"

const SITE = { key: "mg", name: "Megadede", base: "https://megadede.mobi" };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36";
const PAGE_LIMIT = 60;
const CAPTURE_MS = 20000;
const MAX_ATTEMPTS = 3; // servers tried inside one resolve; the others become lazy copies
const SOFT_DEADLINE_MS = 45000; // stop starting new attempts after this (resolve has 75 s)
const POW_MS = 12000; // budget for Embed69's proof-of-work
const SERVER_CACHE_MS = 15 * 60 * 1000; // the server list of a page is kept this long (so lazy copies are instant)
const EPISODE_META_MAX = 30; // series with more episodes than this don't fetch each episode's page
const EPISODE_META_CHUNK = 6;
const EPISODE_META_MS = 10000;
const LANG_ORDER = ["LAT", "ESP", "SUB"]; // best language first

const LISTS = {
  peliculas: { path: "/peliculas", es: "Películas", en: "Movies", genre: "peliculas" },
  series: { path: "/series", es: "Series", en: "Series", genre: "series" },
  animes: { path: "/animes", es: "Animes", en: "Anime", genre: "anime" },
};

const HDR = { headers: { Referer: SITE.base } };

function log(...args) {
  try {
    kino.log(...args);
  } catch {
    // the line is lost, the result is not
  }
}

function isEnglish() {
  try {
    return String(kino.lang || "").toLowerCase().startsWith("en");
  } catch {
    return false;
  }
}
const say = (es, en) => (isEnglish() ? en : es);

// ---------- text helpers ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return String(s == null ? "" : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}
function text(html) {
  return decode(String(html == null ? "" : html).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function first(re, s) {
  const m = re.exec(s);
  return m ? m[1] : "";
}
function safeId(s) {
  return String(s).replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 120);
}

// "/path" or "https://host/path?x" -> "/path?x"
function pathOf(href) {
  const h = decode(href).trim();
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      return u.pathname + u.search;
    } catch {
      return h;
    }
  }
  return h.startsWith("/") ? h : "/" + h;
}
function abs(site, src) {
  const s = decode(src).trim();
  if (!s) return undefined;
  if (s.startsWith("//")) return "https:" + s;
  if (/^https?:\/\//i.test(s)) return s;
  return site.base + (s.startsWith("/") ? s : "/" + s);
}
// Throws only AFTER its first await: before it, a throw can't be caught by the caller on Kino 0.9.49 and older.
async function getPage(site, path, options) {
  const url = /^https?:/i.test(path) ? path : site.base + path;
  const r = await kino.fetch(url, options);
  if (!r.ok) {
    throw kino.error(r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "unavailable", site.name + " respondió " + r.status);
  }
  return r.text();
}

// ---------- cards ----------

// "Ver Saint Maud - Ver online gratis" -> "Saint Maud"
function cleanTitle(s) {
  return text(s)
    .replace(/^Ver\s+/i, "")
    .replace(/\s+-\s+Ver online.*$/i, "")
    .replace(/\s+\(\d{4}\)\s+online.*$/i, "")
    .trim();
}

// <article class="... mv ..."> with a link to /pelicula/x, /serie/x or /anime/x, an image and a heading.
function megaCards(html) {
  const out = [];
  const seen = new Set();
  const re = /<article[^>]*class=["'][^"']*mv[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html))) {
    const b = m[1];
    let path = "";
    const hre = /href=["']([^"']+)["']/gi;
    let h;
    while ((h = hre.exec(b))) {
      const p = pathOf(h[1]).split(/[?#]/)[0];
      if (/^\/(?:pelicula|serie|anime)\/[^/]+/i.test(p)) {
        path = p;
        break;
      }
    }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const kindKey = /^\/(pelicula|serie|anime)\//i.exec(path)[1].toLowerCase();
    const imgTag = (/<img[^>]+>/i.exec(b) || [""])[0];
    const dataSrc = first(/\sdata-src=["']([^"']+)["']/i, imgTag);
    const src = first(/\ssrc=["']([^"']+)["']/i, imgTag);
    const poster = abs(SITE, dataSrc || src);
    const heading = text(first(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i, b));
    const title = heading || cleanTitle(first(/\stitle=["']([^"']+)["']/i, imgTag) || first(/\salt=["']([^"']+)["']/i, imgTag));
    if (!title) continue;
    out.push({ path, kindKey, title, poster: poster && /^https?:\/\//i.test(poster) ? poster : undefined });
  }
  return out;
}

function mgItem(c) {
  const item = {
    id: safeId(c.path.replace(/^\//, "").replace(/\//g, "-")),
    ref: "mg:" + c.path,
    title: c.title.slice(0, 200),
    kind: c.kindKey === "pelicula" ? "movie" : "series",
  };
  if (c.poster) item.poster = c.poster;
  if (c.kindKey === "anime") item.badges = ["Anime"];
  return item;
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

async function safe(name, fn) {
  try {
    return await fn();
  } catch (e) {
    log("fila " + name + " falló: " + (e && e.message ? e.message : e));
    return null;
  }
}

// ---------- rows ----------

async function listPage(key, cursor) {
  const list = LISTS[key];
  if (!list) throw kino.error("not_found", "fila desconocida");
  const page = Math.max(1, Math.floor(Number(cursor)) || 1);
  const html = await getPage(SITE, list.path + (page > 1 ? "?page=" + page : ""), HDR);
  const items = unique(megaCards(html).map(mgItem)).slice(0, 100);
  const hasNext = new RegExp("page=" + (page + 1) + "(?![0-9])").test(html);
  return { items, next: hasNext && items.length ? String(page + 1) : undefined };
}

export async function home() {
  await null;
  const keys = Object.keys(LISTS);
  const lists = await Promise.all(keys.map((k) => safe(k, async () => (await listPage(k, null)).items.slice(0, PAGE_LIMIT))));
  const rows = keys.map((k, i) => ({
    id: "list-" + k,
    title: say(LISTS[k].es, LISTS[k].en),
    items: lists[i],
    ref: "list:" + k,
    genre: LISTS[k].genre,
  }));
  return rows.filter((r) => r.items && r.items.length);
}

export async function browse(ref, cursor) {
  await null;
  const m = /^list:(\w+)$/.exec(String(ref));
  if (!m) throw kino.error("not_found", "fila desconocida");
  return listPage(m[1], cursor);
}

// ---------- search ----------

export async function search(query) {
  await null;
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const html = await getPage(SITE, "/search?s=" + encodeURIComponent(q), HDR);
  return unique(megaCards(html).map(mgItem)).slice(0, 100);
}

// ---------- episodes ----------

function pathFromRef(ref) {
  const m = /^mg:(\/.*)$/.exec(String(ref));
  return m ? m[1] : "";
}

const RX_META_DESC = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i;
const RX_OG_IMAGE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;

export async function episodes(ref) {
  await null;
  const path = pathFromRef(ref);
  if (!path) throw kino.error("not_found", "ref desconocido");
  const html = await getPage(SITE, path, HDR);

  const title = text(first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html)) || undefined;
  const poster = abs(SITE, first(RX_OG_IMAGE, html));
  const yearText = (/\b((?:19|20)\d{2})\b/.exec(html) || [])[1];
  const overview =
    text(first(RX_META_DESC, html)) ||
    text(first(/<h2[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i, html)) ||
    undefined;

  const found = [];
  const re = /href\s*=\s*["']([^"']*\/temporada\/(\d+)\/capitulo\/(\d+)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) found.push({ path: pathOf(m[1]).split(/[?#]/)[0], season: Number(m[2]), number: Number(m[3]) });

  const uniq = [];
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.path) || !(f.season >= 1) || !(f.number >= 1)) continue;
    seen.add(f.path);
    uniq.push(f);
  }
  uniq.sort((a, b) => a.season - b.season || a.number - b.number);

  // Each episode's own page has a picture and a synopsis. Only for short series, with a time limit.
  const meta = new Map();
  if (found.length <= EPISODE_META_MAX) {
    const deadline = Date.now() + EPISODE_META_MS;
    for (let i = 0; i < uniq.length && Date.now() < deadline; i += EPISODE_META_CHUNK) {
      await Promise.all(
        uniq.slice(i, i + EPISODE_META_CHUNK).map(async (f) => {
          try {
            const r = await kino.fetch(SITE.base + f.path, { timeoutMs: 8000 });
            if (!r.ok) return;
            const eh = r.text();
            const desc = text(first(RX_META_DESC, eh));
            meta.set(f.path, {
              still: abs(SITE, first(RX_OG_IMAGE, eh)),
              overview: desc && !/^No se encontró una sinopsis/i.test(desc) ? desc.slice(0, 1000) : undefined,
            });
          } catch {
            // that episode keeps the series picture
          }
        })
      );
    }
  }

  const list = uniq.map((f) => {
    const e = meta.get(f.path) || {};
    const ep = { number: f.number, season: f.season, ref: "mg:" + f.path, title: "Episodio " + f.number };
    const still = e.still || poster;
    if (still) ep.still = still;
    if (e.overview) ep.overview = e.overview;
    return ep;
  });

  const series = { title, overview: overview ? overview.slice(0, 1000) : undefined };
  if (poster) {
    series.poster = poster;
    series.backdrop = poster;
  }
  if (yearText) series.year = Number(yearText);
  return { series, episodes: list };
}

// ---------- servers ----------

const SERVER_LABELS = { vidhide: "Vidhide", streamwish: "Streamwish", voe: "Voe", filemoon: "Filemoon" };

// "VidHide" / "vidhidepro.com" -> "vidhide"; used to pick the right resolver.
function serverKey(name) {
  const n = String(name || "").toLowerCase();
  if (/voe/.test(n)) return "voe";
  if (/vidhide|vhide/.test(n)) return "vidhide";
  // Megadede's StreamWish links often arrive through hglink.to rather than a
  // hostname containing "wish"; classify the alias by the server name/host.
  if (/stream.?wish|embedwish|hglink|hlswish|wish/.test(n)) return "streamwish";
  if (/filemoon|fmoon|byse/.test(n)) return "filemoon";
  return n;
}

function langLabel(lang) {
  const l = String(lang || "").toUpperCase();
  return l === "LAT" ? "lat" : l === "SUB" ? "sub" : l === "ESP" ? "esp" : l.toLowerCase();
}

function displayLabel(server) {
  const key = serverKey(server.name);
  const base = SERVER_LABELS[key] || String(server.name || "Servidor");
  return (base + " " + langLabel(server.lang)).trim();
}

// Fast direct resolvers first (plain HTTP), the heavy ones (Voe's proof-of-work, Filemoon) later.
function priority(key) {
  return key === "streamwish" ? 0 : key === "vidhide" ? 1 : key === "voe" ? 2 : key === "filemoon" ? 4 : 3;
}

function orderServers(raw) {
  return raw
    .map((s, index) => {
      const lr = LANG_ORDER.indexOf(String(s.lang || "").toUpperCase());
      return { name: s.name, lang: s.lang || "", url: s.url, key: serverKey(s.name), index, langRank: lr < 0 ? LANG_ORDER.length : lr };
    })
    .sort((a, b) => a.langRank - b.langRank || priority(a.key) - priority(b.key) || a.index - b.index);
}

function b64ToHex(b64) {
  const raw = atob(String(b64).replace(/\s+/g, ""));
  let out = "";
  for (let i = 0; i < raw.length; i++) out += raw.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

function solveEmbedPow(challenge, difficulty) {
  const prefix = "0".repeat(difficulty);
  const started = Date.now();
  for (let nonce = 0; nonce < 50000000; nonce++) {
    if (kino.crypto.hash("sha256", challenge + nonce).startsWith(prefix)) return nonce;
    if ((nonce & 255) === 255 && Date.now() - started > POW_MS) return -1;
  }
  return -1;
}

// Embed69 (the "/vidurl/" page): a proof-of-work gives the AES key that opens each server's link.
async function embed69Servers(vidUrl) {
  let r;
  try {
    r = await kino.fetch(vidUrl, { headers: { Referer: SITE.base + "/", "User-Agent": UA }, timeoutMs: 12000 });
  } catch (e) {
    log("Embed69: no se pudo abrir (" + String((e && (e.code || e.message)) || e).slice(0, 60) + ")");
    return [];
  }
  if (!r.ok) {
    log("Embed69: respondió HTTP " + r.status);
    return [];
  }
  const html = r.text();
  const challenge = first(/POW_CHALLENGE\s*=\s*['"]([^'"]+)['"]/i, html);
  const salt = first(/POW_SALT\s*=\s*['"]([^'"]+)['"]/i, html);
  const dataText = first(/let\s+dataLink\s*=\s*(\[[\s\S]*?\]);/i, html);
  if (!challenge || !salt || !dataText) {
    log("Embed69: la página no trae el desafío o los links");
    return [];
  }
  const diffRaw = Number(first(/POW_DIFFICULTY\s*=\s*(\d+)/i, html));
  const difficulty = diffRaw ? diffRaw : 3;
  if (difficulty > 6) {
    log("Embed69: dificultad " + difficulty + " demasiado alta para resolverla aquí");
    return [];
  }
  const nonce = solveEmbedPow(challenge, difficulty);
  if (nonce < 0) {
    log("Embed69: no se resolvió el desafío a tiempo");
    return [];
  }
  const keyHex = kino.crypto.hash("sha256", challenge + nonce + salt);

  let data;
  try {
    data = JSON.parse(dataText);
  } catch {
    log("Embed69: dataLink no es JSON");
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(data) ? data : []) {
    const lang = String((item && item.video_language) || "UNK").toUpperCase();
    for (const embed of (item && item.sortedEmbeds) || []) {
      const name = String((embed && embed.servername) || "");
      const enc = String((embed && embed.link) || "");
      if (!name || !enc || seen.has(name.toLowerCase() + "|" + lang)) continue;
      seen.add(name.toLowerCase() + "|" + lang);
      let url = "";
      try {
        const hex = b64ToHex(enc);
        if (hex.length <= 32) continue;
        url = kino.crypto.decrypt("aes-256-cbc", {
          key: keyHex, keyEncoding: "hex",
          iv: hex.slice(0, 32), ivEncoding: "hex",
          data: hex.slice(32), inputEncoding: "hex",
          outputEncoding: "utf8",
        }).trim();
      } catch {
        log("Embed69: no se pudo descifrar " + name + "/" + lang);
        continue;
      }
      if (/^https:\/\//i.test(url)) out.push({ name, lang, url });
    }
  }
  return out;
}

// Every server of a page: the changeServer('...') buttons plus Embed69's. Kept for a while so that
// choosing another server later doesn't repeat the proof-of-work.
async function collectServers(path) {
  const cacheKey = "srv:v3:" + path;
  try {
    const cached = JSON.parse(kino.storage.get(cacheKey) || "null");
    if (Array.isArray(cached) && cached.length) return cached;
  } catch {
    // no cache
  }
  const html = await getPage(SITE, path, HDR);
  const urls = [];
  const add = (u) => {
    const full = abs(SITE, u);
    if (full && !urls.includes(full)) urls.push(full);
  };
  const re = /changeServer\(\s*['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(html))) add(m[1]);
  // The site has used both src and data-src, with different iframe attribute orders.
  const vid = first(/<(?:iframe|embed)\b[^>]*(?:src|data-src)\s*=\s*["']([^"']*\/vidurl\/[^"']+)["'][^>]*>/i, html)
    || first(/(?:src|data-src)\s*=\s*["']([^"']*\/vidurl\/[^"']+)["']/i, html);
  if (vid) add(vid);

  const servers = [];
  let embed69Count = 0;
  for (const u of urls) {
    if (/\/vidurl\//i.test(u)) {
      const expanded = await embed69Servers(u);
      embed69Count += expanded.length;
      for (const s of expanded) servers.push(s);
      continue;
    }
    let host = "";
    try {
      host = new URL(u).hostname.replace(/^www\./i, "");
    } catch {
      continue;
    }
    // embed69.org is the intermediary player page, not a video host.
    // Its actual providers are extracted from the /vidurl/ page above.
    if (host === "embed69.org" || host.endsWith(".embed69.org")) {
      log("Embed69: se omite la página del reproductor como servidor independiente");
      continue;
    }
    if (/^https:\/\//i.test(u)) servers.push({ name: host, lang: "", url: u });
  }
  if (servers.length) {
    try {
      kino.storage.set(cacheKey, JSON.stringify(servers), { ttlMs: SERVER_CACHE_MS });
    } catch {
      // the list just isn't kept
    }
  }
  log("servidores detectados: " + servers.length + " total; " + embed69Count + " desde Embed69");
  return servers;
}

// Opens one player in the hidden browser and returns the video it requested, or null.
async function capture(server) {
  const embed = server.url;
  if (!/^https:\/\//i.test(embed)) return null;
  const label = displayLabel(server);
  log("servidor " + label + ": iniciando resolución HTTP directa (host=" + (() => { try { return new URL(embed).hostname; } catch { return "URL inválida"; } })() + ", clave=" + String(server.key || "") + ")");
  const manual = await resolveManual(embed, SITE, label, server.key);
  if (manual) {
    log("servidor " + label + ": resolución directa completada; no se abre navegador");
    return manual;
  }
  log("servidor " + label + ": resolución directa no obtuvo URL; evalúo fallback");
  try {
    const host = new URL(embed).hostname.toLowerCase();
    if (server.key === "voe" || host === "voe.sx" || host.endsWith(".voe.sx") || host === "voe.to" || host.endsWith(".voe.to")) {
      log("servidor " + label + ": se omite navegador; falta resolver Voe por HTTP");
      return null;
    }
    if (host === "strp2p.com" || host.endsWith(".strp2p.com")) {
      log("servidor " + label + ": sp2p omite captura de navegador");
      return null;
    }
  } catch {}
  let res;
  try {
    res = await kino.browser.capture(embed, { timeoutMs: CAPTURE_MS, headers: { Referer: SITE.base + "/" } });
  } catch (e) {
    log("servidor " + label + ": " + ((e && e.code) || "error") + " al abrir el reproductor");
    return null;
  }
  const media = (res && res.media) || [];
  const pick = media.find((x) => /\.m3u8|mpegurl/i.test(x.url + " " + (x.mime || ""))) || media[0];
  if (!pick) {
    log("servidor " + label + ": no se vio ningún video");
    return null;
  }
  const hls = /\.m3u8|mpegurl/i.test(pick.url + " " + (pick.mime || ""));
  const stream = { url: pick.url, headers: pick.headers || {}, label: (label + " · " + SITE.name).slice(0, 48) };
  stream.mime = hls ? "application/x-mpegURL" : pick.mime && /^[a-z]+\/[\w.+-]+$/i.test(pick.mime) ? pick.mime : undefined;
  if (!stream.mime) delete stream.mime;
  return stream;
}

export async function resolve(ref) {
  await null;
  const lazy = /^srv:(\d+):(mg:\/.*)$/.exec(String(ref));
  const epRef = lazy ? lazy[2] : String(ref);
  const path = pathFromRef(epRef);
  if (!path) throw kino.error("not_found", "ref desconocido");
  const started = Date.now();
  const servers = orderServers(await collectServers(path));
  if (!servers.length) throw kino.error("not_found", "la página no tiene servidores");

  if (lazy) {
    const server = servers[Number(lazy[1])];
    const s = server ? await capture(server) : null;
    if (!s) throw failure();
    return s;
  }

  let stream = null;
  let tried = 0;
  const left = [];
  for (let i = 0; i < servers.length; i++) {
    if (stream || tried >= MAX_ATTEMPTS || Date.now() - started > SOFT_DEADLINE_MS) {
      left.push(i);
      continue;
    }
    tried++;
    const s = await capture(servers[i]);
    if (s) stream = s;
  }
  if (!stream) throw failure();
  const alternatives = left.slice(0, 8).map((i) => ({ label: displayLabel(servers[i]).slice(0, 48), ref: "srv:" + i + ":" + epRef }));
  if (alternatives.length) stream.alternatives = alternatives;
  return stream;
}

function failure() {
  return kino.error("unavailable", "ningún servidor dio video", {
    userMessage: say(
      "No se pudo abrir ningún servidor de este título. Prueba otro servidor o inténtalo más tarde.",
      "No server of this title could be opened. Try another server or try again later."
    ),
  });
}


// ---------- servers ----------

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function toBase(n, base) {
  return (n < base ? "" : toBase(Math.floor(n / base), base)) + ALPHABET[n % base];
}

// Undoes Dean Edwards' p.a.c.k.e.r (eval(function(p,a,c,k,e,d){...}('payload',base,count,'w1|w2'.split('|')))
// without running anything: it is only a table of words.
function unpackAll(html) {
  const out = [];
  const re = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  let m;
  while ((m = re.exec(html))) {
    const unesc = (s) => s.replace(/\\(['"\\])/g, "$1");
    const payload = unesc(m[1]);
    const base = Number(m[2]);
    const count = Number(m[3]);
    const words = unesc(m[4]).split("|");
    if (!(base >= 2 && base <= 62)) continue;
    const dict = new Map();
    for (let i = count - 1; i >= 0; i--) {
      const key = toBase(i, base);
      dict.set(key, words[i] || key);
    }
    out.push(payload.replace(/\b\w+\b/g, (w) => (dict.has(w) ? dict.get(w) : w)));
  }
  return out;
}
// Manual resolvers for the common embeds. These run before browser capture so the app
// does not need to execute the player's JavaScript for hosts whose stream URL is exposed by HTTP.
function unescapePlayerText(raw) {
  return String(raw || "")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/\\+u0026/gi, "&").replace(/\\+u003d/gi, "=")
    .replace(/\\+(?:\/|u002f)/gi, "/").replace(/\\+"/g, '"');
}
function directStream(url, label, referer, mime) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { url, label: String(label).slice(0, 48), headers: referer ? { Referer: referer } : {}, mime: mime || (/\.m3u8(?:$|[?#])/i.test(url) ? "application/x-mpegURL" : undefined) };
}
function decodeBase64Text(value) {
  try {
    const raw = atob(value);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
function decodeVoeConfig(encoded) {
  try {
    let value = String(encoded).replace(/[A-Za-z]/g, (c) => {
      const base = c <= "Z" ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
    for (const separator of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) value = value.split(separator).join("_");
    value = value.replace(/_/g, "");
    let bytes = Uint8Array.from(atob(value), (c) => (c.charCodeAt(0) - 3 + 256) & 255);
    bytes = bytes.reverse();
    return decodeBase64Text(String.fromCharCode(...bytes));
  } catch {
    return "";
  }
}
function parseOkruPlayerOptions(html) {
  const tags = String(html || "").match(/<[^>]+\bdata-options\s*=\s*(?:"[\s\S]*?"|'[\s\S]*?')[^>]*>/gi) || [];
  for (const tag of tags) {
    const m = /\bdata-options\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
    if (!m) continue;
    const raw = decode(m[2]).replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/\\+\"/g, '"');
    try { return JSON.parse(raw); } catch {}
    try { return JSON.parse(decode(raw)); } catch {}
  }
  return null;
}

async function resolveRumbleDirect(embedUrl, site, label, userAgent) {
  let parsed;
  try { parsed = new URL(embedUrl); } catch { return null; }
  const id = (parsed.pathname.match(/\/embed\/([a-z0-9_-]+)/i) || parsed.pathname.match(/\/v([a-z0-9_-]+)\/?$/i) || [])[1];
  if (!id) return null;
  const apiUrl = "https://rumble.com/embedJS/u3/?request=video&ver=2&v=" + encodeURIComponent(id);
  const r = await kino.fetch(apiUrl, {
    headers: { Accept: "application/json,text/plain,*/*", Referer: embedUrl, "User-Agent": userAgent },
    timeoutMs: 9000
  });
  if (!r.ok) {
    log("servidor " + label + ": API de Rumble respondió HTTP " + r.status);
    return null;
  }
  let data;
  try { data = r.json(); } catch { try { data = JSON.parse(r.text()); } catch {
    log("servidor " + label + ": respuesta JSON inválida de Rumble");
    return null;
  } }
  const candidates = [];
  const shape = [];
  const noteShape = (node, path, depth) => {
    if (depth > 4 || node == null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const next = path ? path + "." + key : key;
      if (/(?:hls|mp4|webm|url|stream|ua)/i.test(key)) shape.push(next + ":" + (Array.isArray(value) ? "array" : value === null ? "null" : typeof value));
      if (shape.length < 35 && typeof value === "object") noteShape(value, next, depth + 1);
      if (shape.length >= 35) return;
    }
  };
  noteShape(data, "", 0);
  // Rumble nests stream URLs under ua.hls.url / ua.mp4.<quality>.url.
  // Preserve the parent format hint while descending; otherwise the leaf key
  // is only "url" and a valid stream is incorrectly discarded.
  const walk = (node, key, depth, inheritedHint) => {
    if (depth > 12 || node == null) return;
    const ownHint = String(key || "").toLowerCase();
    const hint = /(?:^|[^a-z])(hls|m3u8|mpegurl|mp4|webm)(?:$|[^a-z])/.test(ownHint) ? ownHint : String(inheritedHint || "").toLowerCase();
    if (typeof node === "string") {
      const value = unescapePlayerText(node).trim();
      if (!/^https?:\/\//i.test(value)) return;
      const hls = /hls|m3u8|mpegurl/.test(hint) || /\.m3u8(?:[?#]|$)/i.test(value);
      const webm = /webm/.test(hint) || /\.webm(?:[?#]|$)/i.test(value);
      const mp4 = /mp4/.test(hint) || /\.mp4(?:[?#]|$)/i.test(value);
      if (hls || mp4 || webm) {
        const quality = /(?:^|\D)(2160|1440|1080|720|480|360|240)(?:\D|$)/.exec(hint + " " + value);
        candidates.push({ url: value, type: hls ? "hls" : webm ? "webm" : "mp4", quality: quality ? Number(quality[1]) : 0 });
      }
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, key, depth + 1, hint); return; }
    if (typeof node === "object") {
      for (const [childKey, value] of Object.entries(node)) walk(value, childKey, depth + 1, hint);
    }
  };
  walk(data, "", 0, "");
  const uniqueCandidates = candidates.filter((item, index, all) => all.findIndex((x) => x.url === item.url) === index);
  uniqueCandidates.sort((a, b) => {
    const rank = (x) => x.type === "hls" ? 0 : x.type === "mp4" ? 1 : 2;
    return rank(a) - rank(b) || b.quality - a.quality;
  });
  const chosen = uniqueCandidates[0];
  if (!chosen) {
    log("servidor " + label + ": la API de Rumble no expuso una URL HLS/MP4/WebM reconocible; estructura=" + JSON.stringify(shape).slice(0, 900));
    return null;
  }
  const mime = chosen.type === "hls" ? "application/x-mpegURL" : chosen.type === "webm" ? "video/webm" : "video/mp4";
  log("servidor " + label + ": fuente de Rumble resuelta directamente (" + chosen.type.toUpperCase() + ")");
  return directStream(chosen.url, label + " · " + site.name, embedUrl, mime);
}

// Extract HLS/MP4/DASH URLs from ordinary HTML or packed player scripts without a browser.
function findDirectMedia(html) {
  const candidates = [];
  const seen = new Set();
  const add = (text) => {
    const clean = unescapePlayerText(text).replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
    const re = /https?:\/\/[^"'<>\\\s]+?\.(?:m3u8|mp4|mpd)(?:\?[^"'<>\\\s]*)?/gi;
    let m;
    while ((m = re.exec(clean))) {
      const raw = m[0].replace(/[),;]+$/, "");
      try {
        const u = new URL(raw);
        if (u.protocol !== "https:" || seen.has(u.href)) continue;
        seen.add(u.href);
        const path = u.pathname.toLowerCase();
        const hls = /\.m3u8(?:$|\?)/i.test(u.href);
        const dash = /\.mpd(?:$|\?)/i.test(u.href);
        // Prefer a master playlist when the page exposes multiple media URLs.
        const score = (hls ? 30 : dash ? 10 : 0) +
          (/master|master_playlist|playlist_master/i.test(path) ? 100 : 0) +
          (/index|playlist|manifest/i.test(path) ? 15 : 0);
        candidates.push({ url: u.href, hls, dash, score });
      } catch {}
    }
  };
  add(String(html || ""));
  for (const unpacked of unpackAll(String(html || ""))) add(unpacked);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

// sp2p's API returns an AES-CBC encrypted hex payload. This validated path is for
// the current HTTPS embed format with an empty URL fragment; anything else keeps the
// existing static extraction + hidden-browser fallback.
async function resolveSp2pApi(embed, site, label, headers) {
  let pageUrl, id = "";
  try {
    pageUrl = new URL(embed);
    if (pageUrl.protocol !== "https:") {
      log("servidor " + label + ": sp2p requiere HTTPS");
      return null;
    }
    // sp2p puts the video ID in the iframe fragment, e.g. #tu8i1l.
    id = pageUrl.hash.slice(1).split("&")[0].trim();
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) {
      for (const key of ["id", "videoId", "video_id", "videoID", "v"]) {
        const value = pageUrl.searchParams.get(key) || "";
        if (/^[A-Za-z0-9_-]{3,80}$/.test(value)) { id = value; break; }
      }
    }
  } catch {
    log("servidor " + label + ": URL sp2p inválida");
    return null;
  }
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) {
    log("servidor " + label + ": no se encontró el ID sp2p en el hash ni en los parámetros");
    return null;
  }

  const origin = pageUrl.origin;
  let referrerHost = "";
  try { referrerHost = new URL(site.base).hostname.replace(/^www\./i, ""); } catch {}
  if (!referrerHost) {
    log("servidor " + label + ": no pude determinar el sitio de origen para sp2p");
    return null;
  }

  // The API validates these parameters. Match the player request and do not send
  // an Origin header: the endpoint rejects that header in direct HTTP requests.
  const apiUrl = origin + "/api/v1/video?id=" + encodeURIComponent(id) +
    "&w=1280&h=720&r=" + encodeURIComponent(referrerHost);
  let response;
  try {
    response = await kino.fetch(apiUrl, {
      headers: {
        "User-Agent": headers["User-Agent"],
        Accept: "text/plain, */*",
        Referer: origin + "/"
      },
      timeoutMs: 9000
    });
  } catch (e) {
    log("servidor " + label + ": error consultando la API sp2p");
    return null;
  }
  if (!response.ok) {
    log("servidor " + label + ": API sp2p respondió HTTP " + response.status);
    return null;
  }

  const encrypted = String(response.text() || "").trim();
  if (!/^(?:[0-9a-f]{2}){16,}$/i.test(encrypted)) {
    log("servidor " + label + ": respuesta cifrada sp2p no reconocida");
    return null;
  }

  let data;
  try {
    const plaintext = kino.crypto.decrypt("aes-128-cbc", {
      key: "kiemtienmua911ca",
      iv: "1234567890oiuytr",
      data: encrypted,
      inputEncoding: "hex",
      outputEncoding: "utf8",
      keyEncoding: "utf8",
      ivEncoding: "utf8"
    });
    data = JSON.parse(plaintext);
  } catch (e) {
    log("servidor " + label + ": no pude descifrar la respuesta sp2p");
    return null;
  }

  const candidates = [];
  const addCandidate = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    let url;
    try { url = new URL(value, origin).href; } catch { return; }
    if (!/^https:\/\//i.test(url) || !/\.m3u8(?:$|[?#])/i.test(url)) return;
    if (!candidates.some((item) => item.url === url)) candidates.push({ url, label: itemLabel(url) });
  };
  const itemLabel = (value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host.includes("tiktokcdn")) return "TikTok CDN";
      if (host === new URL(origin).hostname && /\/v4\/pl\//.test(new URL(value).pathname)) return "Cloudflare nativo";
      return "Fuente principal";
    } catch { return "Fuente alternativa"; }
  };

  // Prefer the native proxy manifest: it may seek/start faster than the raw edge URL.
  // Keep the raw source and CDN proxy as fallbacks in case this route is unavailable.
  addCandidate(data && data.cfNative);
  addCandidate(data && data.source);

  // hlsVideoTiktok is a path, not a complete URL. Rebuild the hlsmod proxy URL
  // from the live config so the CDN hostname and its signed query aren't stale.
  try {
    const config = typeof data.streamingConfig === "string"
      ? JSON.parse(data.streamingConfig)
      : data.streamingConfig;
    const adjust = config && config.adjust && config.adjust.Tiktok;
    const domain = String(adjust && adjust.domain || "").trim();
    let path = String(data && data.hlsVideoTiktok || "").trim();
    if (domain && path) {
      path = path.replace(/^\/hls\/?/i, "/").replace(/^\/+/, "/");
      const tiktokUrl = origin + "/hlsmod/" + domain.replace(/^\/+|\/+$/g, "") + path;
      const params = adjust && adjust.params;
      const query = params && typeof params === "object"
        ? Object.keys(params).map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]))).join("&")
        : "";
      addCandidate(tiktokUrl + (query ? (tiktokUrl.includes("?") ? "&" : "?") + query : ""));
    }
  } catch {}

  if (!candidates.length) {
    log("servidor " + label + ": la API sp2p no devolvió URLs HLS utilizables");
    return null;
  }

  // Prefer the reconstructed TikTok CDN route for this performance test.
  // Keep the other two live URLs as fallbacks.
  const sourceRank = (item) => item.label === "TikTok CDN" ? 0
    : item.label === "Cloudflare nativo" ? 1 : 2;
  candidates.sort((a, b) => sourceRank(a) - sourceRank(b));
  const selected = candidates[0];
  const stream = directStream(selected.url, label + " · " + site.name + " · sp2p", origin + "/", "application/x-mpegURL");
  if (!stream) return null;
  const streamHeaders = {
    "User-Agent": headers["User-Agent"],
    Referer: origin + "/",
    Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
  };
  stream.headers = streamHeaders;
  const alternatives = candidates.slice(1, 4).map((item) => ({
    url: item.url,
    mime: "application/x-mpegURL",
    headers: streamHeaders,
    label: (label + " · " + item.label).slice(0, 48)
  }));
  if (alternatives.length) stream.alternatives = alternatives;

  try {
    const u = new URL(selected.url);
    log("servidor " + label + ": sp2p descifrado correctamente; fuente=" + selected.label + "; HLS " + u.hostname + u.pathname.slice(0, 60) +
      (alternatives.length ? "; alternativas=" + alternatives.length : ""));
  } catch {
    log("servidor " + label + ": sp2p descifrado correctamente; HLS resuelto");
  }
  return stream;
}

// Vidhide / StreamWish players keep the playlist in the packed script as "hls4", "hls2" or "hls3".
// A relative path is completed with the CDN Megadede's players use (Vidhide) or the embed's own host.
function findHlsKeyMedia(html, embed, hint) {
  const raw = String(html || "");
  const sources = [raw].concat(unpackAll(raw)).map(unescapePlayerText);
  // Las variantes de StreamWish/VidHide cambian el nombre de la propiedad del stream.
  // Priorizar HLS y aceptar solo URLs que parezcan archivos multimedia.
  const keys = ["hls4", "hls2", "hls3", "master", "playlist", "m3u8", "hls", "file", "source", "src", "url"];
  const candidates = [];
  const seen = new Set();
  for (const key of keys) {
    const re = new RegExp("['\"]" + key + "['\"]\\s*:\\s*['\"]([^'\"]+)['\"]", "gi");
    for (const src of sources) {
      let m;
      while ((m = re.exec(src))) {
        const value = String(m[1] || "").trim();
        if (!value || /^(?:blob:|data:|javascript:)/i.test(value)) continue;
        let url;
        try {
          url = /^https?:\/\//i.test(value)
            ? new URL(value)
            : new URL(value, hint === "vidhide" ? "https://morencius.com" : embed);
        } catch { continue; }
        if (url.protocol !== "https:") continue;
        const path = url.pathname.toLowerCase();
        const hls = /\.m3u8$/i.test(path) || /^(?:hls4|hls2|hls3)$/.test(key);
        const dash = /\.mpd$/i.test(path);
        const direct = /\.(?:mp4|webm)$/i.test(path);
        if (!hls && !dash && !direct) continue;
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        const score = (hls ? 100 : dash ? 40 : 10) +
          (/master/i.test(path) ? 30 : 0) + (/playlist|index|manifest/i.test(path) ? 10 : 0);
        candidates.push({ url: url.href, hls, dash, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function resolvePageMedia(embed, site, label, headers, hint) {
  const started = Date.now();
  let response;
  try {
    response = await kino.fetch(embed, { headers: { ...headers, Referer: site.base + "/" }, timeoutMs: 9000 });
  } catch (e) {
    log("servidor " + label + ": error consultando embed (" + String(e && e.message || e).slice(0, 70) + ")");
    return null;
  }
  if (!response.ok) {
    log("servidor " + label + ": página del reproductor respondió HTTP " + response.status);
    return null;
  }
  const html = response.text();
  // Vidhide/StreamWish pack the playlist under hls4/hls2/hls3 (sometimes as a relative path).
  let media = findHlsKeyMedia(html, embed, hint) || findDirectMedia(html);
  let isSp2p = false;
  try {
    const host = new URL(embed).hostname.toLowerCase();
    isSp2p = host === "strp2p.com" || host.endsWith(".strp2p.com");
  } catch {}
  // Isolated sp2p API fast path. If it fails, preserve the original resolver behavior.
  if (!media && isSp2p) {
    const direct = await resolveSp2pApi(embed, site, label, headers, html);
    if (direct) return direct;
  }
  if (!media) {
    log("servidor " + label + ": HTML consultado directamente; no expuso URL HLS/MP4");
    return null;
  }
  const isVidHide = (() => {
    try { const h = new URL(embed).hostname.toLowerCase(); return h === "vidhidepro.com" || h.endsWith(".vidhidepro.com"); } catch { return false; }
  })() || hint === "vidhide";
  const stream = directStream(media.url, label + " · " + site.name, embed,
    media.hls ? "application/x-mpegURL" : media.dash ? "application/dash+xml" : "video/mp4");
  if (stream && isVidHide) {
    // Keep the same browser identity for VidHide's manifest and segment requests.
    stream.headers = { "User-Agent": headers["User-Agent"], Referer: embed };
  }
  let sourceHost = "host desconocido", sourcePath = "/";
  try { const u = new URL(media.url); sourceHost = u.hostname; sourcePath = u.pathname.slice(0, 80); } catch {}
  log("servidor " + label + ": URL " + (media.hls ? "HLS" : media.dash ? "DASH" : "MP4") +
    " extraída sin navegador en " + (Date.now() - started) + " ms (" + sourceHost + sourcePath + ")");
  return stream;
}

// ---------- Bysekoze / n1mwq encrypted playback API ----------
function b64urlToBytes(value) {
  const s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - s.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function bytesToB64(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(raw);
}
function b64url(value) {
  return String(value || "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function byseRotate(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}
function byseMix(a) {
  a[0] = (a[0] + a[1]) >>> 0;
  a[3] = byseRotate((a[3] ^ a[0]) >>> 0, 16);
  a[2] = (a[2] + a[3]) >>> 0;
  a[1] = byseRotate((a[1] ^ a[2]) >>> 0, 12);
  a[0] = (a[0] + a[1]) >>> 0;
  a[3] = byseRotate((a[3] ^ a[0]) >>> 0, 8);
  a[2] = (a[2] + a[3]) >>> 0;
  a[1] = byseRotate((a[1] ^ a[2]) >>> 0, 7);
}
function byseWorkHash(input) {
  const mask = 0xffffffff;
  const state = [1779033703, 3144134277, 1013904242, 2773480762];
  const memory = new Uint32Array(512);
  for (let i = 0; i < input.length; i++) {
    state[0] = byseRotate((state[0] + input.charCodeAt(i)) >>> 0, 7);
    byseMix(state);
  }
  for (let i = 0; i < 8; i++) byseMix(state);
  for (let i = 0; i < 512; i++) {
    byseMix(state);
    memory[i] = (state[0] ^ state[2]) >>> 0;
  }
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 512; i++) {
      const a = memory[i] & 511;
      let c = (memory[i] + memory[a]) >>> 0;
      c = byseRotate(c, 13);
      c = (c ^ Math.imul(memory[(i + 1) & 511], 2654435761)) >>> 0;
      memory[i] = c;
      state[0] = (state[0] ^ c) >>> 0;
      byseMix(state);
    }
  }
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    byseMix(state);
    let v = state[0] >>> 0;
    for (let j = i * 64; j < (i + 1) * 64; j++) {
      const d = memory[j];
      v = (v + d) >>> 0;
      v = byseRotate(v, 5);
      v = (v ^ Math.imul(d, 2246822519)) >>> 0;
    }
    out[i] = (v ^ state[2]) >>> 0;
  }
  return out;
}
function byseLeadingZeroBits(words) {
  let count = 0;
  for (const word of words) {
    if (word === 0) { count += 32; continue; }
    return count + Math.clz32(word);
  }
  return count;
}
async function byseSolvePow(nonce, difficulty) {
  const bits = Number(difficulty);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return null;
  if (bits <= 0) return "0";
  const start = Date.now();
  for (let counter = 0; counter < 200000 && Date.now() - start < 14000; counter++) {
    const hash = byseWorkHash(String(nonce) + ":" + counter);
    if (byseLeadingZeroBits(hash) >= bits) return String(counter);
    if ((counter & 31) === 31) await kino.sleep(0);
  }
  return null;
}
function byseFingerprint(tokenData) {
  return { token: tokenData.token, viewer_id: tokenData.viewer_id, device_id: tokenData.device_id, confidence: tokenData.confidence };
}
async function resolveBysekoze(embed, site, label, headers) {
  const inputUrl = new URL(embed);
  const code = (inputUrl.pathname.match(/\/(?:e|embed|sovm9|boh)\/([a-z0-9_-]+)/i) || [])[1];
  if (!code) return null;
  // Follow the site's redirect first: Bysekoze commonly forwards to its rotating n1mwq.org origin.
  const byseHeaders = { ...headers, "User-Agent": "Mozilla/5.0 (Linux; Android 6.0.1; SM-G5510 Build/MMB29M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.125 Mobile Safari/537.36 SamsungBrowser/7.2" };
  let pageResponse;
  try { pageResponse = await kino.fetch(embed, { headers: byseHeaders, timeoutMs: 9000 }); } catch { return null; }
  if (!pageResponse.ok) return null;
  let origin = inputUrl.origin;
  try { origin = new URL(pageResponse.url || embed).origin; } catch {}
  const pageUrl = pageResponse.url || embed;
  const pageHeaders = {
    ...byseHeaders,
    Origin: origin,
    Referer: pageUrl,
    "X-Embed-Origin": new URL(site.base).origin,
    "X-Embed-Referer": site.base + "/",
    "X-Embed-Parent": embed
  };
  // If the redirect ends on the main site, use its embed API paths and keep the response's cookies.
  const embedMode = /\/(?:e|embed|sovm9|boh)\//i.test(new URL(pageUrl).pathname);
  const prefix = "/api/videos/" + code + (embedMode ? "/embed" : "");
  const getJson = async (path, opts) => {
    const r = await kino.fetch(origin + path, { headers: pageHeaders, timeoutMs: 12000, ...(opts || {}) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };
  try {
    const settings = await getJson(prefix + "/settings");
    let fingerprint = null;
    let captchaToken = "";
    if (settings && settings.captcha_required) {
      const challenge = await getJson("/api/videos/access/challenge", { method: "POST", body: { json: {} }, timeoutMs: 15000 });
      if (!challenge || !challenge.nonce || !challenge.challenge_id) throw new Error("challenge incompleto");
      const pair = kino.crypto.generateKeyPair({ type: "ec", namedCurve: "P-256" });
      const signature = b64url(kino.crypto.sign({ key: pair.privateKey, data: challenge.nonce, hash: "SHA-256", format: "ieee-p1363", outputEncoding: "base64" }));
      const rand = () => Number.parseInt(kino.crypto.randomBytes(4, "hex"), 16) / 0xffffffff;
      const fingerprintHash = (n) => {
        const hex = kino.crypto.hash("sha256", String(n), { outputEncoding: "hex" });
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return b64url(bytesToB64(bytes));
      };
      const r = rand();
      const client = {
        user_agent: byseHeaders["User-Agent"],
        architecture: "arm", bitness: "32", platform: "Android", platform_version: "6.0.1",
        model: "SM-G5510", ua_full_version: "59.0.3071.125",
        brand_full_versions: [{ brand: "SamsungBrowser", version: "7.2" }],
        pixel_ratio: 1, screen_width: 1280, screen_height: 720, color_depth: 24,
        languages: ["en-US"], timezone: "America/New_York", hardware_concurrency: 4,
        device_memory: 2, touch_points: 1,
        canvas_hash: fingerprintHash(r), audio_hash: fingerprintHash(r + 1),
        fonts_hash: fingerprintHash(r + 3), codecs_hash: fingerprintHash(r + 4),
        media_devices: "ai1ao1vi4", pointer_type: "coarse",
        extra: { vendor: "Samsung", appVersion: "7.2" }
      };
      const attest = await getJson("/api/videos/access/attest", {
        method: "POST",
        body: { json: {
          viewer_id: "", device_id: "", challenge_id: challenge.challenge_id, nonce: challenge.nonce,
          signature, public_key: { ...pair.publicKey.jwk, ext: true, key_ops: ["verify"] },
          client, storage: {}, attributes: { entropy: "high" }
        } },
        timeoutMs: 20000
      });
      if (!attest || !attest.token || !attest.viewer_id || !attest.device_id) throw new Error("atestación incompleta");
      fingerprint = byseFingerprint(attest);
      const captcha = await getJson(prefix + "/captcha", { method: "POST", body: { json: { fingerprint } }, timeoutMs: 15000 });
      if (!captcha || !captcha.pow_nonce || !captcha.pow_token) throw new Error("desafío PoW incompleto");
      const solution = await byseSolvePow(captcha.pow_nonce, captcha.pow_difficulty);
      if (solution == null) throw new Error("PoW agotó el tiempo");
      const verified = await getJson(prefix + "/captcha/verify", {
        method: "POST", body: { json: { pow_token: captcha.pow_token, solution, fingerprint } }, timeoutMs: 15000
      });
      captchaToken = String((verified && verified.token) || "");
      if (!captchaToken) throw new Error("verificación CAPTCHA sin token");
    }
    const playback = await getJson(prefix + "/playback", {
      method: "POST",
      headers: { ...pageHeaders, ...(captchaToken ? { "X-Captcha-Token": captchaToken } : {}) },
      body: { json: settings && settings.captcha_required ? { fingerprint } : {} },
      timeoutMs: 20000
    });
    let sources = Array.isArray(playback.sources) ? playback.sources : null;
    if (!sources && playback.playback && Array.isArray(playback.playback.key_parts)) {
      const pd = playback.playback;
      let parts = pd.key_parts;
      const version = Number(pd.version);
      if (version && version >= 1 && version <= parts.length) parts = [parts[version - 1], parts[parts.length - version]];
      const keyBytes = parts.map(b64urlToBytes);
      const keyLength = keyBytes.reduce((sum, b) => sum + b.length, 0);
      const key = new Uint8Array(keyLength);
      let offset = 0;
      for (const bytes of keyBytes) { key.set(bytes, offset); offset += bytes.length; }
      const decrypted = kino.crypto.decrypt("aes-256-gcm", {
        key: bytesToB64(key), keyEncoding: "base64",
        iv: bytesToB64(b64urlToBytes(pd.iv)), ivEncoding: "base64",
        data: bytesToB64(b64urlToBytes(pd.payload)), inputEncoding: "base64", outputEncoding: "utf8"
      });
      const parsed = JSON.parse(decrypted);
      sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    }
    if (!sources || !sources.length) throw new Error("el playback no devolvió fuentes");
    const candidates = sources.map((x) => ({
      label: String(x.label || x.name || "Bysekoze"),
      url: String(x.url || "")
    })).filter((x) => x.url);
    candidates.sort((a, b) => {
      const quality = (s) => Number((/(\d{3,4})\s*[pP]?/.exec(s) || [])[1]) || 0;
      return quality(b.label) - quality(a.label);
    });
    const chosen = candidates.find((x) => /^https?:\/\//i.test(x.url)) || candidates[0];
    if (!chosen) throw new Error("fuentes sin URL");
    const streamUrl = new URL(chosen.url, origin + "/").href;
    let streamHost = "host desconocido";
    let streamPath = "/";
    try {
      const u = new URL(streamUrl);
      streamHost = u.hostname;
      streamPath = u.pathname.slice(0, 90);
    } catch {}
    log("servidor " + label + ": Bysekoze entregó " + chosen.label.slice(0, 24) + " (" + streamHost + streamPath + ")");
    // Playback URLs can be bound to the embed origin and browser fingerprint.
    // Pass the same browser identity and embed referer to the player for the
    // manifest and every child playlist/segment request.
    const streamHeaders = {
      "User-Agent": byseHeaders["User-Agent"],
      Referer: pageUrl,
      Origin: origin,
      "X-Embed-Origin": new URL(site.base).origin,
      "X-Embed-Referer": site.base + "/",
      "X-Embed-Parent": embed
    };
    return {
      url: streamUrl,
      label: (chosen.label + " · " + site.name).slice(0, 48),
      headers: streamHeaders,
      mime: /\.m3u8(?:$|[?#])/i.test(streamUrl) ? "application/x-mpegURL" : /\.mpd(?:$|[?#])/i.test(streamUrl) ? "application/dash+xml" : "video/mp4",
      expiresInSeconds: 300
    };
  } catch (e) {
    log("servidor " + label + ": Bysekoze HTTP no completó la resolución (" + String(e && e.message || e).slice(0, 80) + ")");
    return null;
  }
}

async function resolveManual(embed, site, label, hint) {
  let host = "";
  let url;
  try {
    url = new URL(embed);
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  const headers = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36", Referer: embed };
  try {
    if (host === "bysekoze.com" || host.endsWith(".bysekoze.com") || host === "n1mwq.org" || host.endsWith(".n1mwq.org")) {
      const stream = await resolveBysekoze(embed, site, label, headers);
      if (stream) return stream;
      return null;
    }

    if (host === "strp2p.com" || host.endsWith(".strp2p.com")) {
      const stream = await resolveSp2pApi(embed, site, label, headers);
      if (stream) return stream;
      return await resolvePageMedia(embed, site, label, headers);
    }

    if (host === "vidhidepro.com" || host.endsWith(".vidhidepro.com") ||
        host === "embedwish.com" || host.endsWith(".embedwish.com") ||
        hint === "vidhide" || hint === "streamwish") {
      return await resolvePageMedia(embed, site, label, headers, hint);
    }

    if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) {
      const id = (url.searchParams.get("video") || (url.pathname.match(/\/video\/([A-Za-z0-9]+)/) || [])[1] || "").trim();
      if (!id) return null;
      const r = await kino.fetch("https://geo.dailymotion.com/videos/" + encodeURIComponent(id), {
        headers: { Accept: "application/json", Referer: "https://geo.dailymotion.com/", "User-Agent": headers["User-Agent"] },
      });
      if (!r.ok) return null;
      const data = r.json();
      const streamUrl = data && data.stream && data.stream.url;
      if (streamUrl) {
        log("servidor " + label + ": URL de Dailymotion resuelta directamente");
        return directStream(streamUrl, label + " · " + site.name, "https://geo.dailymotion.com/", "application/x-mpegURL");
      }
      return null;
    }

    if (host === "rumble.com" || host.endsWith(".rumble.com")) {
      const stream = await resolveRumbleDirect(embed, site, label, headers["User-Agent"]);
      if (stream) return stream;
      return null;
    }

    if (host === "ok.ru" || host.endsWith(".ok.ru")) {
      const id = (url.pathname.match(/\/video(?:embed)?\/(\d+)/i) || [])[1];
      if (!id) return null;
      const embedUrl = "https://ok.ru/videoembed/" + id;
      const r = await kino.fetch(embedUrl, { headers: { ...headers, Referer: "https://ok.ru/" }, timeoutMs: 9000 });
      if (!r.ok) {
        log("servidor " + label + ": OK.ru respondió HTTP " + r.status);
        return null;
      }
      // Parse data-options from the original HTML. Decoding &quot; across the
      // whole page first can turn escaped attribute quotes into delimiters and
      // truncate the tag before JSON.parse ever sees the metadata.
      const html = r.text();
      const player = parseOkruPlayerOptions(html);
      const flashvars = player && player.flashvars;
      if (!flashvars) {
        log("servidor " + label + ": no se encontró flashvars en data-options de OK.ru");
        return null;
      }
      let metadata = flashvars.metadata;
      if (typeof metadata === "string") {
        try { metadata = JSON.parse(decode(metadata)); } catch { metadata = null; }
      }
      if (!metadata && flashvars.metadataUrl) {
        try {
          const metadataUrl = new URL(decode(flashvars.metadataUrl), "https://ok.ru/").href;
          const mr = await kino.fetch(metadataUrl, { headers: { ...headers, Referer: "https://ok.ru/" }, timeoutMs: 7000 });
          if (mr.ok) metadata = mr.json();
        } catch (e) { log("servidor " + label + ": no se pudieron leer metadatos de OK.ru"); }
      }
      const videos = metadata && Array.isArray(metadata.videos) ? metadata.videos.slice() : [];
      const metadataShape = metadata && typeof metadata === "object" ? Object.keys(metadata).slice(0, 30) : [];
      const videoSummary = videos.slice(0, 12).map((v) => ({
        name: String(v.name || v.quality || "").slice(0, 20),
        keys: v && typeof v === "object" ? Object.keys(v).slice(0, 12) : [],
        url: typeof v.url === "string" ? (() => { try { const u = new URL(v.url); return { host: u.hostname, path: u.pathname.slice(-28), extension: /\.(m3u8|mp4|webm)$/i.exec(u.pathname)?.[1] || "none", length: v.url.length, queryKeys: Array.from(u.searchParams.keys()).slice(0, 10) }; } catch { return { invalid: true }; } })() : typeof v.url
      }));
      const hlsFields = ["hlsMasterPlaylistUrl", "hlsManifestUrl", "ondemandHls", "ondemandDash", "hlsMasterUrl"]
        .map((key) => ({ key, type: !metadata || metadata[key] == null ? "missing" : Array.isArray(metadata[key]) ? "array" : typeof metadata[key] }));
      log("servidor " + label + ": metadatos OK.ru keys=" + JSON.stringify(metadataShape) + " hls=" + JSON.stringify(hlsFields) + " videos=" + JSON.stringify(videoSummary).slice(0, 1100));
      const rank = (v) => {
        const quality = String(v.name || v.quality || "").toLowerCase();
        if (/1080|full/.test(quality)) return 0;
        if (/720|hd/.test(quality)) return 1;
        if (/480|sd/.test(quality)) return 2;
        return 3;
      };
      const directVideo = (v) => typeof v.url === "string" && /^https:\/\//i.test(v.url) && /\.(?:mp4|webm)(?:[?#]|$)/i.test(v.url);
      videos.sort((a, b) => rank(a) - rank(b));
      const streamHeaders = { Referer: embedUrl, Origin: "https://ok.ru", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36" };
      // OK.ru puede llamar "ondemandHls" a una URL DASH .mpd. No clasificarla
      // por el nombre del campo: el protocolo real lo determina el manifiesto.
      const manifests = [];
      const manifestUrlShape = (value) => {
        try {
          const u = new URL(value);
          const ext = /\.(mpd|m3u8)$/i.exec(u.pathname);
          return {
            host: u.hostname,
            pathTail: /\.(mpd|m3u8)$/i.exec(u.pathname)?.[0].toLowerCase() || "(sin extensión)",
            extension: ext ? ext[1].toLowerCase() : "none",
            length: value.length,
            queryKeys: Array.from(u.searchParams.keys()).slice(0, 12)
          };
        } catch { return { invalid: true }; }
      };
      const collectManifests = (node, key, depth) => {
        if (depth > 8 || node == null) return;
        if (typeof node === "string") {
          const value = node.replace(/\\u0026/gi, "&").replace(/\\\\\//g, "/").trim();
          if (!/^https:\/\//i.test(value)) return;
          let pathname = "";
          try { pathname = new URL(value).pathname; } catch { return; }
          // Use the actual URL extension when present. If the server gives an extensionless
          // manifest endpoint, retain the metadata field as a fallback but log that fact.
          if (/\.mpd$/i.test(pathname)) manifests.push({ url: value, kind: "dash", field: key, confirmedExtension: true });
          else if (/\.m3u8$/i.test(pathname)) manifests.push({ url: value, kind: "hls", field: key, confirmedExtension: true });
          else if (/ondemandDash/i.test(key)) manifests.push({ url: value, kind: "dash", field: key, confirmedExtension: false });
          else if (/hls/i.test(key)) manifests.push({ url: value, kind: "hls", field: key, confirmedExtension: false });
          return;
        }
        if (Array.isArray(node)) { for (const item of node) collectManifests(item, key, depth + 1); return; }
        if (typeof node === "object") for (const [childKey, value] of Object.entries(node)) collectManifests(value, key + "." + childKey, depth + 1);
      };
      for (const key of ["ondemandDash", "hlsMasterPlaylistUrl", "hlsManifestUrl", "ondemandHls", "hlsMasterUrl"]) collectManifests(metadata && metadata[key], key, 0);
      log("servidor " + label + ": candidatos manifiesto OK.ru=" + JSON.stringify(manifests.map((item) => ({
        field: item.field, kind: item.kind, confirmedExtension: item.confirmedExtension, url: manifestUrlShape(item.url)
      }))).slice(0, 1600));
      // If both protocols are offered, try HLS first: Kino's playback path is
      // already confirmed to handle HLS, while the OK.ru DASH manifest currently
      // returns HTTP 400. Keep DASH available as a selectable fallback.
      const manifest = manifests.find((item) => item.kind === "hls" && item.confirmedExtension) ||
        manifests.find((item) => item.kind === "dash" && item.confirmedExtension) ||
        manifests.find((item) => item.kind === "hls") ||
        manifests.find((item) => item.kind === "dash");
      const direct = videos.find(directVideo);
      const alternatives = (selectedUrl) => {
        const otherManifests = manifests.filter((item) => item.url !== selectedUrl).map((item) => ({
          url: item.url,
          mime: item.kind === "dash" ? "application/dash+xml" : "application/x-mpegURL",
          headers: streamHeaders,
          label: "OK.ru · " + (item.kind === "dash" ? "DASH alternativo" : "HLS alternativo")
        }));
        const directVideos = videos.filter((v) => directVideo(v) && v.url !== selectedUrl).slice(0, 7).map((v) => ({
          url: v.url,
          mime: /\\.webm(?:[?#]|$)/i.test(v.url) ? "video/webm" : "video/mp4",
          headers: streamHeaders,
          label: ("OK.ru · " + String(v.name || v.quality || "Video")).slice(0, 48)
        }));
        return [...otherManifests, ...directVideos].slice(0, 8);
      };
      if (manifest) {
        const dash = manifest.kind === "dash";
        const mime = dash ? "application/dash+xml" : "application/x-mpegURL";
        const stream = { url: manifest.url, mime, headers: streamHeaders, label: dash ? "OK.ru · DASH" : "OK.ru · HLS" };
        stream.alternatives = alternatives(manifest.url);
        if (!stream.alternatives.length) delete stream.alternatives;
        log("servidor " + label + ": manifiesto " + (dash ? "DASH" : "HLS") + (manifest.confirmedExtension ? (dash ? " (.mpd)" : " (.m3u8)") : " (extensión no confirmada; inferido de " + manifest.field + ")") + " de OK.ru resuelto desde metadata");
        return stream;
      }
      if (direct) {
        const stream = {
          url: direct.url,
          mime: /\.webm(?:[?#]|$)/i.test(direct.url) ? "video/webm" : "video/mp4",
          headers: streamHeaders,
          label: ("OK.ru · " + String(direct.name || direct.quality || "Video")).slice(0, 48)
        };
        stream.alternatives = alternatives(direct.url);
        if (!stream.alternatives.length) delete stream.alternatives;
        log("servidor " + label + ": video de OK.ru resuelto desde metadata");
        return stream;
      }
      return null;
    }

    if (host === "voe.sx" || host.endsWith(".voe.sx") || host === "voe.to" || host.endsWith(".voe.to") || hint === "voe") {
      log("servidor " + label + ": entra al resolvedor HTTP de Voe");
      const r = await kino.fetch(embed, { headers: { "User-Agent": headers["User-Agent"], Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Referer: site.base + "/" }, timeoutMs: 12000 });
      if (!r.ok) { log("servidor " + label + ": VOE respondió HTTP " + r.status); return null; }
      let html = r.text();
      log("servidor " + label + ": respuesta HTTP de Voe recibida (" + html.length + " caracteres)");
      let realUrl = embed;
      const redirect = /window\.location\.href\s*=\s*['"]([^'"]+\/e\/[^'"]+)['"]/.exec(html);
      if (redirect && redirect[1]) {
        realUrl = new URL(redirect[1], embed).href;
        const rr = await kino.fetch(realUrl, { headers: { "User-Agent": headers["User-Agent"] } });
        if (!rr.ok) { log("servidor " + label + ": redirección VOE respondió HTTP " + rr.status); return null; }
        html = rr.text();
      }
      let config = /<script[^>]+type=["']application\/json["'][^>]*>\s*(?:\[\s*)?["']([^"']+)["']/.exec(html);
      let encoded = config && config[1];
      if (!encoded) {
        const direct = findDirectMedia(html);
        if (direct) {
          log("servidor " + label + ": URL de VOE encontrada en HTML sin decodificar");
          return directStream(direct.url, label + " · " + site.name, realUrl,
            direct.hls ? "application/x-mpegURL" : direct.dash ? "application/dash+xml" : "video/mp4");
        }
        // Some VOE pages protect the source with ALTCHA proof-of-work. Solve the bounded challenge
        // directly; if the challenge is unsupported or too expensive, use Kino's browser fallback.
        const csrf = /name=["']_token["'][^>]+value=["']([^"']+)["']/.exec(html);
        const challenge = /<altcha-widget[^>]+challenge=["']([^"']+)["']/.exec(html);
        if (!csrf || !challenge) { log("servidor " + label + ": VOE no expuso configuración directa ni desafío ALTCHA compatible"); return null; }
        const challengeUrl = new URL(challenge[1], realUrl).href;
        const cr = await kino.fetch(challengeUrl, { headers: { "User-Agent": headers["User-Agent"], Referer: realUrl }, timeoutMs: 15000 });
        if (!cr.ok) { log("servidor " + label + ": desafío VOE respondió HTTP " + cr.status); return null; }
        const cj = cr.json();
        const algorithm = String(cj.algorithm || "").toLowerCase().replace(/-/g, "");
        const cost = Number(cj.cost), keyLength = Number(cj.keyLength);
        const keyPrefix = String(cj.keyPrefix || ""), nonce = String(cj.nonce || ""), salt = String(cj.salt || "");
        if (!algorithm.includes("sha256") || !Number.isInteger(cost) || cost < 1 || cost > 100000 ||
            !Number.isInteger(keyLength) || keyLength < 1 || keyLength > 64 ||
            !/^[a-f0-9]+$/i.test(nonce) || !/^[a-f0-9]+$/i.test(salt) || !keyPrefix) {
          log("servidor " + label + ": parámetros ALTCHA no compatibles (algoritmo=" + algorithm + ", cost=" + cost + ", keyLength=" + keyLength + ", nonce=" + !!nonce + ", salt=" + !!salt + ", prefix=" + !!keyPrefix + ")");
          return null;
        }
        const started = Date.now();
        let solution = null;
        for (let counter = 0; counter < 1000000 && Date.now() - started < 22000; counter++) {
          const counterHex = counter.toString(16).padStart(8, "0");
          const derived = kino.crypto.pbkdf2("sha256", nonce + counterHex, salt, cost, keyLength, {
            inputEncoding: "hex", outputEncoding: "hex",
          });
          if (derived.startsWith(keyPrefix.toLowerCase())) {
            solution = { counter, derivedKey: derived, time: Date.now() - started };
            break;
          }
        }
        if (!solution) { log("servidor " + label + ": desafío ALTCHA de VOE no resuelto dentro del límite"); return null; }
        log("servidor " + label + ": ALTCHA resuelto en " + solution.time + " ms; envío el resultado");
        const payload = { challenge: cj, solution };
        const payloadB64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
        const origin = new URL(realUrl).origin;
        const posted = await kino.fetch(realUrl, {
          method: "POST",
          headers: {
            "User-Agent": headers["User-Agent"], Referer: realUrl, Origin: origin,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: { form: { _token: csrf[1], access: "0", altcha: payloadB64 } },
          timeoutMs: 15000,
        });
        if (!posted.ok) { log("servidor " + label + ": envío ALTCHA de VOE respondió HTTP " + posted.status); return null; }
        html = posted.text();
        config = /<script[^>]+type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/i.exec(html);
        encoded = config && config[1];
      }
      if (!encoded) { log("servidor " + label + ": VOE no entregó configuración tras la consulta"); return null; }
      const decoded = decodeVoeConfig(encoded);
      const source = /"source"\s*:\s*"([^"]+)"/.exec(decoded);
      if (!source || !source[1]) { log("servidor " + label + ": configuración VOE no contiene source reconocible"); return null; }
      const streamUrl = source[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      log("servidor " + label + ": URL de VOE resuelta directamente");
      return directStream(streamUrl, label + " · " + site.name, embed, /\.m3u8/i.test(streamUrl) ? "application/x-mpegURL" : undefined);
    }

    if (host === "odysee.com" || host.endsWith(".odysee.com") || host === "player.odycdn.com" || host.endsWith(".odycdn.com")) {
      const r = await kino.fetch(embed, { headers });
      if (!r.ok) return null;
      const html = r.text().replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\\u0026/g, "&").replace(/\\u003D/g, "=").replace(/\\\//g, "/");
      const m = /"contentUrl"\s*:\s*"([^"]+)"/i.exec(html);
      if (!m || !m[1]) return null;
      const streamUrl = m[1].replace(/\\u0026/g, "&").replace(/\\u003D/g, "=").replace(/\\\//g, "/");
      log("servidor " + label + ": URL de Odysee resuelta directamente");
      return directStream(streamUrl, label + " · " + site.name, embed, /\.m3u8/i.test(streamUrl) ? "application/x-mpegURL" : "video/mp4");
    }
  } catch (e) {
    log("servidor " + label + ": resolver manual falló (" + String((e && (e.code || e.message)) || e).slice(0, 120) + "); pruebo navegador");
  }
  return null;
}
