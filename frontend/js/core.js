import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm";

export { ethers };

export const FACTORY_ABI = [
  "event LaunchCreated(uint256 indexed launchId,address indexed creator,address indexed token,address pool,uint256 totalSupply,uint256 creatorAllocation,uint256 feeBps,uint256 graduationTargetEth,address dexRouter,address lpRecipient)",
  "function createLaunch(string name,string symbol,string imageURI,string description,uint256 totalSupply,uint256 creatorAllocationBps) payable returns (uint256 launchId,address tokenAddress,address poolAddress)",
  "function createLaunchInstant(string name,string symbol,string imageURI,string description,uint256 totalSupply,uint256 creatorAllocationBps) payable returns (uint256 launchId,address tokenAddress,address poolAddress)",
  "function getLaunchCount() view returns (uint256)",
  "function getLaunch(uint256 launchId) view returns ((address token,address pool,address creator,string name,string symbol,string imageURI,string description,uint256 totalSupply,uint256 creatorAllocation,uint256 createdAt))"
];

export const POOL_ABI = [
  "function buy(uint256 minTokensOut) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokenAmountIn,uint256 minEthOut) returns (uint256 ethOut)",
  "function quoteBuy(uint256 ethAmountIn) view returns (uint256 tokensOut,uint256 feePaid)",
  "function quoteSell(uint256 tokenAmountIn) view returns (uint256 ethOut,uint256 feePaid)"
];

export const TOKEN_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function creator() view returns (address)",
  "function creatorClaimable() view returns (uint256)",
  "function platformFeeRecipient() view returns (address)",
  "function platformClaimable() view returns (uint256)",
  "function claimCreatorFees() returns (uint256)",
  "function claimPlatformFees() returns (uint256)"
];

export const ROUTER_ABI = [
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn,address[] calldata path) view returns (uint256[] memory amounts)",
  "function getAmountsIn(uint256 amountOut,address[] calldata path) view returns (uint256[] memory amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) payable returns (uint256[] memory amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) returns (uint256[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline)"
];

const state = {
  provider: null,
  signer: null,
  address: "",
  walletLabel: "",
  activeInjectedProvider: null,
  wallets: []
};

const walletListenersAttached = new WeakSet();
const eip6963Providers = new Map();
let eip6963Listening = false;
let eip6963Requested = false;
const providerIds = new WeakMap();
let providerIdCounter = 0;
const WALLET_SESSION_KEY = "etherpump.wallet.session.v1";
const PROFILE_STORAGE_KEY = "etherpump.profile.v1";
const PROFILE_REMOTE_FRESH_KEY = "etherpump.profile.remotefresh.v1";
const ETH_USD_CACHE_KEY = "etherpump.ethusd.v1";
const CHAIN_PREFERENCE_KEY = "etherpump.chain.preferred.v1";
const ETH_USD_FALLBACK = 3000;
const ETH_USD_CACHE_TTL_MS = 5 * 60 * 1000;
const PROFILE_REMOTE_TTL_MS = 10 * 1000;
const PROFILE_IMAGE_URI_MAX_LENGTH = 2 * 1024 * 1024;
const profileInFlight = new Map();

