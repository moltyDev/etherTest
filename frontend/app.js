import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm";

const FACTORY_ABI = [
  "function createLaunch(string name,string symbol,string imageURI,string description,uint256 totalSupply,uint256 creatorAllocationBps) returns (uint256 launchId,address tokenAddress,address poolAddress)",
  "function getLaunchCount() view returns (uint256)",
  "function getLaunch(uint256 launchId) view returns ((address token,address pool,address creator,string name,string symbol,string imageURI,string description,uint256 totalSupply,uint256 creatorAllocation,uint256 createdAt))",
  "function defaultFeeBps() view returns (uint256)",
  "function defaultGraduationTargetEth() view returns (uint256)"
];

const POOL_ABI = [
  "function buy(uint256 minTokensOut) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokenAmountIn,uint256 minEthOut) returns (uint256 ethOut)",
  "function triggerGraduation()",
  "function quoteBuy(uint256 ethAmountIn) view returns (uint256 tokensOut,uint256 feePaid)",
  "function quoteSell(uint256 tokenAmountIn) view returns (uint256 ethOut,uint256 feePaid)",
  "function spotPrice() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
  "function ethReserve() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function graduationTargetEth() view returns (uint256)",
  "function targetProgressBps() view returns (uint256)",
  "function migratedPair() view returns (address)"
];

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const els = {
  walletChoice: document.getElementById("walletChoice"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  walletAddress: document.getElementById("walletAddress"),
  factoryAddress: document.getElementById("factoryAddress"),
  loadLaunchesBtn: document.getElementById("loadLaunchesBtn"),
  createBtn: document.getElementById("createBtn"),
  feedback: document.getElementById("feedback"),
  launchList: document.getElementById("launchList"),
  stats: document.getElementById("stats"),
  name: document.getElementById("name"),
  symbol: document.getElementById("symbol"),
  supply: document.getElementById("supply"),
  creatorAllocation: document.getElementById("creatorAllocation"),
  image: document.getElementById("image"),
  imageFile: document.getElementById("imageFile"),
  imagePreview: document.getElementById("imagePreview"),
  description: document.getElementById("description")
};

let provider;
let signer;
let connectedAddress = "";
let connectedWalletLabel = "";
let activeInjectedProvider = null;
let discoveredWallets = [];
let deploymentConfig = null;
const MAX_LOCAL_IMAGE_BYTES = 35 * 1024;

function setFeedback(message, isError = false) {
  els.feedback.textContent = message;
  els.feedback.classList.toggle("error", isError);
}

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getWalletMeta(injected) {
  if (!injected) {
    return { key: "unknown", label: "Unknown Wallet", provider: injected };
  }

  if (injected.isRabby) {
    return { key: "rabby", label: "Rabby", provider: injected };
  }

  if (injected.isMetaMask) {
    return { key: "metamask", label: "MetaMask", provider: injected };
  }

  if (injected.isCoinbaseWallet) {
    return { key: "coinbase", label: "Coinbase Wallet", provider: injected };
  }

  return { key: "injected", label: "Injected Wallet", provider: injected };
}

function discoverInjectedWallets() {
  const seen = new Set();
  const list = [];

  const root = window.ethereum;
  if (!root) {
    return [];
  }

  const providers = Array.isArray(root.providers) && root.providers.length > 0 ? root.providers : [root];
  for (const injected of providers) {
    if (!injected || seen.has(injected)) {
      continue;
    }
    seen.add(injected);
    list.push(getWalletMeta(injected));
  }

  return list;
}

function refreshWalletChoiceOptions() {
  discoveredWallets = discoverInjectedWallets();
  if (!els.walletChoice) return;

  const prev = els.walletChoice.value || "auto";
  const options = [{ value: "auto", label: "Auto (Detected)" }];

  let hasMetamask = false;
  let hasRabby = false;

  for (const wallet of discoveredWallets) {
    if (wallet.key === "metamask" && !hasMetamask) {
      options.push({ value: "metamask", label: "MetaMask" });
      hasMetamask = true;
      continue;
    }
    if (wallet.key === "rabby" && !hasRabby) {
      options.push({ value: "rabby", label: "Rabby" });
      hasRabby = true;
      continue;
    }
  }

  els.walletChoice.innerHTML = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join("");

  const availableValues = new Set(options.map((opt) => opt.value));
  if (availableValues.has(prev)) {
    els.walletChoice.value = prev;
  } else if (availableValues.has("metamask")) {
    els.walletChoice.value = "metamask";
  } else {
    els.walletChoice.value = "auto";
  }
}

function resolveInjectedProvider() {
  refreshWalletChoiceOptions();
  const choice = els.walletChoice?.value || "auto";

  if (discoveredWallets.length === 0) {
    return null;
  }

  if (choice === "auto") {
    return discoveredWallets[0] || null;
  }

  const exact = discoveredWallets.find((wallet) => wallet.key === choice);
  return exact || null;
}

function updateWalletUi() {
  const connected = Boolean(signer);
  els.walletAddress.textContent = connected
    ? `${connectedWalletLabel}: ${shortAddress(connectedAddress)}`
    : "Not connected";
  if (els.disconnectBtn) {
    els.disconnectBtn.style.display = connected ? "inline-block" : "none";
  }
}

function formatUnitsSafe(value, unit = 18, maxFrac = 4) {
  const n = Number(ethers.formatUnits(value, unit));
  if (!Number.isFinite(n)) {
    return "0";
  }
  return n.toLocaleString(undefined, {
    maximumFractionDigits: maxFrac
  });
}

function formatEth(value, maxFrac = 6) {
  return formatUnitsSafe(value, 18, maxFrac);
}

function sanitizeTxRequest(raw) {
  const clean = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value !== undefined && value !== null) {
      clean[key] = value;
    }
  }
  return clean;
}

