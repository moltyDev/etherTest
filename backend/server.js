const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { ethers } = require("ethers");

dotenv.config({ override: true });

const app = express();
const PORT = Number(process.env.PORT || 4173);

const ROOT = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const DEPLOYMENT_PATH = path.join(FRONTEND_DIR, "deployment.json");
const UPLOADS_DIR = path.join(FRONTEND_DIR, "uploads");
const IS_VERCEL_RUNTIME = Boolean(process.env.VERCEL);
const UPLOAD_MODE = String(process.env.UPLOAD_MODE || (IS_VERCEL_RUNTIME ? "inline" : "disk")).toLowerCase();
const PROFILE_DB_PATH = IS_VERCEL_RUNTIME ? path.join("/tmp", "etherpump-profiles.json") : path.join(ROOT, "cache", "profiles.json");
const FOLLOW_DB_PATH = IS_VERCEL_RUNTIME ? path.join("/tmp", "etherpump-follows.json") : path.join(ROOT, "cache", "follows.json");
const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ""
).trim();
const SUPABASE_PROFILE_TABLE = String(process.env.SUPABASE_PROFILE_TABLE || "user_profiles").trim();
const SUPABASE_FOLLOW_TABLE = String(process.env.SUPABASE_FOLLOW_TABLE || "user_follows").trim();
const SUPABASE_SCHEMA = String(process.env.SUPABASE_SCHEMA || "public").trim();
const PROFILE_IMAGE_URI_MAX_LENGTH = 2 * 1024 * 1024;
const STRICT_PROFILE_STORE = String(process.env.STRICT_PROFILE_STORE || (IS_VERCEL_RUNTIME ? "1" : "0")) === "1";
const STRICT_SOCIAL_STORE = String(process.env.STRICT_SOCIAL_STORE || (STRICT_PROFILE_STORE ? "1" : "0")) === "1";
// Vercel runtime filesystem is ephemeral/read-only for project paths. Force inline mode there.
const USE_DISK_UPLOADS = !IS_VERCEL_RUNTIME && UPLOAD_MODE !== "inline";

const FACTORY_ARTIFACT = require(path.join(ROOT, "artifacts", "contracts", "MemeLaunchFactory.sol", "MemeLaunchFactory.json"));
const POOL_ARTIFACT = require(path.join(ROOT, "artifacts", "contracts", "MemePool.sol", "MemePool.json"));
const TOKEN_ARTIFACT = require(path.join(ROOT, "artifacts", "contracts", "MemeToken.sol", "MemeToken.json"));
const V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];
const V2_ROUTER_ABI = ["function WETH() view returns (address)"];
const GECKO_NETWORK_BY_CHAIN = {
  1: "eth",
  11155111: "sepolia-testnet"
};
const DEXSCREENER_CHAIN_BY_ID = {
  1: "ethereum",
  11155111: "sepolia"
};

app.use(cors());
app.use(express.json({ limit: "2mb" }));

if (USE_DISK_UPLOADS && !fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const contextCache = new Map();

const LAUNCHES_CACHE_TTL_MS = 2_500;
const POOL_SNAPSHOT_CACHE_TTL_MS = 1_500;
const STATS_CACHE_TTL_MS = 6_000;
const TOKEN_CACHE_TTL_MS = 1_500;
const PROFILE_CACHE_TTL_MS = 4_000;
const PROFILE_SOCIAL_CACHE_TTL_MS = 10_000;
const PARTICIPANTS_CACHE_TTL_MS = 10_000;
const GECKO_POOL_CACHE_TTL_MS = 5_000;
const GECKO_TRADES_CACHE_TTL_MS = 3_000;
const DEX_TOKEN_CACHE_TTL_MS = 4_000;
const MAX_LAUNCH_READ_CONCURRENCY = 8;
const MAX_BALANCE_READ_CONCURRENCY = 10;
const MAX_SOCIAL_POOL_CONCURRENCY = 3;
const LOG_LOOKBACK_BLOCKS = Math.max(120, Number(process.env.LOG_LOOKBACK_BLOCKS || 1200));
const DEX_LOG_LOOKBACK_BLOCKS = Math.max(40, Number(process.env.DEX_LOG_LOOKBACK_BLOCKS || 220));
const TOKEN_TRADES_RESPONSE_LIMIT = Math.max(20, Math.min(200, Number(process.env.TOKEN_TRADES_RESPONSE_LIMIT || 80)));
const TOKEN_CHART_RESPONSE_LIMIT = Math.max(20, Math.min(240, Number(process.env.TOKEN_CHART_RESPONSE_LIMIT || 120)));
const DEFAULT_LOG_RANGE = Math.max(5, Number(process.env.DEFAULT_LOG_RANGE || 45000));
const MIN_LOG_RANGE = Math.max(1, Number(process.env.MIN_LOG_RANGE || 5));
const CREATOR_CLAIM_LOOKBACK_BLOCKS = Math.max(
  LOG_LOOKBACK_BLOCKS,
  Number(process.env.CREATOR_CLAIM_LOOKBACK_BLOCKS || 500000)
);
const ENABLE_ONCHAIN_LOG_TRADES = String(process.env.ENABLE_ONCHAIN_LOG_TRADES || "0") === "1";
const ENABLE_ONCHAIN_SOCIAL_LOGS = String(process.env.ENABLE_ONCHAIN_SOCIAL_LOGS || "0") === "1";
const ENABLE_ONCHAIN_CLAIM_HISTORY = String(process.env.ENABLE_ONCHAIN_CLAIM_HISTORY || "0") === "1";

const launchesCache = new Map();
const launchListCache = new Map();
const poolSnapshotCache = new Map();
const tokenCache = new Map();
const statsCache = new Map();
const profileCache = new Map();
const participantsCache = new Map();
const geckoPoolCache = new Map();
const geckoTradesCache = new Map();
const dexTokenCache = new Map();
const geckoIndexedSticky = new Set();
const pairTradesCache = new Map();
let profileDbCache = null;
let followDbCache = null;
const profileLastKnownCache = new Map();

function getCachedValue(cache, key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() >= row.expiresAt) {
    cache.delete(key);
    return null;
  }
  return row.value;
}

function setCachedValue(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function withCache(cache, key, ttlMs, builder) {
  const cached = getCachedValue(cache, key);
  if (cached) return cached;
  const value = await builder();
  setCachedValue(cache, key, value, ttlMs);
  return value;
}

function isLogRangeLimitError(error) {
  const text = String(
    error?.shortMessage || error?.message || error?.error?.message || error?.info?.error?.message || ""
  ).toLowerCase();
  return text.includes("eth_getlogs is limited") || text.includes("limited to a 5 range");
}

async function queryFilterAdaptive(pool, filter, fromBlock, toBlock, initialRange = DEFAULT_LOG_RANGE) {
  const out = [];
  let range = Math.max(MIN_LOG_RANGE, Number(initialRange || DEFAULT_LOG_RANGE));
  let start = Number(fromBlock || 0);
  const endAll = Number(toBlock || 0);

  while (start <= endAll) {
    const end = Math.min(endAll, start + range);
    try {
      const rows = await pool.queryFilter(filter, start, end);
      out.push(...rows);
      start = end + 1;
    } catch (error) {
      if (!isLogRangeLimitError(error)) {
        throw error;
      }

      if (range <= MIN_LOG_RANGE) {
        // Provider is still rejecting tiny windows; skip this slice instead of failing whole payload.
        start = end + 1;
        continue;
      }

      range = Math.max(MIN_LOG_RANGE, Math.floor(range / 2));
    }
  }

  return out;
}

function loadDeploymentConfig() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error(`Missing deployment config at ${DEPLOYMENT_PATH}`);
  }

  const raw = fs.readFileSync(DEPLOYMENT_PATH, "utf8");
  const config = JSON.parse(raw);

  if (!config?.memeLaunchFactory || !ethers.isAddress(config.memeLaunchFactory)) {
    throw new Error("deployment.json missing valid memeLaunchFactory");
  }

  return config;
}

