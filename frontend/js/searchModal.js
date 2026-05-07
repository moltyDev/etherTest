import { api } from "./api.js";
import { defaultUsername, fetchEthUsdPrice, formatCompactUsd, hydrateUserProfiles, loadUserProfile, resolveCoinImage, weiToUsd } from "./core.js";

const RECENT_SEARCHES_KEY = "etherpump.search.recent.v1";
const RECENT_VIEWED_KEY = "etherpump.search.viewed.v1";
const MAX_RECENT_SEARCHES = 10;
const MAX_RECENT_VIEWED = 20;
const sparklineCache = new Map();
const sparklineInflight = new Map();
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function hashSeed(input = "") {
  let h = 2166136261 >>> 0;
  const str = String(input || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeFallbackSparklinePath(seed = "") {
  let r = hashSeed(seed) || 1;
  const rnd = () => {
    r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
    return (r & 0xffff) / 0xffff;
  };

  const points = 9;
  const width = 112;
  const minY = 12;
  const maxY = 27;
  let y = 20 + (rnd() - 0.5) * 2.8;
  const coords = [];
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * width;
    const drift = (rnd() - 0.5) * 6.8;
    y = Math.max(minY, Math.min(maxY, y + drift));
    coords.push([x, y]);
  }
  return coords.map(([x, yy], idx) => `${idx === 0 ? "M" : "L"}${x.toFixed(2)} ${yy.toFixed(2)}`).join(" ");
}

function readList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
}

function creatorHandle(address) {
  if (!address) return "anon";
  const profile = loadUserProfile(address);
  return profile.username || defaultUsername(address);
}

function isWalletAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function normalizeWalletQuery(query = "") {
  const text = String(query || "").trim();
  if (!ETH_ADDRESS_REGEX.test(text)) return "";
  return text.toLowerCase();
}