async function getPendingNonce() {
  if (!signer || !provider) {
    throw new Error("Wallet not connected");
  }

  const user = await signer.getAddress();

  if (activeInjectedProvider?.request) {
    try {
      const nonceHex = await activeInjectedProvider.request({
        method: "eth_getTransactionCount",
        params: [user, "pending"]
      });

      if (typeof nonceHex === "string" && nonceHex.startsWith("0x")) {
        return Number(BigInt(nonceHex));
      }
    } catch {
      // Fall through to provider method.
    }
  }

  const nonce = await provider.getTransactionCount(user, "pending");
  if (typeof nonce === "bigint") {
    return Number(nonce);
  }
  if (Number.isFinite(nonce)) {
    return nonce;
  }

  throw new Error("Unable to get account nonce");
}

async function sendPopulatedTransaction(populatePromise) {
  if (!signer || !provider) {
    throw new Error("Wallet not connected");
  }

  const txRaw = await populatePromise;
  const tx = sanitizeTxRequest(txRaw);

  tx.nonce = await getPendingNonce();

  try {
    const network = await provider.getNetwork();
    tx.chainId = Number(network.chainId);
  } catch {
    delete tx.chainId;
  }

  try {
    if (tx.gasLimit === undefined) {
      const estimated = await signer.estimateGas(tx);
      tx.gasLimit = (estimated * 120n) / 100n;
    }
  } catch {
    // Let wallet estimate gas if local estimate fails.
  }

  const finalTx = sanitizeTxRequest(tx);
  return signer.sendTransaction(finalTx);
}

function setImagePreview(src) {
  if (!els.imagePreview) return;
  if (!src) {
    els.imagePreview.removeAttribute("src");
    els.imagePreview.style.display = "none";
    return;
  }
  els.imagePreview.src = src;
  els.imagePreview.style.display = "block";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

async function onImageFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  if (!file.type.startsWith("image/")) {
    setFeedback("Please select a valid image file.", true);
    event.target.value = "";
    return;
  }

  if (file.size > MAX_LOCAL_IMAGE_BYTES) {
    setFeedback("Image is too large. Keep local uploads under 35 KB for affordable on-chain metadata.", true);
    event.target.value = "";
    return;
  }

  const dataUrl = await readFileAsDataUrl(file);
  els.image.value = dataUrl;
  setImagePreview(dataUrl);
  setFeedback("Local image attached. It will be saved as a data URL.");
}