export function getPreferredChainId() {
  try {
    const raw = localStorage.getItem(CHAIN_PREFERENCE_KEY);
    const value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}

export function setPreferredChainId(chainId) {
  const value = Number(chainId || 0);
  if (!Number.isFinite(value) || value <= 0) return;
  try {
    localStorage.setItem(CHAIN_PREFERENCE_KEY, String(Math.floor(value)));
  } catch {
    // ignore storage write failures
  }
}

async function syncPreferredChainIdFromProvider(provider) {
  if (!provider) return null;
  try {
    const chainHex = await provider.send("eth_chainId", []);
    const chainId = Number.parseInt(String(chainHex || "0"), 16);
    if (Number.isFinite(chainId) && chainId > 0) {
      setPreferredChainId(chainId);
      return chainId;
    }
  } catch {
    // fallback below
  }

  try {
    const network = await provider.getNetwork();
    const chainId = Number(network?.chainId || 0);
    if (Number.isFinite(chainId) && chainId > 0) {
      setPreferredChainId(chainId);
      return chainId;
    }
  } catch {
    // ignore
  }
  return null;
}

function loadWalletSession() {
  try {
    const raw = localStorage.getItem(WALLET_SESSION_KEY);
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") return { connected: false, choice: "" };
    const choice = typeof parsed.choice === "string" ? parsed.choice : "";
    return { connected: Boolean(parsed.connected), choice };
  } catch {
    return { connected: false, choice: "" };
  }
}

function saveWalletSession(partial = {}) {
  const prev = loadWalletSession();
  const next = {
    connected: typeof partial.connected === "boolean" ? partial.connected : prev.connected,
    choice: typeof partial.choice === "string" ? partial.choice : prev.choice || ""
  };
  try {
    localStorage.setItem(WALLET_SESSION_KEY, JSON.stringify(next));
  } catch {
    // ignore storage write failures
  }
}

export function getSavedWalletChoice() {
  return loadWalletSession().choice || "";
}

export function saveWalletChoice(choice = "") {
  saveWalletSession({ choice: String(choice || "") });
}

export function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatEth(weiLike, max = 6) {
  const n = Number(ethers.formatUnits(weiLike, 18));
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

export function formatToken(amountLike, decimals = 18, max = 2) {
  const n = Number(ethers.formatUnits(amountLike, decimals));
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

export function formatCompactUsd(value, maxFractionDigits = 1) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "$0";
  const abs = Math.abs(numeric);
  const fractionDigits = abs >= 100 ? 0 : maxFractionDigits;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: fractionDigits
  }).format(numeric);
}

export function ethToUsd(ethLike, ethUsd = ETH_USD_FALLBACK) {
  const eth = Number(ethLike || 0);
  const usd = eth * Number(ethUsd || ETH_USD_FALLBACK);
  return Number.isFinite(usd) ? usd : 0;
}

export function weiToUsd(weiLike, ethUsd = ETH_USD_FALLBACK) {
  const eth = Number(ethers.formatUnits(weiLike || "0", 18));
  return ethToUsd(eth, ethUsd);
}

function readEthUsdCache() {
  try {
    const raw = localStorage.getItem(ETH_USD_CACHE_KEY);
    const parsed = JSON.parse(raw || "{}");
    const price = Number(parsed?.price || 0);
    const ts = Number(parsed?.ts || 0);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) return null;
    return { price, ts };
  } catch {
    return null;
  }
}

function saveEthUsdCache(price) {
  try {
    localStorage.setItem(ETH_USD_CACHE_KEY, JSON.stringify({ price, ts: Date.now() }));
  } catch {
    // ignore cache write failure
  }
}

export async function fetchEthUsdPrice(force = false) {
  const cached = readEthUsdCache();
  if (!force && cached && Date.now() - cached.ts < ETH_USD_CACHE_TTL_MS) {
    return cached.price;
  }

  const sources = [
    async () => {
      const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { cache: "no-store" });
      if (!res.ok) throw new Error("coinbase failed");
      const json = await res.json();
      const price = Number(json?.data?.amount || 0);
      if (!Number.isFinite(price) || price <= 0) throw new Error("coinbase invalid");
      return price;
    },
    async () => {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { cache: "no-store" });
      if (!res.ok) throw new Error("coingecko failed");
      const json = await res.json();
      const price = Number(json?.ethereum?.usd || 0);
      if (!Number.isFinite(price) || price <= 0) throw new Error("coingecko invalid");
      return price;
    }
  ];

  for (const source of sources) {
    try {
      const price = await source();
      saveEthUsdCache(price);
      return price;
    } catch {
      // try next provider
    }
  }

  if (cached?.price) return cached.price;
  return ETH_USD_FALLBACK;
}

export function parseUiError(err) {
  const msg =
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.reason ||
    err?.message ||
    "Unknown error";

  const clean = msg.replace("execution reverted: ", "");

  if (clean.toLowerCase().includes("missing revert data")) {
    return "Wallet could not estimate this transaction. Try a smaller trade or retry.";
  }

  return clean;
}

function sanitizeTokenSymbol(symbol = "") {
  const text = String(symbol || "").trim().toUpperCase();
  if (!text) return "ETH";
  return text.slice(0, 6);
}