function parseChainId(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function parseJsonObjectEnv(key) {
  const raw = String(process.env[key] || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function readFactoryMapFromEnv() {
  const map = new Map();

  const jsonMap = parseJsonObjectEnv("FACTORY_ADDRESSES");
  for (const [chain, address] of Object.entries(jsonMap)) {
    const chainId = parseChainId(chain);
    if (!chainId || !ethers.isAddress(address)) continue;
    map.set(chainId, ethers.getAddress(address));
  }

  for (const [key, value] of Object.entries(process.env)) {
    const m = key.match(/^FACTORY_ADDRESS_(\d+)$/);
    if (!m) continue;
    const chainId = parseChainId(m[1]);
    if (!chainId || !ethers.isAddress(value)) continue;
    map.set(chainId, ethers.getAddress(value));
  }

  const envChain = parseChainId(process.env.CHAIN_ID);
  const envFactory = String(process.env.FACTORY_ADDRESS || "").trim();
  if (envChain && ethers.isAddress(envFactory)) {
    map.set(envChain, ethers.getAddress(envFactory));
  }

  return map;
}

function resolveFactoryAddress(chainId, deployment) {
  const envMap = readFactoryMapFromEnv();
  if (envMap.has(chainId)) {
    return envMap.get(chainId);
  }

  const deploymentChain = parseChainId(deployment?.chainId);
  if (deploymentChain === chainId && ethers.isAddress(deployment?.memeLaunchFactory)) {
    return ethers.getAddress(deployment.memeLaunchFactory);
  }

  throw new Error(`No factory configured for chain ${chainId}`);
}

function defaultChainIdFromConfig(deployment) {
  const envChain = parseChainId(process.env.CHAIN_ID);
  if (envChain) return envChain;
  const deploymentChain = parseChainId(deployment?.chainId);
  if (deploymentChain) return deploymentChain;
  return 1;
}

function resolveRequestedChainId(req, deployment) {
  const fallback = defaultChainIdFromConfig(deployment);
  const requested = parseChainId(req?.query?.chainId || req?.headers?.["x-chain-id"]);
  if (!requested) return fallback;

  try {
    resolveFactoryAddress(requested, deployment);
    return requested;
  } catch {
    return fallback;
  }
}

function resolveSupportedChains(deployment) {
  const map = readFactoryMapFromEnv();
  const deploymentChain = parseChainId(deployment?.chainId);
  if (deploymentChain && ethers.isAddress(deployment?.memeLaunchFactory) && !map.has(deploymentChain)) {
    map.set(deploymentChain, ethers.getAddress(deployment.memeLaunchFactory));
  }

  return [...map.entries()]
    .map(([chainId, factoryAddress]) => ({
      chainId,
      factoryAddress,
      explorerBaseUrl: explorerBaseForChain(chainId)
    }))
    .sort((a, b) => a.chainId - b.chainId);
}

function pickRpcUrls(chainId) {
  const urls = [];
  const pushIf = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    if (!urls.includes(text)) urls.push(text);
  };

  pushIf(process.env.RPC_URL);
  pushIf(process.env[`RPC_URL_${chainId}`]);

  const rpcJsonMap = parseJsonObjectEnv("RPC_URLS_BY_CHAIN");
  if (rpcJsonMap && Object.prototype.hasOwnProperty.call(rpcJsonMap, String(chainId))) {
    const value = rpcJsonMap[String(chainId)];
    if (Array.isArray(value)) {
      for (const row of value) pushIf(row);
    } else {
      pushIf(value);
    }
  }

  if (chainId === 31337) {
    pushIf(process.env.LOCAL_RPC_URL);
    pushIf("http://127.0.0.1:8545");
    return urls;
  }

  if (chainId === 11155111) {
    pushIf(process.env.SEPOLIA_RPC_URL);
    pushIf("https://ethereum-sepolia-rpc.publicnode.com");
    pushIf("https://rpc.sepolia.org");
    pushIf("https://gateway.tenderly.co/public/sepolia");
    return urls;
  }

  if (chainId === 1) {
    pushIf(process.env.MAINNET_RPC_URL);
    pushIf("https://ethereum-rpc.publicnode.com");
    pushIf("https://rpc.ankr.com/eth");
    pushIf("https://cloudflare-eth.com");
    return urls;
  }

  if (!urls.length) {
    throw new Error(`No RPC URL configured for chain ${chainId}`);
  }

  return urls;
}

async function buildContext(chainId, factoryAddress, deployment = loadDeploymentConfig()) {
  const normalizedChainId = parseChainId(chainId);
  if (!normalizedChainId) {
    throw new Error(`Invalid chainId ${chainId}`);
  }

  if (!ethers.isAddress(factoryAddress)) {
    throw new Error("Invalid FACTORY_ADDRESS");
  }

  const rpcUrls = pickRpcUrls(normalizedChainId);
  let lastError = null;
  let provider = null;
  let factory = null;
  let rpcUrl = rpcUrls[0] || "";

  for (const candidate of rpcUrls) {
    try {
      const p = new ethers.JsonRpcProvider(candidate, normalizedChainId);
      await p.getBlockNumber();
      const f = new ethers.Contract(factoryAddress, FACTORY_ARTIFACT.abi, p);
      await f.getLaunchCount();
      provider = p;
      factory = f;
      rpcUrl = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!provider || !factory) {
    throw new Error(lastError?.message || "Unable to connect to any configured RPC endpoint");
  }

  return {
    deployment,
    chainId: normalizedChainId,
    rpcUrl,
    provider,
    factory,
    factoryAddress: ethers.getAddress(factoryAddress)
  };
}

async function getContext(requestedChainId = null) {
  const deployment = loadDeploymentConfig();
  const chainId = requestedChainId || defaultChainIdFromConfig(deployment);
  const factoryAddress = resolveFactoryAddress(chainId, deployment);
  const key = `${chainId}:${factoryAddress.toLowerCase()}`;

  if (!contextCache.has(key)) {
    contextCache.set(key, await buildContext(chainId, factoryAddress, deployment));
  }

  return contextCache.get(key);
}

function toFloat(weiLike, decimals = 18, max = 8) {
  const n = Number(ethers.formatUnits(weiLike, decimals));
  if (!Number.isFinite(n)) return 0;
  const clamped = Number(n.toFixed(max));
  return clamped;
}

function normalizeAddress(input) {
  try {
    return ethers.getAddress(input);
  } catch {
    return null;
  }
}

function defaultUsername(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return "Guest";
  return `eth_${normalized.slice(2, 8).toLowerCase()}`;
}

function sanitizeProfileValue(address, value = {}) {
  const normalized = normalizeAddress(address);
  const safeAddress = normalized || "";
  const usernameRaw = String(value.username || "").trim();
  const bioRaw = String(value.bio || "").trim();
  const imageRaw = String(value.imageUri || "").trim();
  return {
    address: safeAddress,
    username: usernameRaw || defaultUsername(safeAddress),
    bio: bioRaw.slice(0, 500),
    imageUri: imageRaw.slice(0, PROFILE_IMAGE_URI_MAX_LENGTH)
  };
}

function cacheProfileRow(address, value = {}) {
  const normalized = normalizeAddress(address);
  if (!normalized) return;
  profileLastKnownCache.set(normalized.toLowerCase(), sanitizeProfileValue(normalized, value));
}

function getCachedProfile(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  return profileLastKnownCache.get(normalized.toLowerCase()) || null;
}

function readProfileDb() {
  if (profileDbCache && typeof profileDbCache === "object") {
    return profileDbCache;
  }

  try {
    if (fs.existsSync(PROFILE_DB_PATH)) {
      const raw = fs.readFileSync(PROFILE_DB_PATH, "utf8");
      const parsed = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        profileDbCache = parsed;
        return profileDbCache;
      }
    }
  } catch {
    // fall through to empty store
  }

  profileDbCache = {};
  return profileDbCache;
}

function writeProfileDb(store) {
  fs.mkdirSync(path.dirname(PROFILE_DB_PATH), { recursive: true });
  fs.writeFileSync(PROFILE_DB_PATH, JSON.stringify(store, null, 2));
  profileDbCache = store;
}

function getPersistedProfileSync(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return sanitizeProfileValue("", {});
  }
  const store = readProfileDb();
  const key = normalized.toLowerCase();
  const row = store[key] || {};
  return sanitizeProfileValue(normalized, row);
}

function getPersistedProfilesSync(addresses = []) {
  const out = {};
  for (const raw of addresses) {
    const normalized = normalizeAddress(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    out[key] = getPersistedProfileSync(normalized);
  }
  return out;
}

function setPersistedProfileSync(address, value = {}) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    throw new Error("Invalid address");
  }
  const store = readProfileDb();
  const key = normalized.toLowerCase();
  store[key] = sanitizeProfileValue(normalized, value);
  writeProfileDb(store);
  return store[key];
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_PROFILE_TABLE);
}