function getFactoryContract(readOnly = false) {
  const address = els.factoryAddress.value.trim();
  if (!ethers.isAddress(address)) {
    throw new Error("Set a valid factory address");
  }

  if (readOnly || !signer) {
    if (!provider) {
      throw new Error("Connect wallet first");
    }
    return new ethers.Contract(address, FACTORY_ABI, provider);
  }

  return new ethers.Contract(address, FACTORY_ABI, signer);
}

async function ensureWallet() {
  const wallet = resolveInjectedProvider();
  if (!wallet?.provider) {
    throw new Error("No injected wallet found. Install MetaMask or Rabby.");
  }

  if (!provider || activeInjectedProvider !== wallet.provider) {
    provider = new ethers.BrowserProvider(wallet.provider);
    activeInjectedProvider = wallet.provider;
    signer = null;
    connectedAddress = "";
    connectedWalletLabel = wallet.label;
  }

  if (!signer) {
    // For MetaMask, ask permissions first so user can re-pick account(s) on reconnect.
    if (wallet.key === "metamask" && wallet.provider.request) {
      try {
        await wallet.provider.request({
          method: "wallet_requestPermissions",
          params: [{ eth_accounts: {} }]
        });
      } catch {
        // Fallback to direct account request if permissions dialog is canceled/unsupported.
      }
    }

    const accounts = await provider.send("eth_requestAccounts", []);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("No account selected in wallet");
    }

    connectedAddress = accounts[0];
    signer = await provider.getSigner(connectedAddress);
    connectedWalletLabel = wallet.label;
    updateWalletUi();
  }

  return signer;
}

function disconnectWallet() {
  signer = null;
  provider = null;
  activeInjectedProvider = null;
  connectedAddress = "";
  connectedWalletLabel = "";
  updateWalletUi();
  setFeedback("Wallet disconnected. You can connect again anytime.");
}

async function loadDeploymentConfig() {
  try {
    const response = await fetch("./deployment.json", { cache: "no-store" });
    if (!response.ok) return;

    const cfg = await response.json();
    deploymentConfig = cfg;
    if (cfg?.memeLaunchFactory && ethers.isAddress(cfg.memeLaunchFactory)) {
      els.factoryAddress.value = cfg.memeLaunchFactory;
      setFeedback(`Loaded deployment for chain ${cfg.chainId}.`);
    }
  } catch {
    // Deployment file is optional in local-only setup.
  }
}

async function connectWallet() {
  try {
    await ensureWallet();
    updateWalletUi();
    const network = await provider.getNetwork();
    const walletChain = Number(network.chainId);

    if (
      deploymentConfig?.chainId !== undefined &&
      Number(deploymentConfig.chainId) !== walletChain
    ) {
      setFeedback(
        `Connected to chain ${walletChain}, but loaded factory is for chain ${deploymentConfig.chainId}. Paste a factory deployed on chain ${walletChain}.`,
        true
      );
    } else {
      setFeedback("Wallet connected.");
    }
    await refreshLaunches();
  } catch (err) {
    setFeedback(parseError(err), true);
  }
}

function parseError(err) {
  const msg =
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.reason ||
    err?.message ||
    "Unknown error";

  const clean = msg.replace("execution reverted: ", "");

  if (clean.toLowerCase().includes("could not decode result data")) {
    return "Factory address does not match the connected network. Switch network or paste the correct factory address.";
  }

  if (clean.toLowerCase().includes("missing revert data")) {
    return "Wallet failed to estimate/send this transaction. Check gas funds and try again; the app will retry with wallet-native mode when possible.";
  }

  return clean;
}

function shouldUseWalletNativeFallback(err) {
  const wallet = (connectedWalletLabel || "").toLowerCase();
  if (!wallet.includes("metamask")) {
    return false;
  }

  const text = parseError(err).toLowerCase();
  return (
    text.includes("missing revert data") ||
    text.includes("internal json-rpc error") ||
    text.includes("could not coalesce error")
  );
}