function stringToHue(input = "") {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export function makeFallbackImage(name = "", symbol = "") {
  const label = sanitizeTokenSymbol(symbol || name);
  const hue = stringToHue(`${name}:${symbol}`);
  const hue2 = (hue + 70) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>
    <defs>
      <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0%' stop-color='hsl(${hue} 72% 55%)'/>
        <stop offset='100%' stop-color='hsl(${hue2} 78% 38%)'/>
      </linearGradient>
    </defs>
    <rect width='400' height='400' fill='#120b22'/>
    <circle cx='320' cy='78' r='120' fill='url(#g)' opacity='0.8'/>
    <circle cx='80' cy='340' r='145' fill='url(#g)' opacity='0.7'/>
    <rect x='24' y='24' width='352' height='352' rx='36' fill='none' stroke='rgba(255,255,255,.28)' stroke-width='2'/>
    <text x='200' y='222' text-anchor='middle' fill='white' font-family='Arial' font-size='66' font-weight='700'>${label}</text>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function resolveCoinImage(coin) {
  const raw = String(coin?.imageURI || "").trim();
  if (raw) {
    try {
      const parsed = new URL(raw, window.location.origin);
      const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      const isStaticAsset = parsed.pathname.startsWith("/uploads/") || parsed.pathname.startsWith("/assets/");
      if (isLocalHost && isStaticAsset) {
        return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {
      // Keep raw image URL fallback.
    }
    return raw;
  }
  return makeFallbackImage(coin?.name || "", coin?.symbol || "");
}

function ensureEip6963Discovery() {
  if (typeof window === "undefined") return;
  if (!eip6963Listening) {
    window.addEventListener("eip6963:announceProvider", (event) => {
      const provider = event?.detail?.provider;
      if (!provider) return;
      const info = event?.detail?.info || {};
      eip6963Providers.set(provider, { provider, info });
    });
    eip6963Listening = true;
  }
  if (!eip6963Requested) {
    eip6963Requested = true;
    try {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch {
      // ignore
    }
  }
}

function getProviderLocalId(provider) {
  if (!provider) return "unknown";
  const existing = providerIds.get(provider);
  if (existing) return existing;
  providerIdCounter += 1;
  const next = `p${providerIdCounter}`;
  providerIds.set(provider, next);
  return next;
}

function getWalletMeta(injected, info = null) {
  const infoName = String(info?.name || "").trim();
  const hint = `${String(info?.rdns || "")} ${infoName}`.toLowerCase();
  const providerLocalId = getProviderLocalId(injected);
  const infoIdRaw = String(info?.uuid || info?.rdns || infoName || "").trim().toLowerCase();
  const infoId = infoIdRaw.replace(/[^a-z0-9._:-]/g, "-");
  const mk = (key, label) => ({
    id: `${key}:${infoId || providerLocalId}`,
    key,
    label,
    provider: injected
  });

  if (!injected) return mk("unknown", infoName || "Unknown");
  if (hint.includes("phantom") || injected.isPhantom) {
    return mk("phantom", infoName || "Phantom");
  }
  if (injected.isRabby || hint.includes("rabby")) {
    return mk("rabby", infoName || "Rabby");
  }
  if (injected.isMetaMask || hint.includes("metamask")) {
    return mk("metamask", infoName || "MetaMask");
  }
  if (injected.isCoinbaseWallet || hint.includes("coinbase")) {
    return mk("coinbase", infoName || "Coinbase");
  }
  return mk("injected", infoName || "Injected");
}

export function discoverWallets() {
  ensureEip6963Discovery();

  const providers = [];
  for (const row of eip6963Providers.values()) {
    providers.push({ provider: row.provider, info: row.info || null });
  }

  const root = window.ethereum;
  if (root) {
    const injected = Array.isArray(root.providers) && root.providers.length ? root.providers : [root];
    for (const provider of injected) {
      providers.push({ provider, info: null });
    }
  }

  if (!providers.length) {
    state.wallets = [];
    return [];
  }

  const seen = new Set();
  const list = [];

  for (const entry of providers) {
    const provider = entry?.provider;
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    list.push(getWalletMeta(provider, entry?.info || null));
  }

  state.wallets = list;
  return list;
}

export function populateWalletSelect(selectEl) {
  if (!selectEl) return;

  const wallets = discoverWallets();
  const prev = selectEl.value || getSavedWalletChoice() || "metamask";
  const options = [];

  const has = new Set();
  for (const wallet of wallets) {
    if (wallet.key === "metamask" && !has.has("metamask")) {
      options.push({ value: "metamask", label: "MetaMask" });
      has.add("metamask");
      continue;
    }
    if (wallet.key === "rabby" && !has.has("rabby")) {
      options.push({ value: "rabby", label: "Rabby" });
      has.add("rabby");
      continue;
    }
    if (wallet.key === "coinbase" && !has.has("coinbase")) {
      options.push({ value: "coinbase", label: "Coinbase" });
      has.add("coinbase");
    }
  }

  selectEl.innerHTML = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join("");

  const values = new Set(options.map((opt) => opt.value));
  if (!values.size) {
    selectEl.innerHTML = `<option value="">No wallet detected</option>`;
    selectEl.value = "";
  } else if (values.has(prev)) {
    selectEl.value = prev;
  } else if (values.has("metamask")) {
    selectEl.value = "metamask";
  } else {
    selectEl.value = options[0].value;
  }
}

function resolveWallet(choice = "metamask") {
  const wallets = discoverWallets();
  if (!wallets.length) return null;
  if (!choice) return wallets[0];
  const byId = wallets.find((w) => w.id === choice);
  if (byId) return byId;
  const byKey = wallets.find((w) => w.key === choice);
  if (byKey) return byKey;
  const keyFromComposite = String(choice).split(":")[0];
  if (keyFromComposite) {
    const byParsedKey = wallets.find((w) => w.key === keyFromComposite);
    if (byParsedKey) return byParsedKey;
  }
  return wallets[0];
}

export async function connectWallet(choice = "", options = {}) {
  const silent = Boolean(options?.silent);
  const wallet = resolveWallet(choice || "");
  if (!wallet?.provider) {
    throw new Error("No injected wallet detected.");
  }

  if (!state.provider || state.activeInjectedProvider !== wallet.provider) {
    state.provider = new ethers.BrowserProvider(wallet.provider);
    state.activeInjectedProvider = wallet.provider;
    state.signer = null;
    state.address = "";
    state.walletLabel = wallet.label;
  }

  if (!silent && wallet.key === "metamask" && wallet.provider.request) {
    try {
      await wallet.provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }]
      });
    } catch {
      // optional
    }
  }

  const method = silent ? "eth_accounts" : "eth_requestAccounts";
  const accounts = await state.provider.send(method, []);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    if (silent) return null;
    throw new Error("No wallet account selected");
  }

  state.address = ethers.getAddress(accounts[0]);
  state.signer = await state.provider.getSigner(state.address);
  state.walletLabel = wallet.label;
  await syncPreferredChainIdFromProvider(state.provider);

  if (!walletListenersAttached.has(wallet.provider)) {
    wallet.provider.on?.("accountsChanged", () => window.location.reload());
    wallet.provider.on?.("chainChanged", (nextChain) => {
      const parsed =
        typeof nextChain === "string"
          ? Number.parseInt(nextChain, 16)
          : Number(nextChain || 0);
      if (Number.isFinite(parsed) && parsed > 0) {
        setPreferredChainId(parsed);
      }
      window.location.reload();
    });
    walletListenersAttached.add(wallet.provider);
  }

  // Persist stable wallet key across page reloads; provider IDs may vary by session.
  saveWalletSession({ connected: true, choice: wallet.key });

  return { ...state };
}

