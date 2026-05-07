(() => {
  const STORAGE_KEY = "etherpump.sidebar.compact.v1";
  const WALLET_SESSION_KEY = "etherpump.wallet.session.v1";
  const CHAIN_PREFERENCE_KEY = "etherpump.chain.preferred.v1";
  const ETH_USD_CACHE_KEY = "etherpump.ethusd.v1";
  const ETH_USD_CACHE_TTL_MS = 5 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 30_000;
  const CLAIM_MIN_USD = 8;
  const sidebar = document.getElementById("appSidebar") || document.querySelector(".sidebar");
  const toggle = document.getElementById("sidebarToggle") || sidebar?.querySelector(".sidebar-toggle");
  if (!sidebar || !toggle) return;

  const createBtn = sidebar.querySelector(".side-create-btn");
  const rewardsCard = document.createElement("a");
  rewardsCard.className = "side-rewards-card";
  rewardsCard.id = "sideCreatorRewards";
  rewardsCard.href = "/profile";
  rewardsCard.style.display = "none";
  rewardsCard.innerHTML = `
    <span class="side-rewards-head">
      <span>Creator rewards</span>
      <span class="side-rewards-new">New</span>
    </span>
    <strong class="side-rewards-value">$0.00</strong>
  `;
  if (createBtn) {
    createBtn.insertAdjacentElement("afterend", rewardsCard);
  }

  let compact = false;
  let refreshTimer = null;
  let refreshBusy = false;

  try {
    compact = localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    compact = false;
  }

  const apply = () => {
    sidebar.classList.toggle("compact", compact);
    toggle.setAttribute("aria-expanded", compact ? "false" : "true");
    toggle.setAttribute("aria-label", compact ? "Expand sidebar" : "Collapse sidebar");
  };

  toggle.addEventListener("click", () => {
    compact = !compact;
    try {
      localStorage.setItem(STORAGE_KEY, compact ? "1" : "0");
    } catch {
      // ignore storage failures
    }
    apply();
  });

  apply();

  function normalizeAddress(value) {
    const text = String(value || "").trim();
    return /^0x[a-fA-F0-9]{40}$/.test(text) ? text : "";
  }

function toBigIntOrZero(value) {
    try {
      return BigInt(String(value ?? "0"));
    } catch {
      return 0n;
}

function profileHrefForAddress(value) {
  const raw = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(raw) ? `/profile?address=${raw}` : "/profile";
}
  }

  function poolUnitPriceWei(pool) {
    const graduated = Boolean(pool?.graduated) || String(pool?.priceSource || "").toLowerCase() === "dex";
    const effective = toBigIntOrZero(pool?.effectiveSpotPriceWei);
    if (effective > 0n) return effective;

    const marketCapWei = toBigIntOrZero(pool?.marketCapWei);
    const circulating = toBigIntOrZero(pool?.circulatingSupply);
    if (marketCapWei > 0n && circulating > 0n) {
      return (marketCapWei * 10n ** 18n) / circulating;
    }

    if (graduated) return 0n;
    return toBigIntOrZero(pool?.spotPriceWei);
  }

  function readWalletSession() {
    try {
      const raw = localStorage.getItem(WALLET_SESSION_KEY);
      const parsed = JSON.parse(raw || "{}");
      return {
        connected: Boolean(parsed?.connected),
        choice: String(parsed?.choice || ""),
        address: normalizeAddress(parsed?.address || "")
      };
    } catch {
      return { connected: false, choice: "", address: "" };
    }
  }

  function readPreferredChainId() {
    try {
      const raw = Number(localStorage.getItem(CHAIN_PREFERENCE_KEY) || 0);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    } catch {
      return 0;
    }
  }

  function formatUsd(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return "$0.00";
    if (n < 0.01) return "<$0.01";
    if (n < 1000) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(n);
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 2
    }).format(n);
  }

  function readCachedEthUsd() {
    try {
      const raw = localStorage.getItem(ETH_USD_CACHE_KEY);
      const parsed = JSON.parse(raw || "{}");
      const price = Number(parsed?.price || 0);
      const ts = Number(parsed?.ts || 0);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) return null;
      if (Date.now() - ts > ETH_USD_CACHE_TTL_MS) return null;
      return price;
    } catch {
      return null;
    }
  }

  async function fetchEthUsd() {
    const cached = readCachedEthUsd();
    if (cached) return cached;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2200);
      const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
        cache: "no-store",
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) return 0;
      const payload = await res.json();
      const price = Number(payload?.data?.amount || 0);
      return Number.isFinite(price) && price > 0 ? price : 0;
    } catch {
      return 0;
    }
  }

  async function getConnectedAddress() {
    const session = readWalletSession();
    if (!session.connected) return "";
    const root = window.ethereum;
    if (!root) return session.address || "";

    const providers = Array.isArray(root.providers) && root.providers.length ? root.providers : [root];
    for (const provider of providers) {
      const selected = normalizeAddress(provider?.selectedAddress || "");
      if (selected) return selected;
    }

    for (const provider of providers) {
      if (!provider?.request) continue;
      try {
        const accounts = await provider.request({ method: "eth_accounts" });
        if (Array.isArray(accounts) && accounts.length) {
          const found = normalizeAddress(accounts[0]);
          if (found) return found;
        }
      } catch {
        // ignore
      }
    }
    return session.address || "";
  }

  async function refreshCreatorRewardsCard() {
    if (!rewardsCard || refreshBusy) return;
    refreshBusy = true;
    try {
      const address = await getConnectedAddress();
      if (!address) {
        rewardsCard.style.display = "none";
        return;
      }

      const chainId = readPreferredChainId();
      const query = chainId > 0 ? `?chainId=${chainId}` : "";
      const response = await fetch(`/api/profile/${address}${query}`, { cache: "no-store" });
      if (!response.ok) {
        rewardsCard.style.display = "none";
        return;
      }

      const payload = await response.json();
      const created = Array.isArray(payload?.created) ? payload.created : [];
      let claimableValueWei = 0n;
      for (const row of created) {
        const claimWei = toBigIntOrZero(row?.feeSnapshot?.creatorClaimableWei);
        const priceWei = poolUnitPriceWei(row?.pool);
        if (claimWei <= 0n || priceWei <= 0n) continue;
        claimableValueWei += (claimWei * priceWei) / 10n ** 18n;
      }

      if (claimableValueWei <= 0n) {
        rewardsCard.style.display = "none";
        return;
      }

      const ethUsd = await fetchEthUsd();
      const claimableEth = Number(claimableValueWei) / 1e18;
      const claimableUsd = claimableEth * (ethUsd > 0 ? ethUsd : 0);
      if (!Number.isFinite(claimableUsd) || claimableUsd < CLAIM_MIN_USD) {
        rewardsCard.style.display = "none";
        return;
      }
      rewardsCard.href = profileHrefForAddress(address);
      const valueNode = rewardsCard.querySelector(".side-rewards-value");
      if (valueNode) {
        valueNode.textContent = formatUsd(claimableUsd);
      }
      rewardsCard.style.display = "";
    } catch {
      rewardsCard.style.display = "none";
    } finally {
      refreshBusy = false;
    }
  }

  function scheduleRefresh(delay = 0) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshCreatorRewardsCard().catch(() => {
        // ignore sidebar reward refresh errors
      });
    }, Math.max(0, delay));
  }

  window.addEventListener("focus", () => scheduleRefresh(80));
  window.addEventListener("storage", () => scheduleRefresh(80));
  document.getElementById("connectBtn")?.addEventListener("click", () => scheduleRefresh(900));
  document.getElementById("disconnectBtn")?.addEventListener("click", () => scheduleRefresh(200));
  scheduleRefresh(60);
  setInterval(() => scheduleRefresh(0), REFRESH_INTERVAL_MS);
})();