async function sendWithFallback({ actionLabel, populatedTx, walletNativeSend }) {
  try {
    return await sendPopulatedTransaction(populatedTx);
  } catch (err) {
    if (!shouldUseWalletNativeFallback(err)) {
      throw err;
    }

    setFeedback(`${actionLabel}: retrying with wallet-native send...`);
    return walletNativeSend();
  }
}

async function validateFactoryOnCurrentChain(address) {
  if (!provider) {
    throw new Error("Connect wallet first");
  }

  const [network, code] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(address)
  ]);

  if (code === "0x") {
    const walletChain = Number(network.chainId);
    const configHint =
      deploymentConfig?.chainId !== undefined
        ? ` Loaded config chain is ${deploymentConfig.chainId}.`
        : "";
    throw new Error(
      `No factory contract found at this address on chain ${walletChain}.${configHint} Deploy on this chain and paste the new factory address.`
    );
  }
}

async function createLaunch() {
  try {
    await ensureWallet();

    const name = els.name.value.trim();
    const symbol = els.symbol.value.trim().toUpperCase();
    const supplyInput = els.supply.value.trim();
    const creatorPct = Number(els.creatorAllocation.value || "0");

    if (!name || !symbol) {
      throw new Error("Name and symbol are required");
    }

    if (!Number.isFinite(creatorPct) || creatorPct < 0 || creatorPct > 20) {
      throw new Error("Creator allocation must be between 0 and 20%");
    }

    const totalSupply = ethers.parseUnits(supplyInput, 18);
    const creatorBps = BigInt(Math.round(creatorPct * 100));
    const imageUri = els.image.value.trim();

    if (imageUri.startsWith("data:image/") && imageUri.length > 60_000) {
      throw new Error("Local image payload is too large for low-cost testnet launch. Use a smaller image.");
    }

    const factory = getFactoryContract();
    await factory.createLaunch.staticCall(
      name,
      symbol,
      imageUri,
      els.description.value.trim(),
      totalSupply,
      creatorBps
    );

    setFeedback("Submitting launch transaction...");
    const tx = await sendWithFallback({
      actionLabel: "Create launch",
      populatedTx: factory.createLaunch.populateTransaction(
        name,
        symbol,
        imageUri,
        els.description.value.trim(),
        totalSupply,
        creatorBps
      ),
      walletNativeSend: () =>
        factory.createLaunch(
          name,
          symbol,
          imageUri,
          els.description.value.trim(),
          totalSupply,
          creatorBps
        )
    });

    await tx.wait();

    setFeedback("Launch created successfully.");
    await refreshLaunches();
  } catch (err) {
    setFeedback(parseError(err), true);
  }
}

async function buyToken(poolAddress, buyInputEl) {
  try {
    await ensureWallet();

    const amountRaw = buyInputEl.value.trim();
    if (!amountRaw) throw new Error("Enter ETH amount");

    const ethAmountIn = ethers.parseEther(amountRaw);
    if (ethAmountIn <= 0n) throw new Error("ETH amount must be > 0");

    const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);

    const [quotedOut] = await pool.quoteBuy(ethAmountIn);
    if (quotedOut === 0n) {
      throw new Error("Trade too small for current price/liquidity");
    }

    const minTokensOut = (quotedOut * 99n) / 100n;

    setFeedback(`Buying token from ${shortAddress(poolAddress)}...`);
    const tx = await sendWithFallback({
      actionLabel: "Buy",
      populatedTx: pool.buy.populateTransaction(minTokensOut, { value: ethAmountIn }),
      walletNativeSend: () => pool.buy(minTokensOut, { value: ethAmountIn })
    });
    await tx.wait();

    setFeedback("Buy complete.");
    await refreshLaunches();
  } catch (err) {
    setFeedback(parseError(err), true);
  }
}

