// Offline tests: Megadede is answered from small pages written here, shaped like the real ones
// (cards, series with seasons, a page with direct servers and an Embed69 "/vidurl/" page with its
// proof-of-work and AES-encrypted links). Nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validate } from "../sdk/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://megadede.mobi";

const card = (path, title, extra = "") =>
  `<article class="mv card"><a href="${path}"><img src="https://image.tmdb.org/t/p/w500/${title.length}.jpg" alt="Ver ${title} online en HD - Película completa" title="${title} - Ver online gratis"${extra}>` +
  `<h3>${title}</h3></a></article>`;

const pager = (n) => `<a href="${BASE}/peliculas?page=${n}">${n}</a>`;

// ---------- Embed69 fixture: the same scheme the site uses ----------
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const CHALLENGE = "abc123";
const SALT = "saltXYZ";
const DIFFICULTY = 2;
let NONCE = 0;
while (!sha256(CHALLENGE + NONCE).startsWith("0".repeat(DIFFICULTY))) NONCE++;
const KEY = createHash("sha256").update(CHALLENGE + NONCE + SALT).digest();
const encrypt = (url) => {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", KEY, iv);
  return Buffer.concat([iv, c.update(url, "utf8"), c.final()]).toString("base64");
};
const DATA = [
  { video_language: "SUB", sortedEmbeds: [{ servername: "streamwish", link: encrypt("https://streamwish.to/e/sw1") }] },
  {
    video_language: "LAT",
    sortedEmbeds: [
      { servername: "voe", link: encrypt("https://voe.sx/e/v1") },
      { servername: "vidhide", link: encrypt("https://vidhidepro.com/v/vh1") },
      { servername: "vidhide", link: encrypt("https://vidhidepro.com/v/duplicate") },
    ],
  },
];
const EMBED_PAGE =
  `<script>const POW_CHALLENGE='${CHALLENGE}';const POW_SALT='${SALT}';const POW_DIFFICULTY=${DIFFICULTY};` +
  `let dataLink = ${JSON.stringify(DATA)};</script>`;

const MOVIE_PAGE =
  `<h1>Película Test</h1><button onclick="changeServer('https://streamwish.to/e/direct1')">Direct</button>` +
  `<iframe src="https://embed69.org/vidurl/xyz" allowfullscreen></iframe>`;

const SERIES_PAGE =
  `<h1>Serie <b>Test</b></h1><meta property="og:image" content="https://image.tmdb.org/t/p/w500/s.jpg">` +
  `<meta name="description" content="Una historia &amp; más.">Estreno 2020 ` +
  `<a href="/serie/test-abc/temporada/1/capitulo/2">2</a><a href="/serie/test-abc/temporada/1/capitulo/1">1</a>` +
  `<a href="${BASE}/serie/test-abc/temporada/2/capitulo/1">s2</a><a href="/serie/test-abc/temporada/1/capitulo/1">dup</a>` +
  `<a href="/serie/test-abc/temporada/1/capitulo/0">zero</a>`;

function sites(extra = {}) {
  const asked = [];
  const pages = {
    [BASE + "/peliculas"]: card("/pelicula/uno-111", "Uno") + card("/pelicula/dos-222", "Dos &amp; Co") + card("/pelicula/uno-111", "Uno") + pager(2) + pager(3),
    [BASE + "/peliculas?page=2"]: card("/pelicula/tres-333", "Tres"),
    [BASE + "/series"]: card("/serie/test-abc", "Serie Test"),
    [BASE + "/animes"]: card("/anime/ani-444", "Ani"),
    [BASE + "/search?s=uno"]: card("/pelicula/uno-111", "Uno") + card("/serie/test-abc", "Serie Test") + card("/anime/ani-444", "Ani"),
    [BASE + "/serie/test-abc"]: SERIES_PAGE,
    [BASE + "/serie/test-abc/temporada/1/capitulo/1"]:
      `<meta property="og:image" content="https://image.tmdb.org/t/p/w500/e1.jpg"><meta name="description" content="Primer capítulo.">`,
    [BASE + "/serie/test-abc/temporada/1/capitulo/2"]:
      `<meta property="og:image" content="https://image.tmdb.org/t/p/w500/e2.jpg"><meta name="description" content="No se encontró una sinopsis para este capítulo.">`,
    [BASE + "/pelicula/test-abc"]: MOVIE_PAGE,
    "https://embed69.org/vidurl/xyz": EMBED_PAGE,
    "https://vidhidepro.com/v/vh1": `<script>var p={"hls4":"/stream/abc/master.m3u8","hls2":"https://other.example/x.m3u8"};</script>`,
    "https://streamwish.to/e/sw1": `<script>var p={"hls2":"https://cdn.example/sw/master.m3u8"};</script>`,
    "https://voe.sx/e/v1": `<script>var source="https://cdn.example/voe/master.m3u8";</script>`,
    ...extra,
  };
  const fetchImpl = async (url, init = {}) => {
    asked.push((init.method || "GET") + " " + url);
    return pages[url] === undefined ? new Response("no", { status: 404 }) : new Response(pages[url], { status: 200 });
  };
  return { fetchImpl, asked };
}