function getSupabaseRestUrl(relativePath, query = null) {
  const base = SUPABASE_URL.replace(/\/+$/, "");
  const url = new URL(`${base}/rest/v1/${relativePath.replace(/^\/+/, "")}`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function supabaseRequest(relativePath, { method = "GET", query = null, body = null, prefer = "" } = {}) {
  if (!isSupabaseConfigured()) {
    return null;
  }
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json"
  };
  if (SUPABASE_SCHEMA) {
    headers["Accept-Profile"] = SUPABASE_SCHEMA;
    headers["Content-Profile"] = SUPABASE_SCHEMA;
  }
  if (prefer) {
    headers.Prefer = prefer;
  }
  const init = { method, headers };
  if (body != null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(getSupabaseRestUrl(relativePath, query), init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase ${method} ${relativePath} failed: ${response.status} ${text}`.trim());
  }
  if (response.status === 204) return [];
  const text = await response.text();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function quotedCsv(values = []) {
  const out = [];
  for (const value of values) {
    const safe = String(value || "").replace(/"/g, '\\"');
    out.push(`"${safe}"`);
  }
  return out.join(",");
}

async function getSupabaseProfile(address) {
  const key = String(address || "").toLowerCase();
  const rows = await supabaseRequest(SUPABASE_PROFILE_TABLE, {
    query: {
      select: "address,username,bio,imageUri",
      address: `eq.${key}`,
      limit: 1
    }
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getSupabaseProfiles(addresses = []) {
  if (!addresses.length) return [];
  const rows = await supabaseRequest(SUPABASE_PROFILE_TABLE, {
    query: {
      select: "address,username,bio,imageUri",
      address: `in.(${quotedCsv(addresses.map((row) => String(row || "").toLowerCase()))})`
    }
  });
  return Array.isArray(rows) ? rows : [];
}

async function upsertSupabaseProfile(row) {
  const rows = await supabaseRequest(SUPABASE_PROFILE_TABLE, {
    method: "POST",
    query: {
      on_conflict: "address",
      select: "address,username,bio,imageUri"
    },
    body: [row],
    prefer: "resolution=merge-duplicates,return=representation"
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

function allowFileProfileFallback() {
  // Local/dev can fall back to file store. Production serverless should be strict.
  if (STRICT_PROFILE_STORE) return false;
  return true;
}

function assertProfileStoreConfigured() {
  if (!STRICT_PROFILE_STORE) return;
  if (!isSupabaseConfigured()) {
    throw new Error("Profile store requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in strict mode");
  }
}

async function getPersistedProfile(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return sanitizeProfileValue("", {});

  assertProfileStoreConfigured();

  try {
    if (isSupabaseConfigured()) {
      const row = await getSupabaseProfile(normalized);
      if (row) {
        cacheProfileRow(normalized, row);
        return sanitizeProfileValue(normalized, row);
      }
      const empty = sanitizeProfileValue(normalized, {});
      cacheProfileRow(normalized, empty);
      return empty;
    }
  } catch (error) {
    const cached = getCachedProfile(normalized);
    if (cached) {
      return cached;
    }
    if (!allowFileProfileFallback()) {
      throw new Error(`Supabase profile read failed: ${error?.message || "connection error"}`);
    }
  }

  return getPersistedProfileSync(normalized);
}

async function getPersistedProfiles(addresses = []) {
  const normalized = [...new Set((Array.isArray(addresses) ? addresses : []).map((row) => normalizeAddress(row)).filter(Boolean))];
  if (!normalized.length) return {};

  assertProfileStoreConfigured();

  try {
    if (isSupabaseConfigured()) {
      const keys = normalized.map((row) => row.toLowerCase());
      const rows = await getSupabaseProfiles(keys);
      const byId = new Map(rows.map((row) => [String(row?.address || "").toLowerCase(), row]));
      const out = {};
      for (const address of normalized) {
        const key = address.toLowerCase();
        const profile = sanitizeProfileValue(address, byId.get(key) || {});
        out[key] = profile;
        cacheProfileRow(address, profile);
      }
      return out;
    }
  } catch (error) {
    const cachedOnly = {};
    for (const address of normalized) {
      const hit = getCachedProfile(address);
      if (hit) {
        cachedOnly[address.toLowerCase()] = hit;
      }
    }
    if (Object.keys(cachedOnly).length) {
      return cachedOnly;
    }
    if (!allowFileProfileFallback()) {
      throw new Error(`Supabase profile batch read failed: ${error?.message || "connection error"}`);
    }
  }

  return getPersistedProfilesSync(normalized);
}

async function setPersistedProfile(address, value = {}) {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error("Invalid address");
  const key = normalized.toLowerCase();
  const next = sanitizeProfileValue(normalized, value);

  assertProfileStoreConfigured();

  try {
    if (isSupabaseConfigured()) {
      await upsertSupabaseProfile({
        address: key,
        username: next.username,
        bio: next.bio,
        imageUri: next.imageUri
      });
      cacheProfileRow(normalized, next);
      return next;
    }
  } catch (error) {
    if (!allowFileProfileFallback()) {
      throw new Error(`Supabase profile write failed: ${error?.message || "connection error"}`);
    }
  }

  const saved = setPersistedProfileSync(normalized, next);
  cacheProfileRow(normalized, saved);
  return saved;
}

function readFollowDb() {
  if (followDbCache && typeof followDbCache === "object") {
    return followDbCache;
  }

  try {
    if (fs.existsSync(FOLLOW_DB_PATH)) {
      const raw = fs.readFileSync(FOLLOW_DB_PATH, "utf8");
      const parsed = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        followDbCache = parsed;
        return followDbCache;
      }
    }
  } catch {
    // fall through to empty store
  }

  followDbCache = {};
  return followDbCache;
}

function writeFollowDb(store) {
  fs.mkdirSync(path.dirname(FOLLOW_DB_PATH), { recursive: true });
  fs.writeFileSync(FOLLOW_DB_PATH, JSON.stringify(store, null, 2));
  followDbCache = store;
}

function followEdgeKey(followerAddress, followeeAddress) {
  return `${String(followerAddress || "").toLowerCase()}=>${String(followeeAddress || "").toLowerCase()}`;
}

function parseFollowTimestamp(value) {
  const unix = parseUnixTimestamp(value);
  return unix > 0 ? unix : Math.floor(Date.now() / 1000);
}

function normalizeFollowEdge(row = {}) {
  const follower = normalizeAddress(row.follower || row.from || row.address || "");
  const followee = normalizeAddress(row.followee || row.target || row.to || "");
  if (!follower || !followee) return null;
  return {
    follower,
    followee,
    createdAt: parseFollowTimestamp(row.createdAt || row.created_at || row.inserted_at || row.createdon || row.ts)
  };
}

function listFollowEdgesFromStore(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return { followers: [], following: [] };
  }

  const followers = [];
  const following = [];
  const store = readFollowDb();
  for (const value of Object.values(store)) {
    const edge = normalizeFollowEdge(value);
    if (!edge) continue;
    if (edge.followee.toLowerCase() === normalized.toLowerCase()) {
      followers.push(edge);
    }
    if (edge.follower.toLowerCase() === normalized.toLowerCase()) {
      following.push(edge);
    }
  }

  followers.sort((a, b) => b.createdAt - a.createdAt);
  following.sort((a, b) => b.createdAt - a.createdAt);
  return { followers, following };
}

function hasFollowInStore(followerAddress, followeeAddress) {
  const follower = normalizeAddress(followerAddress);
  const followee = normalizeAddress(followeeAddress);
  if (!follower || !followee) return false;
  const store = readFollowDb();
  return Boolean(store[followEdgeKey(follower, followee)]);
}

function setFollowInStore(followerAddress, followeeAddress, follow = true) {
  const follower = normalizeAddress(followerAddress);
  const followee = normalizeAddress(followeeAddress);
  if (!follower || !followee) throw new Error("Invalid follow addresses");

  const key = followEdgeKey(follower, followee);
  const store = readFollowDb();

  if (follow) {
    store[key] = {
      follower: follower.toLowerCase(),
      followee: followee.toLowerCase(),
      createdAt: Math.floor(Date.now() / 1000)
    };
  } else {
    delete store[key];
  }

  writeFollowDb(store);
}

function isSupabaseFollowConfigured() {
  return Boolean(isSupabaseConfigured() && SUPABASE_FOLLOW_TABLE);
}

function allowFileFollowFallback() {
  // Local/dev can fall back to file store. Production serverless should be strict.
  if (STRICT_SOCIAL_STORE) return false;
  return true;
}

function assertFollowStoreConfigured() {
  if (!STRICT_SOCIAL_STORE) return;
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Follow store requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in strict mode"
    );
  }
  if (!SUPABASE_FOLLOW_TABLE) {
    throw new Error("Follow store requires SUPABASE_FOLLOW_TABLE in strict mode");
  }
}

async function getSupabaseFollowEdgesForAddress(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return { followers: [], following: [] };
  }

  const key = normalized.toLowerCase();
  const [followersRows, followingRows] = await Promise.all([
    supabaseRequest(SUPABASE_FOLLOW_TABLE, {
      query: {
        select: "*",
        followee: `eq.${key}`
      }
    }),
    supabaseRequest(SUPABASE_FOLLOW_TABLE, {
      query: {
        select: "*",
        follower: `eq.${key}`
      }
    })
  ]);

  const followers = (Array.isArray(followersRows) ? followersRows : [])
    .map((row) => normalizeFollowEdge(row))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  const following = (Array.isArray(followingRows) ? followingRows : [])
    .map((row) => normalizeFollowEdge(row))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);

  return { followers, following };
}

async function hasSupabaseFollow(followerAddress, followeeAddress) {
  const follower = normalizeAddress(followerAddress);
  const followee = normalizeAddress(followeeAddress);
  if (!follower || !followee) return false;

  const rows = await supabaseRequest(SUPABASE_FOLLOW_TABLE, {
    query: {
      select: "follower,followee",
      follower: `eq.${follower.toLowerCase()}`,
      followee: `eq.${followee.toLowerCase()}`,
      limit: 1
    }
  });
  return Array.isArray(rows) && rows.length > 0;
}

async function setFollowInSupabase(followerAddress, followeeAddress, follow = true) {
  const follower = normalizeAddress(followerAddress);
  const followee = normalizeAddress(followeeAddress);
  if (!follower || !followee) throw new Error("Invalid follow addresses");

  if (follow) {
    await supabaseRequest(SUPABASE_FOLLOW_TABLE, {
      method: "POST",
      query: {
        on_conflict: "follower,followee"
      },
      body: [
        {
          follower: follower.toLowerCase(),
          followee: followee.toLowerCase()
        }
      ],
      prefer: "resolution=merge-duplicates,return=minimal"
    });
    return;
  }

  await supabaseRequest(SUPABASE_FOLLOW_TABLE, {
    method: "DELETE",
    query: {
      follower: `eq.${follower.toLowerCase()}`,
      followee: `eq.${followee.toLowerCase()}`
    }
  });
}

function mapFollowRows(edges = [], mode = "followers") {
  return edges.map((edge) => {
    const address = mode === "followers" ? edge.follower : edge.followee;
    return {
      address,
      interactions: 1,
      details: [mode === "followers" ? "Follower" : "Following"],
      createdAt: edge.createdAt
    };
  });
}

async function getPersistedSocialGraph(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return { followers: [], following: [] };
  }

  assertFollowStoreConfigured();

  try {
    if (isSupabaseFollowConfigured()) {
      const edges = await getSupabaseFollowEdgesForAddress(normalized);
      return {
        followers: mapFollowRows(edges.followers, "followers"),
        following: mapFollowRows(edges.following, "following")
      };
    }
  } catch (error) {
    if (!allowFileFollowFallback()) {
      throw new Error(`Supabase follow read failed: ${error?.message || "connection error"}`);
    }
    console.warn(`Supabase follow read failed: ${error?.message || "connection error"}`);
  }

  if (!allowFileFollowFallback()) {
    throw new Error("Supabase follow store is unavailable in strict mode");
  }
  const edges = listFollowEdgesFromStore(normalized);
  return {
    followers: mapFollowRows(edges.followers, "followers"),
    following: mapFollowRows(edges.following, "following")
  };
}

async function getFollowState(viewerAddress, targetAddress) {
  const viewer = normalizeAddress(viewerAddress);
  const target = normalizeAddress(targetAddress);
  if (!viewer || !target) {
    return { viewer, target, isFollowing: false, followersCount: 0, followingCount: 0 };
  }

  assertFollowStoreConfigured();

  try {
    if (isSupabaseFollowConfigured()) {
      const [isFollowing, targetSocial, viewerSocial] = await Promise.all([
        hasSupabaseFollow(viewer, target),
        getSupabaseFollowEdgesForAddress(target),
        getSupabaseFollowEdgesForAddress(viewer)
      ]);
      return {
        viewer,
        target,
        isFollowing,
        followersCount: targetSocial.followers.length,
        followingCount: viewerSocial.following.length
      };
    }
  } catch (error) {
    if (!allowFileFollowFallback()) {
      throw new Error(`Supabase follow state failed: ${error?.message || "connection error"}`);
    }
    console.warn(`Supabase follow state failed: ${error?.message || "connection error"}`);
  }

  if (!allowFileFollowFallback()) {
    throw new Error("Supabase follow store is unavailable in strict mode");
  }
  const targetSocial = listFollowEdgesFromStore(target);
  const viewerSocial = listFollowEdgesFromStore(viewer);
  return {
    viewer,
    target,
    isFollowing: hasFollowInStore(viewer, target),
    followersCount: targetSocial.followers.length,
    followingCount: viewerSocial.following.length
  };
}

async function setFollowState(viewerAddress, targetAddress, follow = true) {
  const viewer = normalizeAddress(viewerAddress);
  const target = normalizeAddress(targetAddress);
  if (!viewer || !target) throw new Error("Invalid address");
  if (viewer.toLowerCase() === target.toLowerCase()) {
    throw new Error("You cannot follow yourself");
  }

  assertFollowStoreConfigured();

  let persisted = false;
  try {
    if (isSupabaseFollowConfigured()) {
      await setFollowInSupabase(viewer, target, follow);
      persisted = true;
    }
  } catch (error) {
    if (!allowFileFollowFallback()) {
      throw new Error(`Supabase follow write failed: ${error?.message || "connection error"}`);
    }
    console.warn(`Supabase follow write failed: ${error?.message || "connection error"}`);
  }

  if (!persisted) {
    if (!allowFileFollowFallback()) {
      throw new Error("Supabase follow store is unavailable in strict mode");
    }
    setFollowInStore(viewer, target, follow);
  }

  clearProfileDependentCaches();
  return getFollowState(viewer, target);
}

function clearProfileDependentCaches() {
  launchesCache.clear();
  tokenCache.clear();
  profileCache.clear();
}

function isZeroAddress(input) {
  const normalized = normalizeAddress(input);
  if (!normalized) return true;
  return normalized === ethers.ZeroAddress;
}

function geckoNetworkForChain(chainId) {
  return GECKO_NETWORK_BY_CHAIN[Number(chainId)] || "eth";
}

function dexscreenerChainForChain(chainId) {
  return DEXSCREENER_CHAIN_BY_ID[Number(chainId)] || "ethereum";
}

function buildGeckoPoolUrls(chainId, pairAddress) {
  const pair = normalizeAddress(pairAddress);
  if (!pair || pair === ethers.ZeroAddress) {
    return {
      network: geckoNetworkForChain(chainId),
      poolUrl: "",
      embedUrl: "",
      apiUrl: ""
    };
  }
  const network = geckoNetworkForChain(chainId);
  return {
    network,
    poolUrl: `https://www.geckoterminal.com/${network}/pools/${pair}`,
    embedUrl: `https://www.geckoterminal.com/${network}/pools/${pair}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`,
    apiUrl: `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pair}`
  };
}

function parseUnixTimestamp(input) {
  if (input == null) return 0;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return 0;
    if (input > 1e12) return Math.floor(input / 1000);
    return Math.floor(input);
  }

  const text = String(input).trim();
  if (!text) return 0;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber)) {
    if (asNumber > 1e12) return Math.floor(asNumber / 1000);
    return Math.floor(asNumber);
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed / 1000);
  }
  return 0;
}