async function sellToken(poolAddress, tokenAddress, sellInputEl) {
  try {
    await ensureWallet();

    const amountRaw = sellInputEl.value.trim();
    if (!amountRaw) throw new Error("Enter token amount");

    const tokenAmountIn = ethers.parseUnits(amountRaw, 18);
    if (tokenAmountIn <= 0n) throw new Error("Token amount must be > 0");

    const userAddress = await signer.getAddress();
    const token = new ethers.Contract(tokenAddress, TOKEN_ABI, signer);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);

    const allowance = await token.allowance(userAddress, poolAddress);
    if (allowance < tokenAmountIn) {
      setFeedback("Approving token spend...");
      const approvalTx = await sendWithFallback({
        actionLabel: "Approve",
        populatedTx: token.approve.populateTransaction(poolAddress, ethers.MaxUint256),
        walletNativeSend: () => token.approve(poolAddress, ethers.MaxUint256)
      });
      await approvalTx.wait();
    }

    const [quotedEthOut] = await pool.quoteSell(tokenAmountIn);
    if (quotedEthOut === 0n) {
      throw new Error("Trade too small or pool has no ETH liquidity yet");
    }

    const minEthOut = (quotedEthOut * 99n) / 100n;

    setFeedback(`Selling into pool ${shortAddress(poolAddress)}...`);
    const tx = await sendWithFallback({
      actionLabel: "Sell",
      populatedTx: pool.sell.populateTransaction(tokenAmountIn, minEthOut),
      walletNativeSend: () => pool.sell(tokenAmountIn, minEthOut)
    });
    await tx.wait();

    setFeedback("Sell complete.");
    await refreshLaunches();
  } catch (err) {
    setFeedback(parseError(err), true);
  }
}

async function renderLaunchCard(launch, launchId) {
  const reader = signer || provider;
  const pool = new ethers.Contract(launch.pool, POOL_ABI, reader);

  const [price, tokenReserve, ethReserve, feeBps, graduated, graduationTargetEth, targetProgressBps, migratedPair] = await Promise.all([
    pool.spotPrice(),
    pool.tokenReserve(),
    pool.ethReserve(),
    pool.feeBps(),
    pool.graduated(),
    pool.graduationTargetEth(),
    pool.targetProgressBps(),
    pool.migratedPair()
  ]);

  let userBalance = 0n;
  if (signer) {
    const token = new ethers.Contract(launch.token, TOKEN_ABI, signer);
    userBalance = await token.balanceOf(await signer.getAddress());
  }

  const card = document.createElement("article");
  card.className = "card launch";

  const createdDate = new Date(Number(launch.createdAt) * 1000).toLocaleString();
  let imagePart = "";
  if (launch.imageURI) {
    const isDataUrl = launch.imageURI.startsWith("data:image/");
    if (isDataUrl) {
      imagePart = `<img src="${launch.imageURI}" alt="${launch.symbol} image" class="launch-image" />`;
    } else {
      imagePart = `
        <img src="${launch.imageURI}" alt="${launch.symbol} image" class="launch-image" />
        <p><a href="${launch.imageURI}" target="_blank" rel="noopener noreferrer" class="muted">image link</a></p>
      `;
    }
  }
  const graduationStatus = graduated
    ? `<span>Status: Graduated to DEX</span>`
    : `<span>Bonding Progress: ${(Number(targetProgressBps) / 100).toFixed(2)}%</span>`;
  const pairLine =
    graduated && migratedPair !== ethers.ZeroAddress
      ? `<span>DEX Pair: ${shortAddress(migratedPair)}</span>`
      : `<span>Target ETH: ${formatEth(graduationTargetEth, 4)}</span>`;
  const tradeDisabled = graduated ? "disabled" : "";
  const tradeHint = graduated
    ? `<p class="muted">Bonding curve complete. Trade on DEX pair now.</p>`
    : "";

  card.innerHTML = `
    <div class="launch-head">
      <div class="launch-title">
        <h3>${launch.name}</h3>
        <p><span class="pill">${launch.symbol}</span></p>
      </div>
      <span class="muted">#${launchId}</span>
    </div>

    <p class="muted">${launch.description || "No description provided."}</p>
    ${imagePart}

    <div class="meta">
      <span>Creator: ${shortAddress(launch.creator)}</span>
      <span>Fee: ${(Number(feeBps) / 100).toFixed(2)}%</span>
      <span>Price: ${formatEth(price, 8)} ETH</span>
      <span>Pool ETH: ${formatEth(ethReserve, 5)}</span>
      <span>Pool Tokens: ${formatUnitsSafe(tokenReserve, 18, 2)}</span>
      <span>Your Balance: ${formatUnitsSafe(userBalance, 18, 2)}</span>
      ${graduationStatus}
      ${pairLine}
      <span>Created: ${createdDate}</span>
    </div>
    ${tradeHint}

    <div class="grid two">
      <div class="trade">
        <input class="buy-amount" placeholder="ETH amount" />
        <button class="primary buy-btn" ${tradeDisabled}>Buy</button>
      </div>
      <div class="trade">
        <input class="sell-amount" placeholder="Token amount" />
        <button class="secondary sell-btn" ${tradeDisabled}>Sell</button>
      </div>
    </div>

    <p class="muted">Pool: ${shortAddress(launch.pool)} | Token: ${shortAddress(launch.token)}</p>
  `;

  const buyBtn = card.querySelector(".buy-btn");
  const sellBtn = card.querySelector(".sell-btn");
  const buyInput = card.querySelector(".buy-amount");
  const sellInput = card.querySelector(".sell-amount");

  if (!graduated) {
    buyBtn.addEventListener("click", () => buyToken(launch.pool, buyInput));
    sellBtn.addEventListener("click", () => sellToken(launch.pool, launch.token, sellInput));
  }

  return card;
}