async function run(fn, args) {
  const { fetchImpl, asked } = sites();
  const r = await validate(root, { run: fn, args, fetchImpl });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.drops, []);
  return { out: r.output, asked };
}

test("Kino accepts the manifest and the exports", async () => {
  const r = await validate(root);
  assert.deepEqual(r.problems, []);
});

test("home: three rows (movies, series, anime), one card per title", async () => {
  const { out } = await run("home", []);
  assert.deepEqual(out.map((r) => r.id), ["list-peliculas", "list-series", "list-animes"]);
  assert.deepEqual(out.map((r) => r.genre), ["peliculas", "series", "anime"]);
  assert.ok(out.every((r) => r.ref && r.items.length));
  const movies = out[0].items;
  assert.deepEqual(movies.map((i) => i.id), ["pelicula-uno-111", "pelicula-dos-222"]);
  assert.equal(movies[0].kind, "movie");
  assert.equal(movies[0].ref, "mg:/pelicula/uno-111");
  assert.equal(movies[1].title, "Dos & Co");
  assert.equal(out[1].items[0].kind, "series");
  assert.equal(out[2].items[0].kind, "series");
  assert.deepEqual(out[2].items[0].badges, ["Anime"]);
});

test("browse pages a list with ?page=N and the last page has no next", async () => {
  const first = (await run("browse", ["list:peliculas"])).out;
  assert.equal(first.items.length, 2);
  assert.equal(first.next, "2");
  const second = (await run("browse", ["list:peliculas", "2"])).out;
  assert.deepEqual(second.items.map((i) => i.id), ["pelicula-tres-333"]);
  assert.ok(!second.next);
});

test("search returns movies, series and anime, with clean titles", async () => {
  const { out } = await run("search", ["uno"]);
  const items = Array.isArray(out) ? out : out.items;
  assert.deepEqual(items.map((i) => i.kind), ["movie", "series", "series"]);
  assert.equal(items[0].title, "Uno");
});

test("episodes: seasons, de-duplicated, with each episode's picture and synopsis", async () => {
  const { out } = await run("episodes", ["mg:/serie/test-abc"]);
  assert.equal(out.series.title, "Serie Test");
  assert.equal(out.series.overview, "Una historia & más.");
  assert.equal(out.series.year, 2020);
  assert.deepEqual(out.episodes.map((e) => [e.season, e.number]), [[1, 1], [1, 2], [2, 1]]);
  assert.equal(out.episodes[0].ref, "mg:/serie/test-abc/temporada/1/capitulo/1");
  assert.equal(out.episodes[0].title, "Episodio 1");
  assert.equal(out.episodes[0].overview, "Primer capítulo.");
  assert.match(out.episodes[0].still, /e1\.jpg$/);
  assert.ok(!out.episodes[1].overview); // "No se encontró una sinopsis" is dropped
  assert.match(out.episodes[2].still, /s\.jpg$/); // no page for it: the series picture
});