function expandScientificNumber(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return text;
  const sign = match[1] || "";
  const intPart = match[2] || "0";
  const fracPart = match[3] || "";
  const exponent = Number(match[4] || "0");
  if (!Number.isFinite(exponent)) return text;

  const digits = `${intPart}${fracPart}`.replace(/^0+/, "") || "0";
  if (digits === "0") return "0";

  const decimalIndex = intPart.length + exponent;
  if (decimalIndex <= 0) {
    return `${sign}0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function parseAmountToWei(amount, decimals = 18) {
  let raw = String(amount ?? "").trim();
  if (!raw) return 0n;
  if (/[eE]/.test(raw)) {
    raw = expandScientificNumber(raw);
  }
  try {
    return ethers.parseUnits(raw, decimals);
  } catch {
    return 0n;
  }
}

async function readGeckoPoolStatus(chainId, pairAddress) {
  const pair = normalizeAddress(pairAddress);
  const urls = buildGeckoPoolUrls(chainId, pair);
  if (!pair || pair === ethers.ZeroAddress) {
    return {
      indexed: false,
      ...urls
    };
  }

  const key = `${urls.network}:${pair.toLowerCase()}`;
  const cached = getCachedValue(geckoPoolCache, key);
  if (cached) {
    return cached;
  }

  let indexed = geckoIndexedSticky.has(key);
  try {
    const response = await fetch(urls.apiUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2500)
    });
    if (response.ok) {
      indexed = true;
      geckoIndexedSticky.add(key);
    }
  } catch {
    // Keep sticky true status once Gecko has indexed this pair.
    indexed = geckoIndexedSticky.has(key);
  }

  const value = {
    indexed,
    ...urls
  };
  setCachedValue(geckoPoolCache, key, value, GECKO_POOL_CACHE_TTL_MS);
  return value;
}

async function readGeckoPoolTrades(chainId, pairAddress, tokenAddress, wethAddress = "") {
  const pair = normalizeAddress(pairAddress);
  if (!pair || pair === ethers.ZeroAddress) return [];

  const network = geckoNetworkForChain(chainId);
  const cacheKey = `${network}:${pair.toLowerCase()}`;
  const cached = getCachedValue(geckoTradesCache, cacheKey);
  if (cached) return cached;

  const token = normalizeAddress(tokenAddress || "");
  const weth = normalizeAddress(wethAddress || "");
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pair}/trades`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3500)
    });

    if (!response.ok) {
      setCachedValue(geckoTradesCache, cacheKey, [], GECKO_TRADES_CACHE_TTL_MS);
      return [];
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const mapped = [];

    for (const row of rows) {
      const attr = row?.attributes || {};
      const sideHint = String(attr.kind || attr.side || "").toLowerCase();
      const side = sideHint.includes("buy") ? "buy" : sideHint.includes("sell") ? "sell" : "";
      if (!side) continue;

      const fromTokenAddress = normalizeAddress(attr.from_token_address || attr.from_address || "");
      const toTokenAddress = normalizeAddress(attr.to_token_address || attr.to_address || "");
      const fromAmountWei = parseAmountToWei(attr.from_token_amount || attr.amount_in || "0", 18);
      const toAmountWei = parseAmountToWei(attr.to_token_amount || attr.amount_out || "0", 18);

      let ethAmountWei = 0n;
      let tokenAmountWei = 0n;

      if (weth && fromTokenAddress && fromTokenAddress.toLowerCase() === weth.toLowerCase()) {
        ethAmountWei = fromAmountWei;
      } else if (weth && toTokenAddress && toTokenAddress.toLowerCase() === weth.toLowerCase()) {
        ethAmountWei = toAmountWei;
      } else if (side === "buy") {
        ethAmountWei = fromAmountWei;
      } else {
        ethAmountWei = toAmountWei;
      }

      if (token && fromTokenAddress && fromTokenAddress.toLowerCase() === token.toLowerCase()) {
        tokenAmountWei = fromAmountWei;
      } else if (token && toTokenAddress && toTokenAddress.toLowerCase() === token.toLowerCase()) {
        tokenAmountWei = toAmountWei;
      } else if (side === "buy") {
        tokenAmountWei = toAmountWei;
      } else {
        tokenAmountWei = fromAmountWei;
      }

      if (ethAmountWei <= 0n || tokenAmountWei <= 0n) continue;

      const timestamp = parseUnixTimestamp(attr.block_timestamp || attr.timestamp);
      const txHash = String(attr.tx_hash || row?.id || "");
      const account = normalizeAddress(attr.tx_from_address || attr.taker || "");
      const priceWei = (ethAmountWei * 10n ** 18n) / tokenAmountWei;

      mapped.push({
        side,
        account: account || "",
        txHash,
        blockNumber: Number(attr.block_number || 0),
        logIndex: Number(attr.log_index || -1),
        timestamp,
        ethAmountWei: ethAmountWei.toString(),
        tokenAmountWei: tokenAmountWei.toString(),
        priceWei: priceWei.toString(),
        priceEth: toFloat(priceWei, 18, 18),
        source: "gecko"
      });
    }

    mapped.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      return b.blockNumber - a.blockNumber;
    });

    const sliced = mapped.slice(0, TOKEN_TRADES_RESPONSE_LIMIT);
    setCachedValue(geckoTradesCache, cacheKey, sliced, GECKO_TRADES_CACHE_TTL_MS);
    return sliced;
  } catch {
    setCachedValue(geckoTradesCache, cacheKey, [], GECKO_TRADES_CACHE_TTL_MS);
    return [];
  }
}