async function refreshLaunches() {
  try {
    const factoryAddress = els.factoryAddress.value.trim();
    if (!ethers.isAddress(factoryAddress)) {
      throw new Error("Set a valid factory address");
    }

    await validateFactoryOnCurrentChain(factoryAddress);

    const factory = getFactoryContract(true);
    const count = Number(await factory.getLaunchCount());
    els.stats.textContent = `${count} launches`;
    els.launchList.innerHTML = "";

    if (count === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No launches yet. Create the first one.";
      els.launchList.appendChild(empty);
      return;
    }

    const limit = Math.min(count, 40);
    for (let id = count - 1; id >= count - limit; id--) {
      const launch = await factory.getLaunch(id);
      const card = await renderLaunchCard(launch, id);
      els.launchList.appendChild(card);
    }
  } catch (err) {
    setFeedback(parseError(err), true);
  }
}

function attachListeners() {
  refreshWalletChoiceOptions();
  els.connectBtn.addEventListener("click", connectWallet);
  els.disconnectBtn?.addEventListener("click", disconnectWallet);
  els.walletChoice?.addEventListener("change", () => {
    disconnectWallet();
    const selected = els.walletChoice.value;
    const label =
      selected === "metamask"
        ? "MetaMask"
        : selected === "rabby"
          ? "Rabby"
          : "Auto wallet";
    setFeedback(`${label} selected. Click Connect Wallet.`);
  });
  els.createBtn.addEventListener("click", createLaunch);
  els.loadLaunchesBtn.addEventListener("click", refreshLaunches);
  els.imageFile?.addEventListener("change", (event) => {
    onImageFileSelected(event).catch((err) => setFeedback(parseError(err), true));
  });
  els.image?.addEventListener("input", () => {
    const src = els.image.value.trim();
    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:image/")) {
      setImagePreview(src);
    } else if (!src) {
      setImagePreview("");
    }
  });

  window.addEventListener("ethereum#initialized", refreshWalletChoiceOptions, { once: true });
}

async function main() {
  attachListeners();
  await loadDeploymentConfig();
  setImagePreview("");
  updateWalletUi();
  refreshWalletChoiceOptions();

  if (els.factoryAddress.value.trim()) {
    await refreshLaunches();
  }
}

main();