export function disconnectWallet() {
  state.provider = null;
  state.signer = null;
  state.address = "";
  state.walletLabel = "";
  state.activeInjectedProvider = null;
  saveWalletSession({ connected: false, choice: "" });
}

export async function restoreWalletFromSession(choice = "") {
  const session = loadWalletSession();
  if (!session.connected) return null;

  const target = choice || session.choice || "metamask";
  const restored = await connectWallet(target, { silent: true });
  if (!restored?.signer || !restored?.address) {
    disconnectWallet();
    return null;
  }
  return restored;
}

export function walletState() {
  return { ...state };
}

export function defaultUsername(address) {
  if (!address) return "Guest";
  return `eth_${String(address).slice(2, 8).toLowerCase()}`;
}

function loadProfilesStore() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore corrupt local profile cache
  }
  return {};
}

function saveProfilesStore(store) {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage write failures
  }
}

function loadProfileFreshStore() {
  try {
    const raw = localStorage.getItem(PROFILE_REMOTE_FRESH_KEY);
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore corrupt timestamp cache
  }
  return {};
}

function saveProfileFreshStore(store) {
  try {
    localStorage.setItem(PROFILE_REMOTE_FRESH_KEY, JSON.stringify(store));
  } catch {
    // ignore storage write failures
  }
}

