/**
 * RHC Mint Radar — client-only tracker
 * Talks only to the public Blockscout explorer API (no API keys, no backend secrets).
 */
(() => {
  "use strict";

  // ── Public config (no secrets) ──────────────────────────
  const EXPLORER = "https://robinhoodchain.blockscout.com";
  const API = `${EXPLORER}/api/v2`;
  const POLL_MS = 2000; // respectful public-API interval
  const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
  const RATE_WINDOW_MS = 60 * 1000;
  const FEED_LIMIT = 200;
  const COLLECTION_LIMIT = 80;
  const ZERO = "0x0000000000000000000000000000000000000000";

  const NOISE_SYMBOLS = new Set(["UNI-V3-POS", "UNI-V4-POSM"]);
  const NOISE_NAME_RE =
    /uniswap\s*v[34]\s*positions|liquidity\s*position|positions?\s*nft/i;

  // ── DOM ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    connDot: $("connDot"),
    connText: $("connText"),
    pollMs: $("pollMs"),
    liveCount: $("liveCount"),
    totalMints: $("totalMints"),
    collections: $("collections"),
    emptyCols: $("emptyCols"),
    feed: $("feed"),
    emptyFeed: $("emptyFeed"),
    colBadge: $("colBadge"),
    feedBadge: $("feedBadge"),
    search: $("search"),
    soundToggle: $("soundToggle"),
    noiseToggle: $("noiseToggle"),
    windowMin: $("windowMin"),
  };

  if (els.pollMs) els.pollMs.textContent = String(POLL_MS);
  if (els.windowMin) els.windowMin.textContent = String(ACTIVE_WINDOW_MS / 60000);

  // ── Tracker state (in-memory only — never sent to third parties) ──
  const seenMintKeys = new Set();
  const collections = new Map();
  const enrichCache = new Map();
  let feed = [];
  let totalMintsSeen = 0;
  let warmedUp = false;
  let showNoise = false;
  let sortMode = "hot";
  let pollCount = 0;
  let lastPollError = null;
  let audioCtx = null;
  let prevRanks = new Map();
  const mintPulse = new Map();
  const seenFeedDrawn = new Set();
  let firstFeedPaint = true;
  let flipBusy = false;
  let pollTimer = null;
  let aborted = false;

  // ── Utils ───────────────────────────────────────────────
  function now() {
    return Date.now();
  }

  function setConn(mode, text) {
    if (!els.connDot) return;
    els.connDot.className =
      "pulse-dot" + (mode === "live" ? " live" : mode === "err" ? " err" : "");
    if (els.connText) els.connText.textContent = text;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Safe external URL — only http(s) */
  function safeUrl(u) {
    if (!u || typeof u !== "string") return null;
    try {
      const url = new URL(u.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      /* ignore */
    }
    return null;
  }

  function ipfsToHttp(url) {
    if (!url || typeof url !== "string") return null;
    if (url.startsWith("ipfs://")) {
      return safeUrl("https://ipfs.io/ipfs/" + url.slice(7).replace(/^ipfs\//, ""));
    }
    if (url.startsWith("data:image/")) return url; // allow data images only
    return safeUrl(url);
  }

  function shortAddr(a) {
    if (!a || a.length < 12) return a || "";
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  function fmtNum(n) {
    if (n == null || n === "" || n === "—") return "—";
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n);
    return num.toLocaleString();
  }

  function parseSupply(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function relTime(ts) {
    if (!ts) return "—";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 4) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  function collectionUrl(address) {
    return `${EXPLORER}/token/${encodeURIComponent(address)}`;
  }
  function txUrl(hash) {
    return `${EXPLORER}/tx/${encodeURIComponent(hash)}`;
  }
  function contractWriteUrl(address) {
    return `${EXPLORER}/address/${encodeURIComponent(address)}?tab=write_contract`;
  }

  function isMint(item) {
    if (item?.type === "token_minting") return true;
    const from = (item?.from?.hash || item?.from || "").toLowerCase();
    return from === ZERO;
  }

  function isNoise(token) {
    if (!token) return true;
    const sym = (token.symbol || "").trim();
    const name = token.name || "";
    if (NOISE_SYMBOLS.has(sym)) return true;
    if (NOISE_NAME_RE.test(name)) return true;
    return false;
  }

  function mintKey(item) {
    return `${item.transaction_hash}:${item.log_index ?? item.block_number}`;
  }

  async function fetchJson(url, timeoutMs = 14000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  function extractSocials(meta) {
    if (!meta || typeof meta !== "object") {
      return { twitter: null, website: null };
    }
    const bag = { ...meta };
    if (Array.isArray(meta.attributes)) {
      for (const a of meta.attributes) {
        const k = String(a.trait_type || a.key || "").toLowerCase();
        if (k && a.value != null) bag[k] = a.value;
      }
    }
    const pick = (...keys) => {
      for (const k of keys) {
        const v = bag[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    };
    let twitter = pick("twitter", "x", "twitter_url", "com.twitter", "Twitter", "X");
    let website = pick("website", "web", "homepage", "external_url", "project_url");
    const text = [bag.description, bag.name, JSON.stringify(bag)].join(" ");
    if (!twitter) {
      const m = text.match(
        /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\b/i
      );
      if (m) twitter = `https://x.com/${m[1]}`;
    }
    if (twitter && !/^https?:\/\//i.test(twitter)) {
      twitter = twitter.startsWith("@")
        ? `https://x.com/${twitter.slice(1)}`
        : `https://x.com/${twitter.replace(/^\/+/, "")}`;
    }
    return {
      twitter: safeUrl(twitter),
      website: safeUrl(website),
    };
  }

  function beep(kind = "mint") {
    if (!els.soundToggle?.checked) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.connect(g);
      g.connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      if (kind === "new") {
        o.frequency.setValueAtTime(523, t);
        o.frequency.exponentialRampToValueAtTime(784, t + 0.14);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.start(t);
        o.stop(t + 0.32);
      } else {
        o.frequency.value = 480;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.025, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        o.start(t);
        o.stop(t + 0.12);
      }
    } catch {
      /* ignore */
    }
  }

  // ── Collection model ────────────────────────────────────
  function upsertCollection(token, mintEvent) {
    const address = token.address_hash || token.address;
    if (!address) return null;
    const key = address.toLowerCase();
    let c = collections.get(key);
    const ts = mintEvent.timestamp ? new Date(mintEvent.timestamp).getTime() : now();

    if (!c) {
      c = {
        address,
        name: token.name || "Unknown",
        symbol: token.symbol || "?",
        type: token.type || mintEvent.token_type || "ERC-721",
        holders: token.holders_count ?? null,
        totalSupply: token.total_supply ?? null,
        iconUrl: token.icon_url || null,
        firstSeenAt: ts,
        lastMintAt: ts,
        mintCount: 0,
        recentMints: 0,
        methods: {},
        lastTx: mintEvent.transaction_hash,
        isNew: true,
        collectionUrl: collectionUrl(address),
        mintLink: contractWriteUrl(address),
        explorerTx: txUrl(mintEvent.transaction_hash),
        twitter: null,
        website: null,
        externalAppUrl: null,
        image: null,
        verified: null,
        description: null,
        mintsPerMin: 0,
        timestamps: [],
        observedAt: [],
        short: shortAddr(address),
        noise: isNoise(token),
      };
      collections.set(key, c);
    }

    c.name = token.name || c.name;
    c.symbol = token.symbol || c.symbol;
    c.type = token.type || c.type;
    c.holders = token.holders_count ?? c.holders;
    c.totalSupply = token.total_supply ?? c.totalSupply;
    c.iconUrl = token.icon_url || c.iconUrl;
    c.noise = isNoise(token);
    c.lastMintAt = Math.max(c.lastMintAt, ts);
    c.mintCount += 1;
    c.lastTx = mintEvent.transaction_hash;
    c.explorerTx = txUrl(mintEvent.transaction_hash);
    const method = mintEvent.method || "unknown";
    c.methods[method] = (c.methods[method] || 0) + 1;
    c.timestamps.push(ts);
    c.observedAt.push(warmedUp ? now() : ts);

    const cutoff = now() - 5 * 60 * 1000;
    c.timestamps = c.timestamps.filter((t) => t >= cutoff);
    const rateCutoff = now() - RATE_WINDOW_MS;
    c.observedAt = c.observedAt.filter((t) => t >= rateCutoff);
    c.mintsPerMin = c.observedAt.length;

    if (c.externalAppUrl) c.mintLink = c.externalAppUrl;
    else if (c.website) c.mintLink = c.website;
    else c.mintLink = contractWriteUrl(address);

    c.isNew = now() - c.firstSeenAt < 10 * 60 * 1000;
    return c;
  }

  async function enrichCollection(address) {
    const key = address.toLowerCase();
    const cached = enrichCache.get(key);
    if (cached && now() - cached.at < 5 * 60 * 1000) return cached.data;

    const data = {
      twitter: null,
      website: null,
      externalAppUrl: null,
      image: null,
      verified: null,
      description: null,
    };

    try {
      const [addrInfo, instances] = await Promise.all([
        fetchJson(`${API}/addresses/${encodeURIComponent(address)}`).catch(() => null),
        fetchJson(
          `${API}/tokens/${encodeURIComponent(address)}/instances?limit=3`
        ).catch(() => null),
      ]);
      if (addrInfo) data.verified = !!addrInfo.is_verified;
      for (const inst of instances?.items || []) {
        const ext = safeUrl(inst.external_app_url);
        if (ext && !data.externalAppUrl) data.externalAppUrl = ext;
        if (inst.image_url && !data.image) data.image = ipfsToHttp(inst.image_url);
        if (inst.metadata) {
          const s = extractSocials(inst.metadata);
          data.twitter = data.twitter || s.twitter;
          data.website = data.website || s.website;
          if (inst.metadata.description && !data.description) {
            data.description = String(inst.metadata.description).slice(0, 200);
          }
        }
      }
    } catch {
      /* ignore */
    }

    enrichCache.set(key, { at: now(), data });
    return data;
  }

  function liveList() {
    const cutoff = now() - ACTIVE_WINDOW_MS;
    let list = [...collections.values()].filter((c) => c.lastMintAt >= cutoff);
    if (!showNoise) list = list.filter((c) => !c.noise);
    list.forEach((c) => {
      c.recentMints = c.timestamps.filter((t) => t >= cutoff).length || (c.lastMintAt >= cutoff ? 1 : 0);
    });
    return list.slice(0, COLLECTION_LIMIT);
  }

  function sortCollections(list) {
    const arr = [...list];
    if (sortMode === "new") arr.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    else if (sortMode === "recent") arr.sort((a, b) => b.lastMintAt - a.lastMintAt);
    else if (sortMode === "supply")
      arr.sort((a, b) => parseSupply(b.totalSupply) - parseSupply(a.totalSupply));
    else {
      arr.sort((a, b) => {
        if (b.mintsPerMin !== a.mintsPerMin) return b.mintsPerMin - a.mintsPerMin;
        if ((b.recentMints || 0) !== (a.recentMints || 0))
          return (b.recentMints || 0) - (a.recentMints || 0);
        return b.lastMintAt - a.lastMintAt;
      });
    }
    return arr;
  }

  function matchesQuery(c, q) {
    if (!q) return true;
    return `${c.name} ${c.symbol} ${c.address}`.toLowerCase().includes(q);
  }

  // ── FLIP ────────────────────────────────────────────────
  function measurePositions(container) {
    const map = new Map();
    container.querySelectorAll("[data-addr]").forEach((el) => {
      map.set(el.dataset.addr, el.getBoundingClientRect());
    });
    return map;
  }

  function playFlip(container, first) {
    if (!first?.size) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lasts = measurePositions(container);
    flipBusy = true;
    lasts.forEach((last, addr) => {
      const el = container.querySelector(`[data-addr="${CSS.escape(addr)}"]`);
      const f = first.get(addr);
      if (!el || !f) return;
      const dx = f.left - last.left;
      const dy = f.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetWidth;
      el.style.transition = "transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "translate(0, 0)";
      const clean = () => {
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", clean);
      };
      el.addEventListener("transitionend", clean);
    });
    setTimeout(() => {
      flipBusy = false;
    }, 600);
  }

  function applyBarWidths(root) {
    root.querySelectorAll("[data-heat-pct]").forEach((el) => {
      el.style.width = `${el.dataset.heatPct || 0}%`;
    });
    root.querySelectorAll("[data-supply-pct]").forEach((el) => {
      el.style.width = `${el.dataset.supplyPct || 0}%`;
    });
  }

  function rankClass(rank) {
    if (rank === 1) return "top1";
    if (rank === 2) return "top2";
    if (rank === 3) return "top3";
    return "";
  }

  function rowHTML(c, rank, opts) {
    const { heatMax, supplyMax, prevRank, pulsing } = opts;
    const addr = c.address.toLowerCase();
    const img = ipfsToHttp(c.iconUrl || c.image);
    const supply = parseSupply(c.totalSupply);
    const heat = c.mintsPerMin || 0;
    const heatPct = Math.min(100, Math.round((heat / heatMax) * 100));
    const supplyPct = Math.min(100, Math.round((supply / supplyMax) * 100));
    const mintHref = safeUrl(c.mintLink) || c.collectionUrl;
    const site = safeUrl(c.website || c.externalAppUrl);
    const twitter = safeUrl(c.twitter);

    let delta = null;
    if (prevRank != null && prevRank !== rank) delta = prevRank - rank;

    const classes = [
      "rank-row",
      heat >= Math.max(3, heatMax * 0.45) ? "is-hot" : "",
      c.isNew ? "is-new" : "",
      pulsing ? "pulse-mint" : "",
      delta != null && delta > 0 ? "rank-up" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const xBtn = twitter
      ? `<a class="btn x" href="${esc(twitter)}" target="_blank" rel="noopener noreferrer">𝕏</a>`
      : `<span class="btn ghost-disabled" title="No X in public metadata">𝕏</span>`;

    return `
      <article class="${classes}" data-addr="${esc(addr)}" data-rank="${rank}">
        <div class="cell-rank">
          <div class="rank-badge ${rankClass(rank)}">
            ${rank}
            <span class="rank-delta ${delta != null && delta !== 0 ? "show" : ""} ${
              delta != null && delta < 0 ? "down" : ""
            }">${
              delta == null || delta === 0
                ? ""
                : delta > 0
                  ? `↑${delta}`
                  : `↓${Math.abs(delta)}`
            }</span>
          </div>
        </div>
        <div class="cell-col">
          <div class="col-main">
            <div class="thumb" data-thumb="${esc(addr)}"></div>
            <div class="col-copy">
              <h3 class="col-name" title="${esc(c.name)}">${esc(c.name || "Unknown")}</h3>
              <div class="col-meta">
                <span class="sym">$${esc(c.symbol || "?")}</span>
                <span class="chip type">${esc(c.type || "NFT")}</span>
                ${c.isNew ? `<span class="chip new">NEW</span>` : ""}
                ${c.verified ? `<span class="chip ok">verified</span>` : ""}
              </div>
              <div class="addr" title="${esc(c.address)}">${esc(c.short)}</div>
            </div>
          </div>
        </div>
        <div class="cell-heat">
          <div class="heat-box">
            <div class="heat-val">${esc(heat)} <em>/min</em></div>
            <div class="heat-bar"><i data-heat-pct="${heatPct}"></i></div>
          </div>
        </div>
        <div class="cell-supply">
          <div class="supply-box">
            <div class="supply-top"><span>Supply</span><b>${fmtNum(c.totalSupply)}</b></div>
            <div class="supply-bar"><i data-supply-pct="${supplyPct}"></i></div>
            <div class="supply-sub">${supplyPct}% of top live · holders ${fmtNum(c.holders)}</div>
          </div>
        </div>
        <div class="cell-stats">
          <div class="stats-box">
            <div>Session <b>${fmtNum(c.mintCount)}</b></div>
            <div>Window <b>${fmtNum(c.recentMints)}</b></div>
            <div>Last <b data-last="${esc(addr)}">${esc(relTime(c.lastMintAt))}</b></div>
          </div>
        </div>
        <div class="cell-act">
          <a class="btn primary" href="${esc(mintHref)}" target="_blank" rel="noopener noreferrer">Mint</a>
          <a class="btn" href="${esc(c.collectionUrl)}" target="_blank" rel="noopener noreferrer">Token</a>
          ${xBtn}
          ${
            site && site !== mintHref
              ? `<a class="btn" href="${esc(site)}" target="_blank" rel="noopener noreferrer">Web</a>`
              : ""
          }
        </div>
      </article>
    `;
  }

  function fillThumbs(root, list) {
    for (const c of list) {
      const addr = c.address.toLowerCase();
      const el = root.querySelector(`[data-thumb="${CSS.escape(addr)}"]`);
      if (!el) continue;
      const imgUrl = ipfsToHttp(c.iconUrl || c.image);
      if (!imgUrl) {
        el.textContent = "◈";
        continue;
      }
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = imgUrl;
      img.onerror = () => {
        el.textContent = "◈";
      };
      el.textContent = "";
      el.appendChild(img);
    }
  }

  function renderCollections({ animate = true } = {}) {
    const q = (els.search?.value || "").trim().toLowerCase();
    const list = sortCollections(liveList()).filter((c) => matchesQuery(c, q));

    if (els.colBadge) els.colBadge.textContent = String(list.length);
    if (els.liveCount) els.liveCount.textContent = String(liveList().length);
    if (els.totalMints) els.totalMints.textContent = String(totalMintsSeen);

    if (!list.length) {
      if (els.collections) els.collections.innerHTML = "";
      els.emptyCols?.classList.remove("hidden");
      prevRanks = new Map();
      return;
    }
    els.emptyCols?.classList.add("hidden");

    const heatMax = Math.max(1, ...list.map((c) => c.mintsPerMin || 0));
    const supplyMax = Math.max(1, ...list.map((c) => parseSupply(c.totalSupply)));
    const t = now();
    const first = animate ? measurePositions(els.collections) : null;
    const nextRanks = new Map();

    els.collections.innerHTML = list
      .map((c, i) => {
        const rank = i + 1;
        const addr = c.address.toLowerCase();
        nextRanks.set(addr, rank);
        return rowHTML(c, rank, {
          heatMax,
          supplyMax,
          prevRank: prevRanks.has(addr) ? prevRanks.get(addr) : null,
          pulsing: (mintPulse.get(addr) || 0) > t,
        });
      })
      .join("");

    applyBarWidths(els.collections);
    fillThumbs(els.collections, list);

    if (animate && first?.size) {
      requestAnimationFrame(() => playFlip(els.collections, first));
    }

    setTimeout(() => {
      els.collections?.querySelectorAll(".rank-delta.show").forEach((el) => {
        el.classList.remove("show");
      });
    }, 1800);

    prevRanks = nextRanks;
  }

  function renderFeed({ freshIds = null } = {}) {
    const q = (els.search?.value || "").trim().toLowerCase();
    let items = feed;
    if (!showNoise) items = items.filter((f) => !f.noise);
    items = items.filter((f) => {
      if (!q) return true;
      return `${f.name} ${f.symbol} ${f.address}`.toLowerCase().includes(q);
    });

    if (els.feedBadge) els.feedBadge.textContent = String(items.length);

    if (!items.length) {
      if (els.feed) els.feed.innerHTML = "";
      els.emptyFeed?.classList.remove("hidden");
      return;
    }
    els.emptyFeed?.classList.add("hidden");

    els.feed.innerHTML = items
      .slice(0, 100)
      .map((f) => {
        const isFresh =
          !firstFeedPaint && freshIds?.has(f.id) && !seenFeedDrawn.has(f.id);
        const cls = [
          "feed-item",
          f.isNewCollection ? "is-new-col" : "",
          isFresh ? "enter-fresh" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `
          <div class="${cls}" data-feed-id="${esc(f.id)}">
            <div>
              <div class="feed-name">${esc(f.name)} <span class="sym">$${esc(f.symbol)}</span></div>
              <div class="feed-line">
                ${esc(f.type)} · ${esc(f.method || "mint")}
                ${f.tokenId != null ? ` · #${esc(f.tokenId)}` : ""}
              </div>
              <div class="feed-links">
                <a href="${esc(f.collectionUrl)}" target="_blank" rel="noopener noreferrer">collection</a>
                <a href="${esc(f.txUrl)}" target="_blank" rel="noopener noreferrer">tx</a>
                <a href="${esc(safeUrl(f.mintLink) || f.collectionUrl)}" target="_blank" rel="noopener noreferrer">mint</a>
              </div>
            </div>
            <div class="feed-right">
              <div class="ago">${esc(relTime(f.ts))}</div>
              <div>${esc((f.address || "").slice(0, 8))}…</div>
            </div>
          </div>`;
      })
      .join("");

    if (freshIds) freshIds.forEach((id) => seenFeedDrawn.add(id));
    firstFeedPaint = false;
  }

  // ── Poller ──────────────────────────────────────────────
  async function pollOnce() {
    pollCount += 1;
    try {
      const data = await fetchJson(
        `${API}/token-transfers?type=${encodeURIComponent("ERC-721,ERC-1155")}`
      );
      const items = data?.items || [];
      const mints = items.filter(isMint).reverse();
      const newEntries = [];

      for (const item of mints) {
        const key = mintKey(item);
        if (seenMintKeys.has(key)) continue;
        seenMintKeys.add(key);
        if (seenMintKeys.size > 4000) {
          const arr = [...seenMintKeys];
          arr.slice(0, 1500).forEach((k) => seenMintKeys.delete(k));
        }

        const token = item.token || {};
        const address = token.address_hash || token.address;
        if (!address) continue;

        const noise = isNoise(token);
        const isFirst = !collections.has(address.toLowerCase());
        totalMintsSeen += 1;
        const col = upsertCollection(token, item);

        const inst = item.total?.token_instance;
        if (inst && col) {
          const ext = safeUrl(inst.external_app_url);
          if (ext) {
            col.externalAppUrl = ext;
            col.mintLink = ext;
          }
          if (inst.image_url) col.image = ipfsToHttp(inst.image_url);
          if (inst.metadata) {
            const s = extractSocials(inst.metadata);
            col.twitter = col.twitter || s.twitter;
            col.website = col.website || s.website;
            if (s.website) col.mintLink = s.website;
          }
        }

        const entry = {
          id: key,
          ts: item.timestamp ? new Date(item.timestamp).getTime() : now(),
          type: token.type || item.token_type,
          name: token.name || "Unknown",
          symbol: token.symbol || "?",
          address,
          tokenId: item.total?.token_id ?? null,
          method: item.method || null,
          collectionUrl: collectionUrl(address),
          txUrl: txUrl(item.transaction_hash),
          mintLink: col?.mintLink || contractWriteUrl(address),
          noise,
          isNewCollection: isFirst,
        };
        feed.unshift(entry);
        if (feed.length > FEED_LIMIT) feed.length = FEED_LIMIT;
        newEntries.push(entry);

        if (isFirst && !noise) {
          enrichCollection(address).then((meta) => {
            const c = collections.get(address.toLowerCase());
            if (!c) return;
            Object.assign(c, {
              twitter: meta.twitter || c.twitter,
              website: meta.website || c.website,
              externalAppUrl: meta.externalAppUrl || c.externalAppUrl,
              image: meta.image || c.image,
              verified: meta.verified,
              description: meta.description || c.description,
            });
            if (c.externalAppUrl) c.mintLink = c.externalAppUrl;
            else if (c.website) c.mintLink = c.website;
            renderCollections({ animate: true });
          });
        }
      }

      lastPollError = null;
      setConn("live", "Live");

      if (!warmedUp) {
        warmedUp = true;
        renderCollections({ animate: false });
        renderFeed();
      } else if (newEntries.length) {
        const visible = showNoise ? newEntries : newEntries.filter((e) => !e.noise);
        const freshIds = new Set(visible.map((e) => e.id));
        const t = now();
        for (const e of visible) {
          mintPulse.set(e.address.toLowerCase(), t + 1200);
          if (e.isNewCollection) beep("new");
          else beep("mint");
        }
        renderCollections({ animate: true });
        renderFeed({ freshIds });
      } else {
        if (els.totalMints) els.totalMints.textContent = String(totalMintsSeen);
        if (els.liveCount) els.liveCount.textContent = String(liveList().length);
      }
    } catch (e) {
      lastPollError = e?.message || "Network error";
      setConn("err", "Retrying…");
    }
  }

  function schedulePoll() {
    if (aborted) return;
    pollTimer = setTimeout(async () => {
      await pollOnce();
      schedulePoll();
    }, POLL_MS);
  }

  // ── Events ──────────────────────────────────────────────
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      sortMode = btn.dataset.sort || "hot";
      prevRanks = new Map();
      renderCollections({ animate: true });
    });
  });

  let searchTimer = null;
  els.search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      prevRanks = new Map();
      renderCollections({ animate: false });
      renderFeed();
    }, 120);
  });

  els.noiseToggle?.addEventListener("change", () => {
    showNoise = !!els.noiseToggle.checked;
    prevRanks = new Map();
    renderCollections({ animate: true });
    renderFeed();
  });

  setInterval(() => {
    if (flipBusy) return;
    collections.forEach((c) => {
      const el = els.collections?.querySelector(
        `[data-last="${CSS.escape(c.address.toLowerCase())}"]`
      );
      if (el) el.textContent = relTime(c.lastMintAt);
    });
    els.feed?.querySelectorAll(".feed-item").forEach((item) => {
      const id = item.dataset.feedId;
      const f = feed.find((x) => x.id === id);
      const ago = item.querySelector(".ago");
      if (f && ago) ago.textContent = relTime(f.ts);
    });
  }, 4000);

  // Pause polling when tab hidden (saves rate limits + battery)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    } else if (!pollTimer && !aborted) {
      pollOnce().finally(schedulePoll);
    }
  });

  // Boot
  setConn("", "Connecting");
  pollOnce().finally(schedulePoll);
})();