function toNumberSafe(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function readDexScreenerTokenSnapshot(chainId, tokenAddress, pairHint = "") {
  const token = normalizeAddress(tokenAddress || "");
  if (!token) return null;

  const chainSlug = dexscreenerChainForChain(chainId);
  const key = `${chainSlug}:${token.toLowerCase()}:${String(pairHint || "").toLowerCase()}`;
  const cached = getCachedValue(dexTokenCache, key);
  if (cached !== null) return cached;

  const url = `https://api.dexscreener.com/latest/dex/tokens/${token}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3500)
    });

    if (!response.ok) {
      setCachedValue(dexTokenCache, key, null, DEX_TOKEN_CACHE_TTL_MS);
      return null;
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.pairs) ? payload.pairs : [];
    const targetPair = normalizeAddress(pairHint || "");
    const filtered = rows.filter((row) => String(row?.chainId || "").toLowerCase() === chainSlug.toLowerCase());
    const candidates = filtered.length ? filtered : rows;
    if (!candidates.length) {
      setCachedValue(dexTokenCache, key, null, DEX_TOKEN_CACHE_TTL_MS);
      return null;
    }

    let best = null;
    if (targetPair) {
      best =
        candidates.find(
          (row) => normalizeAddress(row?.pairAddress || "")?.toLowerCase() === String(targetPair).toLowerCase()
        ) || null;
    }

    if (!best) {
      best = [...candidates].sort((a, b) => {
        const liqA = toNumberSafe(a?.liquidity?.usd, 0);
        const liqB = toNumberSafe(b?.liquidity?.usd, 0);
        if (liqA !== liqB) return liqB - liqA;
        const volA = toNumberSafe(a?.volume?.h24, 0);
        const volB = toNumberSafe(b?.volume?.h24, 0);
        return volB - volA;
      })[0];
    }

    const value = {
      chainId: String(best?.chainId || chainSlug),
      dexId: String(best?.dexId || ""),
      pairAddress: normalizeAddress(best?.pairAddress || "") || "",
      pairUrl: String(best?.url || ""),
      baseSymbol: String(best?.baseToken?.symbol || ""),
      quoteSymbol: String(best?.quoteToken?.symbol || ""),
      priceNative: toNumberSafe(best?.priceNative, 0),
      priceUsd: toNumberSafe(best?.priceUsd, 0),
      marketCapUsd: toNumberSafe(best?.marketCap, 0),
      fdvUsd: toNumberSafe(best?.fdv, 0),
      liquidityUsd: toNumberSafe(best?.liquidity?.usd, 0),
      volume24hUsd: toNumberSafe(best?.volume?.h24, 0),
      priceChange24hPct: toNumberSafe(best?.priceChange?.h24, 0),
      pairCreatedAt: Number(best?.pairCreatedAt || 0),
      raw: best
    };

    setCachedValue(dexTokenCache, key, value, DEX_TOKEN_CACHE_TTL_MS);
    return value;
  } catch {
    setCachedValue(dexTokenCache, key, null, DEX_TOKEN_CACHE_TTL_MS);
    return null;
  }
}

function explorerBaseForChain(chainId) {
  if (chainId === 11155111) return "https://sepolia.etherscan.io";
  if (chainId === 1) return "https://etherscan.io";
  return "";
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const results = new Array(list.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, list.length));

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

async function readLaunch(factory, index) {
  const launch = await factory.getLaunch(index);
  return {
    id: index,
    token: launch.token,
    pool: launch.pool,
    creator: launch.creator,
    name: launch.name,
    symbol: launch.symbol,
    imageURI: launch.imageURI,
    description: launch.description,
    totalSupply: launch.totalSupply.toString(),
    creatorAllocation: launch.creatorAllocation.toString(),
    createdAt: Number(launch.createdAt)
  };
}

async function readPoolSnapshot(provider, launch) {
  const snapshotCacheKey = String(launch.pool || "").toLowerCase();
  const cachedSnapshot = getCachedValue(poolSnapshotCache, snapshotCacheKey);
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  const pool = new ethers.Contract(launch.pool, POOL_ARTIFACT.abi, provider);

  const [spotPrice, tokenReserve, ethReserve, feeBps, graduated, graduationTargetEth, targetProgressBps, migratedPair, dexRouter, lpRecipient] =
    await Promise.all([
      pool.spotPrice(),
      pool.tokenReserve(),
      pool.ethReserve(),
      pool.feeBps(),
      pool.graduated(),
      pool.graduationTargetEth(),
      pool.targetProgressBps(),
      pool.migratedPair(),
      pool.dexRouter(),
      pool.lpRecipient()
    ]);

  const totalSupply = BigInt(launch.totalSupply);
  let currentPriceWei = BigInt(spotPrice);
  const tokenReserveWei = BigInt(tokenReserve);
  let priceSource = "bonding";
  let dexWethReserveWei = 0n;
  let dexTokenReserveWei = 0n;
  let dexWethAddress = ethers.ZeroAddress;

  if (Boolean(graduated) && !isZeroAddress(migratedPair) && !isZeroAddress(dexRouter)) {
    try {
      const pair = new ethers.Contract(migratedPair, V2_PAIR_ABI, provider);
      const router = new ethers.Contract(dexRouter, V2_ROUTER_ABI, provider);
      const [token0, token1, reserves, weth] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves(), router.WETH()]);
      dexWethAddress = normalizeAddress(weth) || ethers.ZeroAddress;

      const launchToken = launch.token.toLowerCase();
      const wethLower = String(weth).toLowerCase();
      const token0Lower = String(token0).toLowerCase();
      const token1Lower = String(token1).toLowerCase();

      let tokenRes = 0n;
      let wethRes = 0n;

      if (token0Lower === launchToken && token1Lower === wethLower) {
        tokenRes = BigInt(reserves[0]);
        wethRes = BigInt(reserves[1]);
      } else if (token1Lower === launchToken && token0Lower === wethLower) {
        tokenRes = BigInt(reserves[1]);
        wethRes = BigInt(reserves[0]);
      }

      if (tokenRes > 0n && wethRes > 0n) {
        currentPriceWei = (wethRes * 10n ** 18n) / tokenRes;
        priceSource = "dex";
        dexTokenReserveWei = tokenRes;
        dexWethReserveWei = wethRes;
      }
    } catch {
      // Keep bonding-curve price fallback when pair reads fail.
    }
  }

  const circulating = totalSupply > tokenReserveWei ? totalSupply - tokenReserveWei : 0n;
  const fdvWei = (currentPriceWei * totalSupply) / 10n ** 18n;
  const marketCapWei = (currentPriceWei * circulating) / 10n ** 18n;

  const snapshot = {
    feeBps: Number(feeBps),
    graduated: Boolean(graduated),
    migratedPair,
    dexRouter,
    lpRecipient,
    priceSource,
    spotPriceWei: spotPrice.toString(),
    effectiveSpotPriceWei: currentPriceWei.toString(),
    spotPriceEth: toFloat(currentPriceWei, 18, 18),
    tokenReserve: tokenReserve.toString(),
    ethReserveWei: ethReserve.toString(),
    ethReserveEth: toFloat(ethReserve),
    dexWethReserveWei: dexWethReserveWei.toString(),
    dexWethReserveEth: toFloat(dexWethReserveWei),
    dexWethAddress,
    dexTokenReserve: dexTokenReserveWei.toString(),
    graduationTargetEthWei: graduationTargetEth.toString(),
    graduationTargetEth: toFloat(graduationTargetEth),
    bondingProgressBps: Number(targetProgressBps),
    bondingProgressPct: Number((Number(targetProgressBps) / 100).toFixed(2)),
    circulatingSupply: circulating.toString(),
    fdvWei: fdvWei.toString(),
    fdvEth: toFloat(fdvWei),
    marketCapWei: marketCapWei.toString(),
    marketCapEth: toFloat(marketCapWei)
  };

  setCachedValue(poolSnapshotCache, snapshotCacheKey, snapshot, POOL_SNAPSHOT_CACHE_TTL_MS);
  return snapshot;
}

async function readRecentTrades(provider, poolAddress, limit = 400) {
  const pool = new ethers.Contract(poolAddress, POOL_ARTIFACT.abi, provider);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - LOG_LOOKBACK_BLOCKS);

  let buyEvents = [];
  let sellEvents = [];
  try {
    [buyEvents, sellEvents] = await Promise.all([
      queryFilterAdaptive(pool, pool.filters.Buy(), fromBlock, latestBlock),
      queryFilterAdaptive(pool, pool.filters.Sell(), fromBlock, latestBlock)
    ]);
  } catch {
    return { trades: [], chart: [] };
  }

  const blockTsCache = new Map();
  async function blockTs(blockNumber) {
    if (!blockTsCache.has(blockNumber)) {
      const b = await provider.getBlock(blockNumber);
      blockTsCache.set(blockNumber, b ? Number(b.timestamp) : 0);
    }
    return blockTsCache.get(blockNumber);
  }

  const trades = [];

  for (const ev of buyEvents) {
    const ts = await blockTs(ev.blockNumber);
    const ethIn = ev.args.ethIn;
    const tokensOut = ev.args.tokensOut;
    const priceWei = tokensOut > 0n ? (ethIn * 10n ** 18n) / tokensOut : 0n;
    const buyer = normalizeAddress(ev.args?.buyer || "");

    trades.push({
      side: "buy",
      account: buyer || "",
      txHash: ev.transactionHash,
      blockNumber: ev.blockNumber,
      timestamp: ts,
      ethAmountWei: ethIn.toString(),
      tokenAmountWei: tokensOut.toString(),
      priceWei: priceWei.toString(),
      priceEth: toFloat(priceWei, 18, 18)
    });
  }

  for (const ev of sellEvents) {
    const ts = await blockTs(ev.blockNumber);
    const ethOut = ev.args.ethOut;
    const tokensIn = ev.args.tokensIn;
    const priceWei = tokensIn > 0n ? (ethOut * 10n ** 18n) / tokensIn : 0n;
    const seller = normalizeAddress(ev.args?.seller || "");

    trades.push({
      side: "sell",
      account: seller || "",
      txHash: ev.transactionHash,
      blockNumber: ev.blockNumber,
      timestamp: ts,
      ethAmountWei: ethOut.toString(),
      tokenAmountWei: tokensIn.toString(),
      priceWei: priceWei.toString(),
      priceEth: toFloat(priceWei, 18, 18)
    });
  }

  trades.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.timestamp - b.timestamp;
  });

  const sliced = trades.slice(Math.max(0, trades.length - limit));
  const chart = sliced.map((t) => ({ t: t.timestamp * 1000, p: t.priceEth, side: t.side }));

  return { trades: sliced.reverse(), chart };
}

async function readPairRecentTrades(provider, pairAddress, launchTokenAddress, wethAddress, limit = 300) {
  const pair = normalizeAddress(pairAddress || "");
  const token = normalizeAddress(launchTokenAddress || "");
  const weth = normalizeAddress(wethAddress || "");
  if (!pair || !token || !weth) {
    return { trades: [], chart: [] };
  }

  const cacheKey = `${pair.toLowerCase()}:${token.toLowerCase()}:${weth.toLowerCase()}`;
  const contract = new ethers.Contract(pair, V2_PAIR_ABI, provider);
  const latestBlock = await provider.getBlockNumber();
  const cached = pairTradesCache.get(cacheKey);
  const fromBlock = cached
    ? Math.max(0, Number(cached.lastBlock || 0) + 1)
    : Math.max(0, latestBlock - DEX_LOG_LOOKBACK_BLOCKS);
  if (cached && fromBlock > latestBlock) {
    const hot = cached.trades.slice(0, Math.max(1, limit));
    const hotChart = [...hot]
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .map((t) => ({ t: Number(t.timestamp || 0) * 1000, p: Number(t.priceEth || 0), side: t.side }))
      .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.p) && row.p > 0);
    return { trades: hot, chart: hotChart };
  }

  let token0;
  let token1;
  let events = [];
  try {
    [token0, token1, events] = await Promise.all([
      contract.token0(),
      contract.token1(),
      queryFilterAdaptive(contract, contract.filters.Swap(), fromBlock, latestBlock)
    ]);
  } catch {
    return { trades: [], chart: [] };
  }

  const token0Lower = String(token0).toLowerCase();
  const token1Lower = String(token1).toLowerCase();
  const tokenLower = token.toLowerCase();
  const wethLower = weth.toLowerCase();

  const tokenIs0 = token0Lower === tokenLower;
  const tokenIs1 = token1Lower === tokenLower;
  const wethIs0 = token0Lower === wethLower;
  const wethIs1 = token1Lower === wethLower;

  if (!(tokenIs0 || tokenIs1) || !(wethIs0 || wethIs1)) {
    return { trades: [], chart: [] };
  }

  const blockTsCache = new Map();
  async function blockTs(blockNumber) {
    if (!blockTsCache.has(blockNumber)) {
      const b = await provider.getBlock(blockNumber);
      blockTsCache.set(blockNumber, b ? Number(b.timestamp) : 0);
    }
    return blockTsCache.get(blockNumber);
  }

  const trades = [];
  for (const ev of events) {
    const amount0In = BigInt(ev.args?.amount0In || 0n);
    const amount1In = BigInt(ev.args?.amount1In || 0n);
    const amount0Out = BigInt(ev.args?.amount0Out || 0n);
    const amount1Out = BigInt(ev.args?.amount1Out || 0n);

    const tokenIn = tokenIs0 ? amount0In : amount1In;
    const tokenOut = tokenIs0 ? amount0Out : amount1Out;
    const wethIn = wethIs0 ? amount0In : amount1In;
    const wethOut = wethIs0 ? amount0Out : amount1Out;

    let side = "";
    let ethAmountWei = 0n;
    let tokenAmountWei = 0n;

    if (wethIn > 0n && tokenOut > 0n) {
      side = "buy";
      ethAmountWei = wethIn;
      tokenAmountWei = tokenOut;
    } else if (tokenIn > 0n && wethOut > 0n) {
      side = "sell";
      ethAmountWei = wethOut;
      tokenAmountWei = tokenIn;
    } else {
      continue;
    }

    if (ethAmountWei <= 0n || tokenAmountWei <= 0n) continue;

    const timestamp = await blockTs(ev.blockNumber);
    const account = normalizeAddress(ev.args?.to || ev.args?.sender || "");
    const priceWei = (ethAmountWei * 10n ** 18n) / tokenAmountWei;

    trades.push({
      side,
      account: account || "",
      txHash: ev.transactionHash,
      blockNumber: ev.blockNumber,
      logIndex: Number(ev.logIndex ?? -1),
      timestamp,
      ethAmountWei: ethAmountWei.toString(),
      tokenAmountWei: tokenAmountWei.toString(),
      priceWei: priceWei.toString(),
      priceEth: toFloat(priceWei, 18, 18),
      source: "pair"
    });
  }

  trades.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    return b.blockNumber - a.blockNumber;
  });

  const merged = [];
  const seen = new Set();
  for (const row of [...trades, ...(cached?.trades || [])]) {
    const key = [
      String(row.txHash || ""),
      String(row.side || ""),
      Number(row.timestamp || 0),
      Number(row.blockNumber || 0),
      Number(row.logIndex || -1),
      String(row.ethAmountWei || ""),
      String(row.tokenAmountWei || "")
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  merged.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    return b.blockNumber - a.blockNumber;
  });
  const bounded = merged.slice(0, 600);
  pairTradesCache.set(cacheKey, { lastBlock: latestBlock, trades: bounded });

  const sliced = bounded.slice(0, Math.max(1, Math.min(limit, TOKEN_TRADES_RESPONSE_LIMIT)));
  const chart = [...sliced]
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .map((t) => ({ t: Number(t.timestamp || 0) * 1000, p: Number(t.priceEth || 0), side: t.side }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.p) && row.p > 0);

  return { trades: sliced, chart };
}

function calcPct(value, total, precision = 2) {
  const numerator = BigInt(value || 0);
  const denominator = BigInt(total || 0);
  if (numerator <= 0n || denominator <= 0n) return 0;

  const scale = 10n ** BigInt(precision + 2);
  const scaled = (numerator * scale) / denominator;
  return Number(scaled) / 10 ** precision;
}

async function readTopHolders(provider, launch, limit = 20) {
  const token = new ethers.Contract(launch.token, TOKEN_ARTIFACT.abi, provider);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - LOG_LOOKBACK_BLOCKS);
  const participants = await readPoolParticipants(provider, launch.pool, fromBlock, latestBlock);

  const participantAddresses = participants
    .sort((a, b) => Number(b.interactions || 0) - Number(a.interactions || 0))
    .slice(0, 120)
    .map((row) => row.address);

  const addresses = new Set();
  addresses.add(launch.creator);
  addresses.add(launch.pool);
  for (const addr of participantAddresses) {
    addresses.add(addr);
  }

  const unique = Array.from(addresses)
    .map((addr) => normalizeAddress(addr))
    .filter(Boolean);

  const balances = await mapWithConcurrency(unique, MAX_BALANCE_READ_CONCURRENCY, async (address) => {
    const balance = await token.balanceOf(address);
    return {
      address,
      balance: balance.toString(),
      label:
        address.toLowerCase() === launch.creator.toLowerCase()
          ? "Creator"
          : address.toLowerCase() === launch.pool.toLowerCase()
            ? "Pool"
            : "Holder"
    };
  });

  const totalSupply = BigInt(launch.totalSupply || "0");
  const rows = balances
    .map((row) => ({
      ...row,
      pct: calcPct(row.balance, totalSupply, 2)
    }))
    .filter((row) => BigInt(row.balance || "0") > 0n)
    .sort((a, b) => {
      const left = BigInt(a.balance || "0");
      const right = BigInt(b.balance || "0");
      if (left === right) return 0;
      return left > right ? -1 : 1;
    })
    .slice(0, Math.max(1, limit));

  return rows;
}

async function readTokenFeeSnapshot(provider, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, TOKEN_ARTIFACT.abi, provider);
  try {
    const [creator, platformFeeRecipient, creatorClaimable, platformClaimable] = await Promise.all([
      token.creator(),
      token.platformFeeRecipient(),
      token.creatorClaimable(),
      token.platformClaimable()
    ]);
    let creatorClaimed = 0n;
    if (ENABLE_ONCHAIN_CLAIM_HISTORY) {
      try {
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, Number(latestBlock || 0) - CREATOR_CLAIM_LOOKBACK_BLOCKS);
        const claimLogs = await queryFilterAdaptive(
          token,
          token.filters.CreatorFeesClaimed(creator),
          fromBlock,
          latestBlock,
          Math.min(DEFAULT_LOG_RANGE, 20_000)
        );
        creatorClaimed = claimLogs.reduce((sum, ev) => {
          const amount = BigInt(ev?.args?.amount?.toString?.() || "0");
          return sum + amount;
        }, 0n);
      } catch {
        creatorClaimed = 0n;
      }
    }
    return {
      creator,
      platformFeeRecipient,
      creatorClaimableWei: creatorClaimable.toString(),
      platformClaimableWei: platformClaimable.toString(),
      creatorClaimedWei: creatorClaimed.toString(),
      creatorClaimableTokens: toFloat(creatorClaimable),
      creatorClaimedTokens: toFloat(creatorClaimed),
      platformClaimableTokens: toFloat(platformClaimable)
    };
  } catch {
    return {
      creator: ethers.ZeroAddress,
      platformFeeRecipient: ethers.ZeroAddress,
      creatorClaimableWei: "0",
      platformClaimableWei: "0",
      creatorClaimedWei: "0",
      creatorClaimableTokens: 0,
      creatorClaimedTokens: 0,
      platformClaimableTokens: 0
    };
  }
}

async function readPoolParticipants(provider, poolAddress, fromBlock, toBlock) {
  const bucketSize = 300;
  const fromBucket = Math.floor(Number(fromBlock || 0) / bucketSize);
  const toBucket = Math.floor(Number(toBlock || 0) / bucketSize);
  const participantsKey = `${String(poolAddress || "").toLowerCase()}:${fromBucket}:${toBucket}`;
  const cachedParticipants = getCachedValue(participantsCache, participantsKey);
  if (cachedParticipants) {
    return cachedParticipants;
  }

  const pool = new ethers.Contract(poolAddress, POOL_ARTIFACT.abi, provider);
  const bucket = new Map();

  const bump = (addr, blockNumber) => {
    const key = String(addr || "").toLowerCase();
    if (!key || !ethers.isAddress(key)) return;
    const prev = bucket.get(key) || { address: ethers.getAddress(key), interactions: 0, lastBlock: 0 };
    prev.interactions += 1;
    if (blockNumber > prev.lastBlock) prev.lastBlock = blockNumber;
    bucket.set(key, prev);
  };

  try {
    const [buys, sells] = await Promise.all([
      queryFilterAdaptive(pool, pool.filters.Buy(), fromBlock, toBlock),
      queryFilterAdaptive(pool, pool.filters.Sell(), fromBlock, toBlock)
    ]);

    for (const ev of buys) {
      bump(ev.args?.buyer, ev.blockNumber);
    }
    for (const ev of sells) {
      bump(ev.args?.seller, ev.blockNumber);
    }
  } catch {
    setCachedValue(participantsCache, participantsKey, [], PARTICIPANTS_CACHE_TTL_MS);
    return [];
  }

  const participants = Array.from(bucket.values());
  setCachedValue(participantsCache, participantsKey, participants, PARTICIPANTS_CACHE_TTL_MS);
  return participants;
}

async function readLaunchList(ctx) {
  const count = Number(await ctx.factory.getLaunchCount());
  const launchListKey = `${ctx.chainId}:${ctx.factoryAddress.toLowerCase()}:${count}`;

  return withCache(launchListCache, launchListKey, LAUNCHES_CACHE_TTL_MS, async () => {
    const ids = Array.from({ length: count }, (_row, index) => count - 1 - index);
    return mapWithConcurrency(ids, MAX_LAUNCH_READ_CONCURRENCY, async (id) => readLaunch(ctx.factory, id));
  });
}

async function findLaunchByToken(factory, tokenAddress) {
  const count = Number(await factory.getLaunchCount());
  for (let i = count - 1; i >= 0; i--) {
    const launch = await readLaunch(factory, i);
    if (launch.token.toLowerCase() === tokenAddress.toLowerCase()) {
      return launch;
    }
  }
  return null;
}

app.get("/api/health", async (req, res) => {
  try {
    const deployment = loadDeploymentConfig();
    const requestedChainId = resolveRequestedChainId(req, deployment);
    const ctx = await getContext(requestedChainId);
    res.json({
      ok: true,
      chainId: ctx.chainId,
      factory: ctx.factoryAddress,
      supportedChains: resolveSupportedChains(deployment)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/config", async (req, res) => {
  try {
    const deployment = loadDeploymentConfig();
    const requestedChainId = resolveRequestedChainId(req, deployment);
    const chainId = requestedChainId;
    const factoryAddress = resolveFactoryAddress(chainId, deployment);
    const rpcUrls = pickRpcUrls(chainId);
    const supportedChains = resolveSupportedChains(deployment);

    res.json({
      chainId,
      requestedChainId: parseChainId(req?.query?.chainId || req?.headers?.["x-chain-id"]),
      factoryAddress,
      supportedChains,
      deployment,
      rpcUrl: rpcUrls[0] || "",
      rpcUrls,
      explorerBaseUrl: explorerBaseForChain(chainId)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/launches", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(60, Number(req.query.limit || 20)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const deployment = loadDeploymentConfig();
    const requestedChainId = resolveRequestedChainId(req, deployment);
    const ctx = await getContext(requestedChainId);
    const launchesKey = `${ctx.chainId}:${ctx.factoryAddress.toLowerCase()}:${limit}:${offset}`;
    const payload = await withCache(launchesCache, launchesKey, LAUNCHES_CACHE_TTL_MS, async () => {
      const launchList = await readLaunchList(ctx);
      const total = launchList.length;
      const sliced = launchList.slice(offset, offset + limit);
      const launches = await mapWithConcurrency(sliced, MAX_LAUNCH_READ_CONCURRENCY, async (launch) => {
        const pool = await readPoolSnapshot(ctx.provider, launch);
        return {
          ...launch,
          tokenAddress: launch.token,
          poolAddress: launch.pool,
          creatorProfile: await getPersistedProfile(launch.creator),
          pool
        };
      });
      return { total, launches };
    });

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/upload-image", async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Invalid image payload" });
    }

    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid image encoding" });
    }

    const extRaw = match[1].toLowerCase();
    const ext = extRaw === "jpeg" ? "jpg" : extRaw === "svg+xml" ? "svg" : extRaw;
    const allowed = new Set(["png", "jpg", "webp", "gif", "svg"]);
    if (!allowed.has(ext)) {
      return res.status(400).json({ error: "Unsupported image format" });
    }

    const binary = Buffer.from(match[2], "base64");
    if (binary.length === 0 || binary.length > 1024 * 1024) {
      return res.status(400).json({ error: "Image must be between 1 byte and 1 MB" });
    }

    if (!USE_DISK_UPLOADS) {
      return res.json({ url: dataUrl });
    }

    const filename = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}.${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, binary);

    res.json({ url: `/uploads/${filename}` });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to upload image" });
  }
});

app.get("/api/user-profile/:address", async (req, res) => {
  try {
    const profile = await getPersistedProfile(req.params.address);
    if (!profile.address) {
      return res.status(400).json({ error: "Invalid address" });
    }
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load profile" });
  }
});

app.post("/api/user-profile/:address", async (req, res) => {
  try {
    const profile = await setPersistedProfile(req.params.address, req.body || {});
    clearProfileDependentCaches();
    res.json(profile);
  } catch (error) {
    const text = String(error?.message || "");
    const status = text.toLowerCase().includes("invalid address") ? 400 : 500;
    res.status(status).json({ error: text || "Failed to save profile" });
  }
});

app.post("/api/user-profiles", async (req, res) => {
  try {
    const addressesRaw = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    const limited = addressesRaw.slice(0, 200);
    const profiles = await getPersistedProfiles(limited);
    res.json({ profiles });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load profiles" });
  }
});

app.get("/api/follow/state", async (req, res) => {
  try {
    const viewer = normalizeAddress(req.query.viewer);
    const target = normalizeAddress(req.query.target);
    if (!viewer || !target) {
      return res.status(400).json({ error: "viewer and target are required" });
    }
    const payload = await getFollowState(viewer, target);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load follow state" });
  }
});

app.post("/api/follow", async (req, res) => {
  try {
    const viewer = normalizeAddress(req.body?.viewer);
    const target = normalizeAddress(req.body?.target);
    const follow = Boolean(req.body?.follow);
    if (!viewer || !target) {
      return res.status(400).json({ error: "viewer and target are required" });
    }
    const payload = await setFollowState(viewer, target, follow);
    res.json(payload);
  } catch (error) {
    const message = String(error?.message || "Failed to update follow state");
    const status = message.toLowerCase().includes("follow yourself") ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const deployment = loadDeploymentConfig();
    const requestedChainId = resolveRequestedChainId(req, deployment);
    const ctx = await getContext(requestedChainId);
    const statsKey = `${ctx.chainId}:${ctx.factoryAddress.toLowerCase()}`;
    const payload = await withCache(statsCache, statsKey, STATS_CACHE_TTL_MS, async () => {
      const launchList = await readLaunchList(ctx);
      const count = launchList.length;
      let graduatedCount = 0;
      let totalBondingEthWei = 0n;
      let aggregateFdvWei = 0n;

      const sampleLaunches = launchList.slice(0, Math.min(count, 80));
      const pools = await mapWithConcurrency(sampleLaunches, MAX_LAUNCH_READ_CONCURRENCY, (launch) =>
        readPoolSnapshot(ctx.provider, launch)
      );

      for (const pool of pools) {
        if (pool.graduated) graduatedCount++;
        totalBondingEthWei += BigInt(pool.ethReserveWei);
        aggregateFdvWei += BigInt(pool.fdvWei);
      }

      return {
        totalLaunches: count,
        sampledLaunches: sampleLaunches.length,
        graduatedCount,
        totalBondingEthWei: totalBondingEthWei.toString(),
        totalBondingEth: toFloat(totalBondingEthWei),
        aggregateFdvWei: aggregateFdvWei.toString(),
        aggregateFdvEth: toFloat(aggregateFdvWei)
      };
    });

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/token/:token", async (req, res) => {
  try {
    const tokenAddress = normalizeAddress(req.params.token);
    if (!tokenAddress) {
      return res.status(400).json({ error: "Invalid token address" });
    }

    const deployment = loadDeploymentConfig();
    const requestedChainId = resolveRequestedChainId(req, deployment);
    const ctx = await getContext(requestedChainId);
    const lite = String(req.query.lite || "0") === "1";
    const tokenKey = `${ctx.chainId}:${ctx.factoryAddress.toLowerCase()}:${tokenAddress.toLowerCase()}:${lite ? "lite" : "full"}`;
    const forceFresh = String(req.query.fresh || "0") === "1";
    const builder = async () => {
      const launchList = await readLaunchList(ctx);
      const launch = launchList.find((row) => String(row.token || "").toLowerCase() === tokenAddress.toLowerCase()) || null;
      if (!launch) {
        return null;
      }

      const poolBase = await readPoolSnapshot(ctx.provider, launch);
      const feeSnapshot = await readTokenFeeSnapshot(ctx.provider, launch.token);
      const dex = await readDexScreenerTokenSnapshot(ctx.chainId, launch.token, poolBase.migratedPair);
      const pairFallback = normalizeAddress(dex?.pairAddress || "");
      const effectivePair = normalizeAddress(poolBase.migratedPair) || pairFallback || ethers.ZeroAddress;
      const pool =
        effectivePair !== ethers.ZeroAddress && String(poolBase.migratedPair || "").toLowerCase() !== effectivePair.toLowerCase()
          ? { ...poolBase, migratedPair: effectivePair, graduated: true, priceSource: "dex" }
          : poolBase;

      // Keep token page indexer-first, but allow on-chain pair trades to improve
      // freshness and avoid missing multiple recent swaps.
      const useOnchainPoolTrades = String(process.env.USE_ONCHAIN_POOL_TRADES || "0") === "1";
      const useOnchainPairTrades = String(process.env.USE_ONCHAIN_PAIR_TRADES || "1") !== "0";
      const useOnchainTopHolders = String(process.env.USE_ONCHAIN_TOP_HOLDERS || "0") === "1";

      const [topHoldersRes, geckoRes, geckoTradesRes] = await Promise.allSettled([
        useOnchainTopHolders && !lite ? readTopHolders(ctx.provider, launch, 25) : Promise.resolve(null),
        readGeckoPoolStatus(ctx.chainId, effectivePair),
        readGeckoPoolTrades(ctx.chainId, effectivePair, launch.token, pool.dexWethAddress)
      ]);

      const topHolders = topHoldersRes.status === "fulfilled" ? topHoldersRes.value : null;
      const gecko = geckoRes.status === "fulfilled" ? geckoRes.value : null;
      const geckoTrades = geckoTradesRes.status === "fulfilled" ? geckoTradesRes.value : [];

      let localTradesPayload = { trades: [], chart: [] };
      let pairTradesPayload = { trades: [], chart: [] };
      const shouldReadPoolTrades = useOnchainPoolTrades && !pool.graduated && (!Array.isArray(geckoTrades) || !geckoTrades.length);
      const shouldReadPairTrades = useOnchainPairTrades && (!Array.isArray(geckoTrades) || geckoTrades.length < 3);

      if (shouldReadPoolTrades || shouldReadPairTrades) {
        const [localTradesRes, pairTradesRes] = await Promise.allSettled([
          shouldReadPoolTrades ? readRecentTrades(ctx.provider, launch.pool, TOKEN_TRADES_RESPONSE_LIMIT) : Promise.resolve({ trades: [], chart: [] }),
          shouldReadPairTrades
            ? readPairRecentTrades(ctx.provider, effectivePair, launch.token, pool.dexWethAddress, TOKEN_TRADES_RESPONSE_LIMIT)
            : Promise.resolve({ trades: [], chart: [] })
        ]);
        localTradesPayload = localTradesRes.status === "fulfilled" ? localTradesRes.value : { trades: [], chart: [] };
        pairTradesPayload = pairTradesRes.status === "fulfilled" ? pairTradesRes.value : { trades: [], chart: [] };
      }

      let trades = [...(localTradesPayload.trades || []), ...(pairTradesPayload.trades || [])];
      let chart = localTradesPayload.chart?.length ? localTradesPayload.chart : pairTradesPayload.chart || [];

      if (Array.isArray(geckoTrades) && geckoTrades.length) {
        const seen = new Set();
        const merged = [];
        for (const row of [...geckoTrades, ...trades]) {
          const key = [
            String(row.txHash || ""),
            String(row.side || ""),
            Number(row.timestamp || 0),
            Number(row.blockNumber || 0),
            Number(row.logIndex || -1),
            String(row.ethAmountWei || ""),
            String(row.tokenAmountWei || "")
          ].join(":");
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(row);
        }
        merged.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        trades = merged.slice(0, TOKEN_TRADES_RESPONSE_LIMIT);

        if (!Array.isArray(chart) || !chart.length) {
          chart = [...trades]
            .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
            .map((row) => ({
              t: Number(row.timestamp || 0) * 1000,
              p: Number(row.priceEth || 0),
              side: row.side
            }))
            .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.p) && row.p > 0);
        }
      }

      if ((Number(pool?.spotPriceEth || 0) <= 0 || Number(pool?.marketCapEth || 0) <= 0) && Number(dex?.priceNative || 0) > 0) {
        const dexPriceWei = parseAmountToWei(String(dex.priceNative || "0"), 18);
        if (dexPriceWei > 0n) {
          const circulating = BigInt(pool.circulatingSupply || "0");
          const totalSupply = BigInt(launch.totalSupply || "0");
          const marketCapWei = circulating > 0n ? (dexPriceWei * circulating) / 10n ** 18n : 0n;
          const fdvWei = totalSupply > 0n ? (dexPriceWei * totalSupply) / 10n ** 18n : 0n;
          pool.effectiveSpotPriceWei = dexPriceWei.toString();
          pool.spotPriceEth = toFloat(dexPriceWei, 18, 18);
          pool.priceSource = "dex";
          if (marketCapWei > 0n) {
            pool.marketCapWei = marketCapWei.toString();
            pool.marketCapEth = toFloat(marketCapWei);
          }
          if (fdvWei > 0n) {
            pool.fdvWei = fdvWei.toString();
            pool.fdvEth = toFloat(fdvWei);
          }
          if (effectivePair !== ethers.ZeroAddress) {
            pool.graduated = true;
          }
        }
      }

      if ((!Array.isArray(chart) || !chart.length) && (dex?.priceNative || pool?.spotPriceEth)) {
        const seedPrice = Number(dex?.priceNative || pool?.spotPriceEth || 0);
        if (Number.isFinite(seedPrice) && seedPrice > 0) {
          const now = Date.now();
          chart = Array.from({ length: 20 }, (_row, idx) => ({
            t: now - (19 - idx) * 60_000,
            p: seedPrice,
            side: "seed"
          }));
        }
      }

      return {
        launch: {
          ...launch,
          tokenAddress: launch.token,
          poolAddress: launch.pool,
          creatorProfile: await getPersistedProfile(launch.creator),
          pool,
          feeSnapshot
        },
        trades,
        chart: Array.isArray(chart) ? chart.slice(-TOKEN_CHART_RESPONSE_LIMIT) : [],
        topHolders: Array.isArray(topHolders) ? topHolders : null,
        gecko,
        dex
      };
    };
    const payload = forceFresh ? await builder() : await withCache(tokenCache, tokenKey, TOKEN_CACHE_TTL_MS, builder);

    if (!payload) {
      return res.status(404).json({ error: "Token launch not found" });
    }

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/profile/:address", async (req, res) => {
  try {
    const address = normalizeAddress(req.params.address);
    if (!address) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const deployment = loadDeploymentConfig();
    const requestedChainId = resolveRequestedChainId(req, deployment);
    const ctx = await getContext(requestedChainId);
    const cacheKey = `${ctx.chainId}:${ctx.factoryAddress.toLowerCase()}:${address.toLowerCase()}:social-v2`;
    const cachedProfile = getCachedValue(profileCache, cacheKey);
    if (cachedProfile) {
      return res.json(cachedProfile);
    }

    const launchList = await readLaunchList(ctx);

    const created = [];
    const holdings = [];
    const poolCache = new Map();
    const tokenFeeCache = new Map();

    async function getPoolForLaunch(launch) {
      const key = launch.pool.toLowerCase();
      if (!poolCache.has(key)) {
        poolCache.set(key, await readPoolSnapshot(ctx.provider, launch));
      }
      return poolCache.get(key);
    }

    async function getTokenFeeForLaunch(launch) {
      const key = launch.token.toLowerCase();
      if (!tokenFeeCache.has(key)) {
        tokenFeeCache.set(key, await readTokenFeeSnapshot(ctx.provider, launch.token));
      }
      return tokenFeeCache.get(key);
    }

    const balances = await mapWithConcurrency(launchList, MAX_BALANCE_READ_CONCURRENCY, async (launch) => {
      const token = new ethers.Contract(launch.token, TOKEN_ARTIFACT.abi, ctx.provider);
      const balance = await token.balanceOf(address);
      return balance.toString();
    });

    for (let i = 0; i < launchList.length; i++) {
      const launch = launchList[i];
      const balance = BigInt(balances[i] || "0");
      const isCreator = launch.creator.toLowerCase() === address.toLowerCase();

      if (isCreator) {
        const pool = await getPoolForLaunch(launch);
        const feeSnapshot = await getTokenFeeForLaunch(launch);
        created.push({
          ...launch,
          tokenAddress: launch.token,
          poolAddress: launch.pool,
          creatorProfile: await getPersistedProfile(launch.creator),
          pool,
          feeSnapshot,
          holderBalance: balance.toString(),
          holderBalanceFloat: toFloat(balance)
        });
      }

      if (balance > 0n) {
        const pool = await getPoolForLaunch(launch);
        holdings.push({
          ...launch,
          tokenAddress: launch.token,
          poolAddress: launch.pool,
          creatorProfile: await getPersistedProfile(launch.creator),
          pool,
          holderBalance: balance.toString(),
          holderBalanceFloat: toFloat(balance)
        });
      }
    }
    const social = await getPersistedSocialGraph(address);
    const followers = Array.isArray(social.followers) ? social.followers : [];
    const following = Array.isArray(social.following) ? social.following : [];
    const creatorRewardsTotalWei = created.reduce(
      (sum, row) => sum + BigInt(row?.feeSnapshot?.creatorClaimableWei || "0"),
      0n
    );
    const creatorRewardsClaimedTotalWei = created.reduce(
      (sum, row) => sum + BigInt(row?.feeSnapshot?.creatorClaimedWei || "0"),
      0n
    );
    const creatorRewardsCombinedTotalWei = creatorRewardsTotalWei + creatorRewardsClaimedTotalWei;

    const payload = {
      address,
      profile: await getPersistedProfile(address),
      created,
      holdings,
      creatorRewardsTotalWei: creatorRewardsTotalWei.toString(),
      creatorRewardsTotalTokens: toFloat(creatorRewardsTotalWei),
      creatorRewardsClaimedTotalWei: creatorRewardsClaimedTotalWei.toString(),
      creatorRewardsClaimedTotalTokens: toFloat(creatorRewardsClaimedTotalWei),
      creatorRewardsCombinedTotalWei: creatorRewardsCombinedTotalWei.toString(),
      creatorRewardsCombinedTotalTokens: toFloat(creatorRewardsCombinedTotalWei),
      followers,
      following,
      followersCount: followers.length,
      followingCount: following.length,
      socialIncluded: true
    };
    setCachedValue(profileCache, cacheKey, payload, PROFILE_SOCIAL_CACHE_TTL_MS);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(["/", "/home"], (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.get("/create", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "create.html"));
});

app.get("/token", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "token.html"));
});

app.get("/profile", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "profile.html"));
});

app.use(express.static(FRONTEND_DIR));

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || "Unexpected server error" });
});

if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`[web] Launchpad running on http://localhost:${PORT}`);
  });
}