// resolve needs Kino's hidden browser, which the kit doesn't have: the plugin runs here with a small stand-in.
async function withKino(pages, body) {
  const { fetchImpl, asked } = sites(pages);
  const captured = [];
  const logs = [];
  const store = new Map();
  const stand = {
    lang: "es-AR",
    log(...args) { logs.push(args.join(" ")); },
    error: (code, msg, o) => Object.assign(new Error(msg), { code, userMessage: o && o.userMessage }),
    storage: { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => void store.set(k, String(v)) },
    crypto: {
      hash: (alg, data) => createHash(alg).update(data, "utf8").digest("hex"),
      decrypt: (alg, o) => {
        const d = createDecipheriv(alg, Buffer.from(o.key, o.keyEncoding), Buffer.from(o.iv, o.ivEncoding));
        return Buffer.concat([d.update(Buffer.from(o.data, o.inputEncoding)), d.final()]).toString(o.outputEncoding);
      },
    },
    fetch: async (url, o) => {
      const r = await fetchImpl(url, o);
      const text = await r.text();
      return { ok: r.ok, status: r.status, url, text: () => text, json: () => JSON.parse(text) };
    },
    browser: {
      capture: async (url) => {
        captured.push(url);
        if (/voe\.sx/.test(url)) throw Object.assign(new Error("blocked"), { code: "blocked" });
        return { media: [{ url: "https://cdn.example/a/index.m3u8", headers: { Referer: url } }], subtitles: [], finalUrl: url };
      },
    },
  };
  const before = globalThis.kino;
  globalThis.kino = stand;
  try {
    const plugin = await import(pathToFileURL(join(root, "plugin.js")).href + "?t=" + Math.random());
    await body(plugin, { captured, logs, asked });
  } finally {
    globalThis.kino = before;
  }
}

test("resolve: opens Embed69, prefers Latin Spanish, reads Vidhide's relative playlist and lists the rest as lazy copies", async () => {
  await withKino({}, async (plugin, { captured }) => {
    const s = await plugin.resolve("mg:/pelicula/test-abc");
    assert.equal(s.url, "https://morencius.com/stream/abc/master.m3u8");
    assert.equal(s.mime, "application/x-mpegURL");
    assert.match(s.label, /^Vidhide lat/);
    assert.deepEqual(captured, []); // resolved over HTTP, no hidden browser
    // Voe is omitted; only StreamWish alternatives remain after Vidhide.
    assert.deepEqual(s.alternatives.map((a) => a.label), ["Streamwish sub", "Streamwish", "Voe lat"]);
    assert.deepEqual(s.alternatives.map((a) => a.ref), [
      "srv:1:mg:/pelicula/test-abc",
      "srv:2:mg:/pelicula/test-abc",
      "srv:3:mg:/pelicula/test-abc",
    ]);
  });
});

test("resolve: a lazy copy resolves its own server, and the server list is kept (one Embed69 visit)", async () => {
  await withKino({}, async (plugin, { asked }) => {
    await plugin.resolve("mg:/pelicula/test-abc");
    const lazy = await plugin.resolve("srv:1:mg:/pelicula/test-abc"); // Streamwish SUB
    assert.equal(lazy.url, "https://cdn.example/sw/master.m3u8");
    assert.match(lazy.label, /^Streamwish sub/);
    assert.equal(asked.filter((a) => a.includes("/vidurl/")).length, 1);
  });
});

test("resolve: falls back to the hidden browser when a server can't be read directly", async () => {
  await withKino({ "https://vidhidepro.com/v/vh1": "<html>nada</html>" }, async (plugin, { captured }) => {
    const s = await plugin.resolve("mg:/pelicula/test-abc");
    // Vidhide gave nothing over HTTP -> browser capture of Vidhide, which the stand-in answers.
    assert.equal(s.url, "https://cdn.example/a/index.m3u8");
    assert.deepEqual(captured, ["https://vidhidepro.com/v/vh1"]);
  });
});

test("resolve: Voe remains visible as an alternative and resolves its direct HLS URL over HTTP", async () => {
  await withKino({}, async (plugin, { captured, asked, logs }) => {
    const first = await plugin.resolve("mg:/pelicula/test-abc");
    assert.deepEqual(first.alternatives.map((a) => a.label), ["Streamwish sub", "Streamwish", "Voe lat"]);
    const voe = await plugin.resolve("srv:3:mg:/pelicula/test-abc");
    assert.equal(voe.url, "https://cdn.example/voe/master.m3u8");
    assert.equal(voe.mime, "application/x-mpegURL");
    assert.deepEqual(captured, []);
    assert.ok(asked.some((a) => a.includes("GET https://voe.sx/e/v1")));
    assert.ok(logs.some((line) => /entra al resolvedor HTTP de Voe/.test(line)));
  });
});

test("resolve: a page without servers is 'not found'", async () => {
  await withKino({ [BASE + "/pelicula/test-abc"]: "<h1>vacío</h1>" }, async (plugin) => {
    await assert.rejects(plugin.resolve("mg:/pelicula/test-abc"), (e) => e.code === "not_found");
  });
});