function profileAvatarDataUri(label = "EP") {
  const text = String(label || "EP").slice(0, 2).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'>
    <defs>
      <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0%' stop-color='#9f8cff'/>
        <stop offset='100%' stop-color='#6f7cff'/>
      </linearGradient>
    </defs>
    <rect width='96' height='96' rx='48' fill='url(#g)'/>
    <text x='48' y='56' text-anchor='middle' fill='white' font-family='Arial' font-size='30' font-weight='700'>${text}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function trimText(value, max = 32) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function marketCapLabel(launch, ethUsd) {
  const usd = weiToUsd(launch?.pool?.marketCapWei || "0", ethUsd);
  return formatCompactUsd(usd);
}

function addRecentSearch(query) {
  const q = String(query || "").trim();
  if (!q) return;
  const list = readList(RECENT_SEARCHES_KEY).filter((item) => String(item || "").toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  writeList(RECENT_SEARCHES_KEY, list.slice(0, MAX_RECENT_SEARCHES));
}

function clearRecentSearches() {
  writeList(RECENT_SEARCHES_KEY, []);
}

export function recordViewedLaunch(launch) {
  if (!launch?.token) return;
  const token = String(launch.token).toLowerCase();
  const now = Date.now();
  const entry = {
    token,
    ts: now,
    name: String(launch.name || ""),
    symbol: String(launch.symbol || ""),
    creator: String(launch.creator || ""),
    imageURI: String(launch.imageURI || ""),
    description: String(launch.description || ""),
    totalSupply: String(launch.totalSupply || "0"),
    creatorAllocation: String(launch.creatorAllocation || "0"),
    createdAt: Number(launch.createdAt || 0),
    poolAddress: String(launch.poolAddress || launch.pool || ""),
    tokenAddress: String(launch.tokenAddress || launch.token || ""),
    pool: launch.pool || null,
    dexSnapshot: launch.dexSnapshot || null,
    marketCapWei: String(launch?.pool?.marketCapWei || launch?.marketCapWei || "0")
  };
  const list = readList(RECENT_VIEWED_KEY).filter((item) => String(item?.token || "").toLowerCase() !== token);
  list.unshift(entry);
  writeList(RECENT_VIEWED_KEY, list.slice(0, MAX_RECENT_VIEWED));
}

function clearRecentViewed() {
  writeList(RECENT_VIEWED_KEY, []);
}

function timeAgo(tsMs) {
  const diff = Date.now() - Number(tsMs || 0);
  if (diff < 60_000) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function openToken(token, launch = null) {
  if (!token) return;
  if (launch) recordViewedLaunch(launch);
  window.location.href = `/token?token=${token}`;
}

function byMcapDesc(a, b) {
  return Number(b?.pool?.marketCapEth || 0) - Number(a?.pool?.marketCapEth || 0);
}

function getPoolAddress(launch) {
  const migrated = String(launch?.pool?.migratedPair || "").trim();
  if (migrated && migrated !== "0x0000000000000000000000000000000000000000") return migrated;
  const direct = String(launch?.poolAddress || "").trim();
  return direct;
}

function getChainId(launches = []) {
  const first = launches[0] || {};
  const fromPool = Number(first?.pool?.chainId || 0);
  if (Number.isFinite(fromPool) && fromPool > 0) return fromPool;
  const fromLaunch = Number(first?.chainId || 0);
  if (Number.isFinite(fromLaunch) && fromLaunch > 0) return fromLaunch;
  return 1;
}

async function fetchSparklinePath(launch, chainId) {
  const pool = getPoolAddress(launch);
  const fallbackSeed = `${Number(chainId || 1)}:${String(launch?.token || "").toLowerCase()}:${String(pool || "").toLowerCase()}`;
  if (!pool) return makeFallbackSparklinePath(fallbackSeed);
  const key = `${Number(chainId || 0)}:${pool.toLowerCase()}`;
  if (sparklineCache.has(key)) return sparklineCache.get(key);
  if (sparklineInflight.has(key)) return sparklineInflight.get(key);

  const task = (async () => {
    try {
      const params = new URLSearchParams({
        pool,
        aggregate: "15",
        limit: "24",
        chainId: String(Number(chainId || 1) || 1)
      });
      const res = await fetch(`/api/sparkline?${params.toString()}`, { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        const path = String(json?.path || "");
        if (path) {
          sparklineCache.set(key, path);
          return path;
        }
      }
    } catch {
      // fallback below
    }
    const fallback = makeFallbackSparklinePath(fallbackSeed);
    sparklineCache.set(key, fallback);
    return fallback;
  })().finally(() => {
    sparklineInflight.delete(key);
  });

  sparklineInflight.set(key, task);
  return task;
}

export async function getLaunchSparklinePath(launch, chainIdHint = 1) {
  const chainId = Number(chainIdHint || 1) || 1;
  return fetchSparklinePath(launch, chainId);
}

export function initCoinSearchOverlay({ triggerInputs = [] } = {}) {
  const inputs = (triggerInputs || []).filter(Boolean);
  if (!inputs.length) return;

  const state = {
    open: false,
    query: "",
    launches: [],
    ethUsd: 3000,
    loading: false,
    loaded: false,
    lastAddressLookup: ""
  };

  const overlay = document.createElement("div");
  overlay.className = "coin-search-overlay";
  overlay.innerHTML = `
    <div class="coin-search-modal" role="dialog" aria-modal="true" aria-label="Search coins">
      <div class="coin-search-head">
        <span class="coin-search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="6"></circle>
            <path d="M16 16l5 5"></path>
          </svg>
        </span>
        <input id="coinSearchModalInput" type="text" placeholder="Search for coins..." />
      </div>
      <div id="coinSearchModalBody" class="coin-search-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const modal = overlay.querySelector(".coin-search-modal");
  const input = overlay.querySelector("#coinSearchModalInput");
  const body = overlay.querySelector("#coinSearchModalBody");

  function renderEmpty() {
    body.innerHTML = `
      <div class="coin-search-empty">
        <p>Loading coins...</p>
      </div>
    `;
  }

  function renderResults(results) {
    if (!results.length) {
      return `<p class="coin-search-muted">No matching coins yet.</p>`;
    }
    return results
      .slice(0, 14)
      .map((launch) => {
        const image = resolveCoinImage(launch);
        const creator = creatorHandle(launch.creator);
        const mcap = marketCapLabel(launch, state.ethUsd);
        return `
          <button class="coin-search-row" type="button" data-open-token="${launch.token}">
            <img src="${image}" alt="${launch.symbol} logo" />
            <div class="coin-search-row-copy">
              <strong>${trimText(launch.name, 34)}</strong>
              <span>${trimText(creator, 20)}</span>
            </div>
            <b>${mcap}</b>
          </button>
        `;
      })
      .join("");
  }

  function renderProfileResult(address) {
    const profile = loadUserProfile(address);
    const username = profile.username || defaultUsername(address);
    const avatar = profile.imageUri || profileAvatarDataUri(username);
    return `
      <button class="coin-search-row" type="button" data-open-profile="${address}">
        <img src="${avatar}" alt="${username} avatar" />
        <div class="coin-search-row-copy">
          <strong>${trimText(username, 34)}</strong>
          <span>${trimText(address, 28)}</span>
        </div>
        <b>Profile</b>
      </button>
    `;
  }

  async function ensureWalletProfile(address) {
    const normalized = normalizeWalletQuery(address);
    if (!normalized) return;
    if (state.lastAddressLookup === normalized) return;
    state.lastAddressLookup = normalized;
    try {
      await hydrateUserProfiles([normalized], { force: true });
    } catch {
      // best effort
    }
    if (state.open) {
      renderBody();
    }
  }

  function renderHotCoins() {
    const hot = [...state.launches].sort(byMcapDesc).slice(0, 8);
    if (!hot.length) return `<p class="coin-search-muted">No coins found.</p>`;
    return hot
      .map((launch) => {
        const image = resolveCoinImage(launch);
        const mcap = marketCapLabel(launch, state.ethUsd);
        const sparkKey = `${String(launch.token || "").toLowerCase()}:${String(getPoolAddress(launch) || "").toLowerCase()}`;
        return `
          <button class="coin-search-hot-card" type="button" data-open-token="${launch.token}">
            <div class="coin-search-hot-top">
              <img src="${image}" alt="${launch.symbol} logo" />
              <div>
                <strong>${trimText(launch.name, 14)}</strong>
                <span>${trimText(launch.symbol, 10)}</span>
              </div>
            </div>
            <div class="coin-search-spark" data-spark-key="${sparkKey}" aria-hidden="true"></div>
            <b>${mcap}</b>
          </button>
        `;
      })
      .join("");
  }

  async function hydrateHotSparklines() {
    const hot = [...state.launches].sort(byMcapDesc).slice(0, 8);
    if (!hot.length) return;
    const chainId = getChainId(state.launches);
    await Promise.all(
      hot.map(async (launch) => {
        const sparkKey = `${String(launch.token || "").toLowerCase()}:${String(getPoolAddress(launch) || "").toLowerCase()}`;
        const target = body.querySelector(`[data-spark-key="${sparkKey}"]`);
        if (!target) return;
        const path = await fetchSparklinePath(launch, chainId);
        if (!path) {
          target.classList.add("fallback");
          return;
        }
        target.classList.add("ready");
        target.innerHTML = `
          <svg viewBox="0 0 112 30" preserveAspectRatio="none">
            <defs>
              <linearGradient id="sparkFill-${sparkKey.replace(/[^a-z0-9]/gi, "")}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(110,255,193,0.14)"></stop>
                <stop offset="100%" stop-color="rgba(110,255,193,0)"></stop>
              </linearGradient>
            </defs>
            <path class="coin-search-spark-fill" d="${path} L112 30 L0 30 Z" fill="url(#sparkFill-${sparkKey.replace(/[^a-z0-9]/gi, "")})"></path>
            <path class="coin-search-spark-line" d="${path}"></path>
          </svg>
        `;
      })
    );
  }

  function renderRecentSearches() {
    const terms = readList(RECENT_SEARCHES_KEY);
    if (!terms.length) return `<p class="coin-search-muted">No recent searches yet.</p>`;
    return terms
      .map(
        (term) => `
          <button class="coin-search-term" type="button" data-fill-term="${term}">
            <span class="coin-search-term-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="6"></circle>
                <path d="M16 16l5 5"></path>
              </svg>
            </span>
            <span>${term}</span>
          </button>
        `
      )
      .join("");
  }

  function renderRecentViewed() {
    const viewed = readList(RECENT_VIEWED_KEY);
    if (!viewed.length) return `<p class="coin-search-muted">No recently viewed coins yet.</p>`;
    const byToken = new Map(state.launches.map((launch) => [String(launch.token || "").toLowerCase(), launch]));
    return viewed
      .slice(0, 10)
      .map((entry) => {
        const launch = byToken.get(String(entry.token || "").toLowerCase());
        const image = launch ? resolveCoinImage(launch) : resolveCoinImage(entry);
        const name = launch?.name || entry.name || "Unknown";
        const symbol = launch?.symbol || entry.symbol || "TOKEN";
        const mcap = launch ? marketCapLabel(launch, state.ethUsd) : formatCompactUsd(weiToUsd(entry.marketCapWei || "0", state.ethUsd));
        return `
          <button class="coin-search-row" type="button" data-open-token="${entry.token}">
            <img src="${image}" alt="${symbol} logo" />
            <div class="coin-search-row-copy">
              <strong>${trimText(name, 34)}</strong>
              <span>${trimText(symbol, 16)} • ${timeAgo(entry.ts)}</span>
            </div>
            <b>${mcap}</b>
          </button>
        `;
      })
      .join("");
  }

  function renderBody() {
    const query = state.query.toLowerCase();
    const walletAddress = normalizeWalletQuery(state.query);
    const hasQuery = Boolean(query);
    const filtered = hasQuery
      ? state.launches.filter((launch) => {
          return (
            String(launch.name || "").toLowerCase().includes(query) ||
            String(launch.symbol || "").toLowerCase().includes(query) ||
            String(launch.token || "").toLowerCase().includes(query) ||
            String(launch.creator || "").toLowerCase().includes(query)
          );
        })
      : [];

    if (hasQuery) {
      const profileSection = walletAddress ? renderProfileResult(walletAddress) : "";
      body.innerHTML = `
        <section class="coin-search-section">
          <div class="coin-search-section-head">
            <h5>SEARCH RESULTS</h5>
          </div>
          <div class="coin-search-list">
            ${profileSection}
            ${renderResults(filtered)}
          </div>
        </section>
      `;
      return;
    }

    body.innerHTML = `
      <section class="coin-search-section">
        <div class="coin-search-section-head">
          <h5>HOT COINS</h5>
        </div>
        <div class="coin-search-hot-row">${renderHotCoins()}</div>
      </section>
      <section class="coin-search-section">
        <div class="coin-search-section-head">
          <h5>RECENTLY SEARCHED</h5>
          <button type="button" class="coin-search-clear" data-clear-searches>Clear</button>
        </div>
        <div class="coin-search-list">${renderRecentSearches()}</div>
      </section>
      <section class="coin-search-section">
        <div class="coin-search-section-head">
          <h5>RECENTLY VIEWED</h5>
          <button type="button" class="coin-search-clear" data-clear-viewed>Clear</button>
        </div>
        <div class="coin-search-list">${renderRecentViewed()}</div>
      </section>
    `;
    hydrateHotSparklines().catch(() => {
      // keep static fallback if gecko fails
    });
  }

  async function ensureData() {
    if (state.loading || state.loaded) return;
    state.loading = true;
    renderEmpty();
    try {
      const [ethUsd, launchesRes] = await Promise.all([fetchEthUsdPrice(false), api.launches(120, 0)]);
      if (Number.isFinite(ethUsd) && ethUsd > 0) state.ethUsd = ethUsd;
      state.launches = launchesRes?.launches || [];
      await hydrateUserProfiles(state.launches.map((launch) => launch.creator));
      state.loaded = true;
      renderBody();
    } catch {
      state.loaded = true;
      state.launches = [];
      renderBody();
    } finally {
      state.loading = false;
    }
  }

  function open(initialQuery = "") {
    state.query = String(initialQuery || "").trim();
    overlay.classList.add("open");
    state.open = true;
    document.body.classList.add("coin-search-open");
    input.value = state.query;
    if (state.loaded) {
      renderBody();
      const walletAddress = normalizeWalletQuery(state.query);
      if (walletAddress) {
        ensureWalletProfile(walletAddress).catch(() => {
          // best effort
        });
      }
    } else {
      renderEmpty();
      ensureData().catch(() => {
        // handled in ensureData
      });
    }
    setTimeout(() => input.focus(), 0);
  }

  function close() {
    overlay.classList.remove("open");
    state.open = false;
    document.body.classList.remove("coin-search-open");
  }

  for (const trigger of inputs) {
    trigger.addEventListener("focus", () => open(trigger.value));
    trigger.addEventListener("click", () => open(trigger.value));
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  modal.addEventListener("click", (event) => {
    const openTokenBtn = event.target.closest("[data-open-token]");
    if (openTokenBtn) {
      const token = String(openTokenBtn.dataset.openToken || "");
      if (token) {
        const launch = state.launches.find((row) => String(row?.token || "").toLowerCase() === token.toLowerCase()) || null;
        addRecentSearch(state.query || token);
        close();
        openToken(token, launch);
      }
      return;
    }

    const openProfileBtn = event.target.closest("[data-open-profile]");
    if (openProfileBtn) {
      const address = String(openProfileBtn.dataset.openProfile || "").trim();
      if (isWalletAddress(address)) {
        addRecentSearch(state.query || address);
        close();
        window.location.href = `/profile?address=${address}`;
      } else {
        close();
        window.location.href = "/profile";
      }
      return;
    }

    const fillTermBtn = event.target.closest("[data-fill-term]");
    if (fillTermBtn) {
      const term = String(fillTermBtn.dataset.fillTerm || "");
      state.query = term;
      input.value = term;
      renderBody();
      input.focus();
      return;
    }

    if (event.target.closest("[data-clear-searches]")) {
      clearRecentSearches();
      renderBody();
      return;
    }

    if (event.target.closest("[data-clear-viewed]")) {
      clearRecentViewed();
      renderBody();
    }
  });

  input.addEventListener("input", () => {
    state.query = input.value.trim();
    renderBody();
    const walletAddress = normalizeWalletQuery(state.query);
    if (walletAddress) {
      ensureWalletProfile(walletAddress).catch(() => {
        // best effort
      });
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === "Enter") {
      const query = state.query.trim();
      if (!query) return;
      addRecentSearch(query);
      const walletAddress = normalizeWalletQuery(query);
      if (walletAddress) {
        close();
        window.location.href = `/profile?address=${walletAddress}`;
        return;
      }
      const first = state.launches.find((launch) => {
        const q = query.toLowerCase();
        return (
          String(launch.name || "").toLowerCase().includes(q) ||
          String(launch.symbol || "").toLowerCase().includes(q) ||
          String(launch.token || "").toLowerCase().includes(q)
        );
      });
      if (first?.token) {
        close();
        openToken(first.token, first);
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!state.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
}