function normalizeProfileAddress(address) {
  try {
    return ethers.getAddress(String(address || "").trim());
  } catch {
    return "";
  }
}

function normalizeProfileValue(address, value = {}) {
  const normalized = normalizeProfileAddress(address);
  const username = String(value.username || "").trim();
  const bio = String(value.bio || "").trim();
  const imageUri = String(value.imageUri || "").trim();
  return {
    address: normalized,
    username: username || defaultUsername(normalized),
    bio: bio.slice(0, 500),
    imageUri: imageUri.slice(0, PROFILE_IMAGE_URI_MAX_LENGTH)
  };
}

function markProfileFresh(address) {
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return;
  const store = loadProfileFreshStore();
  store[normalized.toLowerCase()] = Date.now();
  saveProfileFreshStore(store);
}

function isProfileFresh(address, ttlMs = PROFILE_REMOTE_TTL_MS) {
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return false;
  const store = loadProfileFreshStore();
  const freshAt = Number(store[normalized.toLowerCase()] || 0);
  if (!Number.isFinite(freshAt) || freshAt <= 0) return false;
  return Date.now() - freshAt < ttlMs;
}

function withPreferredChain(path) {
  const chainId = getPreferredChainId();
  if (!chainId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}chainId=${chainId}`;
}

async function profileApiGet(path) {
  const res = await fetch(withPreferredChain(path), { cache: "no-store" });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      // ignore parse failures
    }
    throw new Error(message);
  }
  return res.json();
}

async function profileApiPost(path, body) {
  const res = await fetch(withPreferredChain(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const payload = await res.json();
      message = payload.error || message;
    } catch {
      // ignore parse failures
    }
    throw new Error(message);
  }
  return res.json();
}

function cacheProfileLocal(address, value = {}) {
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return { username: "Guest", bio: "", imageUri: "", address: "" };
  const store = loadProfilesStore();
  const key = normalized.toLowerCase();
  const next = normalizeProfileValue(normalized, value);
  store[key] = {
    username: next.username,
    bio: next.bio,
    imageUri: next.imageUri
  };
  saveProfilesStore(store);
  markProfileFresh(normalized);
  return next;
}

export function loadUserProfile(address) {
  if (!address) return { username: "Guest", bio: "", imageUri: "", address: "" };
  const store = loadProfilesStore();
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return { username: defaultUsername(address), bio: "", imageUri: "", address: "" };
  const key = normalized.toLowerCase();
  const row = store[key] || {};
  return normalizeProfileValue(normalized, row);
}

export async function hydrateUserProfile(address, options = {}) {
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return loadUserProfile(address);
  const force = Boolean(options?.force);
  if (!force && isProfileFresh(normalized)) {
    return loadUserProfile(normalized);
  }
  const key = normalized.toLowerCase();
  if (profileInFlight.has(key)) {
    return profileInFlight.get(key);
  }
  const task = (async () => {
    try {
      const remote = await profileApiGet(`/api/user-profile/${normalized}`);
      cacheProfileLocal(normalized, remote || {});
      return loadUserProfile(normalized);
    } catch {
      return loadUserProfile(normalized);
    } finally {
      profileInFlight.delete(key);
    }
  })();
  profileInFlight.set(key, task);
  return task;
}

export async function hydrateUserProfiles(addresses = [], options = {}) {
  const force = Boolean(options?.force);
  const deduped = [...new Set((Array.isArray(addresses) ? addresses : []).map((row) => normalizeProfileAddress(row)).filter(Boolean))];
  if (!deduped.length) return {};

  const targets = force ? deduped : deduped.filter((address) => !isProfileFresh(address));
  if (targets.length) {
    try {
      const payload = await profileApiPost("/api/user-profiles", { addresses: targets });
      const rows = payload?.profiles && typeof payload.profiles === "object" ? payload.profiles : {};
      for (const [key, value] of Object.entries(rows)) {
        cacheProfileLocal(key, value || {});
      }
      for (const missed of targets) {
        if (!rows[missed.toLowerCase()]) {
          markProfileFresh(missed);
        }
      }
    } catch {
      await Promise.allSettled(targets.map((address) => hydrateUserProfile(address, { force: true })));
    }
  }

  const out = {};
  for (const address of deduped) {
    out[address.toLowerCase()] = loadUserProfile(address);
  }
  return out;
}

export async function saveUserProfile(address, value = {}) {
  const normalized = normalizeProfileAddress(address);
  if (!normalized) return { username: "Guest", bio: "", imageUri: "", address: "", synced: false };
  const existing = loadUserProfile(normalized);
  const local = cacheProfileLocal(normalized, {
    username: value.username ?? existing.username,
    bio: value.bio ?? existing.bio,
    imageUri: value.imageUri ?? existing.imageUri
  });
  try {
    const remote = await profileApiPost(`/api/user-profile/${normalized}`, local);
    const next = cacheProfileLocal(normalized, remote || local);
    return { ...next, synced: true };
  } catch (error) {
    return {
      ...local,
      synced: false,
      error: String(error?.message || "Profile sync failed")
    };
  }
}

async function getPendingNonce() {
  if (!state.signer || !state.provider) {
    throw new Error("Wallet not connected");
  }

  const address = state.address || (await state.signer.getAddress());

  if (state.activeInjectedProvider?.request) {
    try {
      const hex = await state.activeInjectedProvider.request({
        method: "eth_getTransactionCount",
        params: [address, "pending"]
      });
      if (typeof hex === "string" && hex.startsWith("0x")) {
        return Number(BigInt(hex));
      }
    } catch {
      // fallback below
    }
  }

  return state.provider.getTransactionCount(address, "pending");
}

function cleanTx(raw) {
  const tx = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v !== undefined && v !== null) tx[k] = v;
  }
  return tx;
}

export async function sendTxWithFallback({ populatedTx, walletNativeSend, label = "Transaction" }) {
  if (!state.signer || !state.provider) {
    throw new Error("Wallet not connected");
  }

  try {
    const txRaw = await populatedTx;
    const tx = cleanTx(txRaw);
    tx.nonce = await getPendingNonce();

    if (tx.gasLimit === undefined) {
      try {
        const gas = await state.signer.estimateGas(tx);
        tx.gasLimit = (gas * 120n) / 100n;
      } catch {
        // wallet can estimate
      }
    }

    return await state.signer.sendTransaction(cleanTx(tx));
  } catch (err) {
    const text = parseUiError(err).toLowerCase();
    const mm = (state.walletLabel || "").toLowerCase().includes("metamask");
    const fallbackEligible = mm && (
      text.includes("missing revert data") ||
      text.includes("internal json-rpc error") ||
      text.includes("could not coalesce error")
    );

    if (!fallbackEligible || !walletNativeSend) {
      throw err;
    }

    return walletNativeSend();
  }
}

export function makeFactoryContract(factoryAddress) {
  if (!state.signer) {
    throw new Error("Connect wallet first");
  }
  return new ethers.Contract(factoryAddress, FACTORY_ABI, state.signer);
}

export function makePoolContract(poolAddress) {
  if (!state.signer) {
    throw new Error("Connect wallet first");
  }
  return new ethers.Contract(poolAddress, POOL_ABI, state.signer);
}

export function makeTokenContract(tokenAddress) {
  if (!state.signer) {
    throw new Error("Connect wallet first");
  }
  return new ethers.Contract(tokenAddress, TOKEN_ABI, state.signer);
}

export function makeRouterContract(routerAddress) {
  if (!state.signer) {
    throw new Error("Connect wallet first");
  }
  return new ethers.Contract(routerAddress, ROUTER_ABI, state.signer);
}
