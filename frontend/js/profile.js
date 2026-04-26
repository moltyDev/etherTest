import { api } from "./api.js";
import {
  defaultUsername,
  disconnectWallet,
  fetchEthUsdPrice,
  ethers,
  formatCompactUsd,
  formatToken,
  hydrateUserProfile,
  hydrateUserProfiles,
  loadUserProfile,
  makeTokenContract,
  parseUiError,
  resolveCoinImage,
  saveUserProfile,
  sendTxWithFallback,
  setPreferredChainId,
  shortAddress,
  weiToUsd,
  walletState
} from "./core.js";
import { initWalletControls, initWalletHubMenu, setAlert, setWalletLabel, showCopyToast } from "./ui.js";
import { initCoinSearchOverlay } from "./searchModal.js?v=20260424d";

const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
const CLAIM_MIN_USD = 8;

const ui = {
  walletSelect: document.getElementById("walletChoice"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  walletLabel: document.getElementById("walletAddress"),
  alert: document.getElementById("alert"),
  signInBtn: document.getElementById("signInBtn"),
  netChip: document.getElementById("networkChip"),
  factoryChip: document.getElementById("factoryChip"),
  profileNav: document.getElementById("profileNav"),
  profileNavSide: document.getElementById("profileNavSide"),
  profileMenuBtn: document.getElementById("profileMenuBtn"),
  profileMenu: document.getElementById("profileMenu"),
  profileMenuName: document.getElementById("profileMenuName"),
  profileMenuNameLarge: document.getElementById("profileMenuNameLarge"),
  profileMenuMeta: document.getElementById("profileMenuMeta"),
  profileShareBtn: document.getElementById("profileShareBtn"),
  profileAvatar: document.getElementById("profileAvatar"),
  profileAvatarLarge: document.getElementById("profileAvatarLarge"),
  walletHubBtn: document.getElementById("walletHubBtn"),
  walletHubMenu: document.getElementById("walletHubMenu"),
  walletHubBalance: document.getElementById("walletHubBalance"),
  walletHubBalanceLarge: document.getElementById("walletHubBalanceLarge"),
  walletHubNative: document.getElementById("walletHubNative"),
  walletHubAddressBtn: document.getElementById("walletHubAddressBtn"),
  walletHubDepositBtn: document.getElementById("walletHubDepositBtn"),
  walletHubTradeLink: document.getElementById("walletHubTradeLink"),
  walletHubBuyLink: document.getElementById("walletHubBuyLink"),
  walletHubHistoryLink: document.getElementById("walletHubHistoryLink"),
  depositModal: document.getElementById("depositModal"),
  depositCloseBtn: document.getElementById("depositCloseBtn"),
  depositCopyBtn: document.getElementById("depositCopyBtn"),
  depositAddressText: document.getElementById("depositAddressText"),
  depositQrImage: document.getElementById("depositQrImage"),
  editProfileBtn: document.getElementById("editProfileBtn"),
  menuLogoutBtn: document.getElementById("menuLogoutBtn"),
  profileAddressInput: document.getElementById("profileAddressInput"),
  profileLoadBtn: document.getElementById("profileLoadBtn"),
  profileResolvedName: document.getElementById("profileResolvedName"),
  profileResolvedAddress: document.getElementById("profileResolvedAddress"),
  profileCopyAddressBtn: document.getElementById("profileCopyAddressBtn"),
  profileEtherscanLink: document.getElementById("profileEtherscanLink"),
  profileHeroAvatar: document.getElementById("profileHeroAvatar"),
  profileFollowBtn: document.getElementById("profileFollowBtn"),
  statFollowers: document.getElementById("statFollowers"),
  statFollowing: document.getElementById("statFollowing"),
  statCreated: document.getElementById("statCreated"),
  statValue: document.getElementById("statValue"),
  createdCountInline: document.getElementById("createdCountInline"),
  createdMiniList: document.getElementById("createdMiniList"),
  profileTabsWrap: document.getElementById("profileTabs"),
  profileTabButtons: Array.from(document.querySelectorAll("[data-tab]")),
  profileTabContent: document.getElementById("profileTabContent"),
  editProfileModal: document.getElementById("editProfileModal"),
  closeEditProfileModal: document.getElementById("closeEditProfileModal"),
  saveEditProfileBtn: document.getElementById("saveEditProfileBtn"),
  editUsername: document.getElementById("editUsername"),
  editBio: document.getElementById("editBio"),
  editAvatarPreview: document.getElementById("editAvatarPreview"),
  editAvatarFile: document.getElementById("editAvatarFile"),
  editAvatarPickBtn: document.getElementById("editAvatarPickBtn"),
  editAvatarRemoveBtn: document.getElementById("editAvatarRemoveBtn")
};

const state = {
  address: "",
  payload: null,
  pendingProfileImageUri: "",
  activeTab: "balances",
  ethUsd: 3000,
  chainId: 1,
  socialLoaded: false,
  socialLoading: false,
  isFollowingProfile: false,
  followBusy: false
};
let walletHub = null;
let walletControls = null;

const COPY_PILL_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="10" height="10" rx="2"></rect>
    <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path>
  </svg>
`;

function creatorHandle(address) {
  if (!address) return "anon";
  const profile = loadUserProfile(address);
  return profile.username || defaultUsername(address);
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function humanAgo(timestampSec) {
  const ts = Number(timestampSec || 0) * 1000;
  if (!ts) return "-";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function normalizeAddress(input) {
  try {
    return ethers.getAddress((input || "").trim());
  } catch {
    return "";
  }
}

function connectedAddress() {
  return normalizeAddress(walletState().address || "");
}

function viewingOwnProfile() {
  const viewer = connectedAddress();
  if (!viewer) return false;
  const candidates = [
    state.address,
    state.payload?.address,
    state.payload?.profile?.address,
    getAddressFromUrl()
  ]
    .map((value) => normalizeAddress(value || ""))
    .filter(Boolean);

  if (!candidates.length) return false;
  return candidates.some((address) => address.toLowerCase() === viewer.toLowerCase());
}

async function copyText(value) {
  await navigator.clipboard.writeText(String(value || ""));
}

function getAddressFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("address") || "";
}

function updateQuery(address) {
  const url = new URL(window.location.href);
  if (address) {
    url.searchParams.set("address", address);
  } else {
    url.searchParams.delete("address");
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function setAvatar(node, text, imageUri = "") {
  if (!node) return;
  if (imageUri) {
    node.textContent = "";
    node.classList.add("with-image");
    node.style.backgroundImage = `url("${imageUri}")`;
    return;
  }

  node.classList.remove("with-image");
  node.style.backgroundImage = "";
  node.textContent = text;
}

function setProfileMenuOpen(open) {
  if (!ui.profileMenu || !ui.profileMenuBtn) return;
  ui.profileMenu.classList.toggle("open", open);
  ui.profileMenuBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function hideEditProfileModal() {
  if (!ui.editProfileModal) return;
  ui.editProfileModal.classList.remove("open");
  ui.editProfileModal.setAttribute("aria-hidden", "true");
}

function updateEditAvatarPreview(text = "EP", imageUri = "") {
  setAvatar(ui.editAvatarPreview, text, imageUri);
}

function displayNameForAddress(address) {
  if (!address) return "unknown";
  const profile = loadUserProfile(address);
  return profile.username || creatorHandle(address);
}

function updateProfileIdentity() {
  const ws = walletState();
  const connected = Boolean(ws.signer && ws.address);
  const profile = connected ? loadUserProfile(ws.address) : { username: "Guest", imageUri: "", bio: "" };
  const username = connected ? profile.username || defaultUsername(ws.address) : "Guest";
  const avatarText = connected ? username.slice(0, 2).toUpperCase() : "EP";
  const imageUri = connected ? profile.imageUri || "" : "";
  const profileHref = connected ? `/profile?address=${ws.address}` : "/profile";

  if (ui.profileMenuName) ui.profileMenuName.textContent = username;
  if (ui.profileMenuNameLarge) ui.profileMenuNameLarge.textContent = username;
  if (ui.profileMenuMeta) ui.profileMenuMeta.textContent = connected ? "0 followers" : "Not connected";
  if (ui.signInBtn) ui.signInBtn.style.display = connected ? "none" : "inline-flex";
  if (ui.walletHubBtn) ui.walletHubBtn.style.display = connected ? "inline-flex" : "none";
  if (ui.profileMenuBtn) ui.profileMenuBtn.style.display = connected ? "inline-flex" : "none";
  if (!connected) {
    walletHub?.setOpen(false);
    setProfileMenuOpen(false);
  }
  if (ui.profileNav) ui.profileNav.href = profileHref;
  if (ui.profileNavSide) ui.profileNavSide.href = profileHref;
  setAvatar(ui.profileAvatar, avatarText, imageUri);
  setAvatar(ui.profileAvatarLarge, avatarText, imageUri);
  syncFollowButton();

  if (ui.editProfileBtn) {
    ui.editProfileBtn.disabled = !connected;
    ui.editProfileBtn.style.opacity = connected ? "1" : "0.6";
    ui.editProfileBtn.style.cursor = connected ? "pointer" : "not-allowed";
  }

  if (ui.menuLogoutBtn) {
    ui.menuLogoutBtn.textContent = connected ? "Log out" : "Connect wallet";
  }

  if (connected) {
    const currentAddress = String(ws.address || "");
    hydrateUserProfile(currentAddress).then(() => {
      const next = walletState();
      if (String(next.address || "").toLowerCase() !== currentAddress.toLowerCase()) return;
      const fresh = loadUserProfile(currentAddress);
      if (fresh.username !== username || String(fresh.imageUri || "") !== String(imageUri || "")) {
        updateProfileIdentity();
        if (state.address && normalizeAddress(state.address) === normalizeAddress(currentAddress)) {
          renderProfileHeader(currentAddress);
        }
      }
    }).catch(() => {
      // ignore profile hydration failures
    });
  }

  if (state.address) {
    refreshFollowState().catch(() => {
      // ignore follow-state refresh failures
    });
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.readAsDataURL(file);
  });
}

function toBigIntOrZero(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function effectivePriceWeiFromPool(pool) {
  const graduated = Boolean(pool?.graduated) || String(pool?.priceSource || "").toLowerCase() === "dex";
  const effective = toBigIntOrZero(pool?.effectiveSpotPriceWei);
  if (effective > 0n) return effective;

  const marketCapWei = toBigIntOrZero(pool?.marketCapWei);
  const circulating = toBigIntOrZero(pool?.circulatingSupply);
  if (marketCapWei > 0n && circulating > 0n) {
    return (marketCapWei * 10n ** 18n) / circulating;
  }

  if (graduated) {
    // Avoid legacy bonding-curve fallback after DEX migration.
    return 0n;
  }

  const spot = toBigIntOrZero(pool?.spotPriceWei);
  return spot > 0n ? spot : 0n;
}

function computePortfolioValueWei(holdings) {
  return (holdings || []).reduce((sum, item) => {
    const bal = BigInt(item.holderBalance || "0");
    const price = effectivePriceWeiFromPool(item.pool);
    return sum + (bal * price) / 10n ** 18n;
  }, 0n);
}

function formatMcapUsd(weiLike) {
  return formatCompactUsd(weiToUsd(weiLike || "0", state.ethUsd));
}

function renderProfileHeader(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    ui.profileResolvedName.textContent = "Guest";
    if (ui.profileResolvedAddress) {
      ui.profileResolvedAddress.textContent = "";
      ui.profileResolvedAddress.hidden = true;
    }
    if (ui.profileCopyAddressBtn) {
      ui.profileCopyAddressBtn.hidden = true;
      ui.profileCopyAddressBtn.dataset.copyAddress = "";
    }
    if (ui.profileEtherscanLink) {
      ui.profileEtherscanLink.hidden = true;
      ui.profileEtherscanLink.href = "#";
    }
    setAvatar(ui.profileHeroAvatar, "EP", "");
    syncFollowButton();
    return;
  }

  const profile = loadUserProfile(normalized);
  const username = profile.username || defaultUsername(normalized);
  ui.profileResolvedName.textContent = username;
  if (ui.profileResolvedAddress) {
    ui.profileResolvedAddress.textContent = "";
    ui.profileResolvedAddress.hidden = true;
  }
  if (ui.profileCopyAddressBtn) {
    ui.profileCopyAddressBtn.hidden = false;
    ui.profileCopyAddressBtn.dataset.copyAddress = normalized;
    ui.profileCopyAddressBtn.innerHTML = `${COPY_PILL_ICON}<span>${shortAddress(normalized)}</span>`;
  }
  if (ui.profileEtherscanLink) {
    const href = getAddressExplorerUrl(normalized, state.chainId);
    if (href) {
      ui.profileEtherscanLink.href = href;
      ui.profileEtherscanLink.hidden = false;
    } else {
      ui.profileEtherscanLink.hidden = true;
      ui.profileEtherscanLink.href = "#";
    }
  }
  setAvatar(ui.profileHeroAvatar, username.slice(0, 2).toUpperCase(), profile.imageUri || "");
  syncFollowButton();
}

function syncFollowButton() {
  if (!ui.profileFollowBtn) return;
  const ws = walletState();
  const viewer = normalizeAddress(ws?.address || connectedAddress() || "");
  const target = normalizeAddress(
    ui.profileCopyAddressBtn?.dataset?.copyAddress ||
      state.payload?.profile?.address ||
      state.payload?.address ||
      state.address ||
      getAddressFromUrl()
  );
  const own = Boolean(viewer && target && viewer.toLowerCase() === target.toLowerCase()) || viewingOwnProfile();

  if (!target) {
    ui.profileFollowBtn.hidden = true;
    ui.profileFollowBtn.style.display = "none";
    ui.profileFollowBtn.disabled = false;
    ui.profileFollowBtn.textContent = "Follow";
    ui.profileFollowBtn.dataset.mode = "";
    return;
  }

  if (viewer && own) {
    ui.profileFollowBtn.hidden = false;
    ui.profileFollowBtn.style.display = "inline-flex";
    ui.profileFollowBtn.disabled = false;
    ui.profileFollowBtn.textContent = "Edit profile";
    ui.profileFollowBtn.dataset.mode = "edit";
    return;
  }

  if (!viewer) {
    ui.profileFollowBtn.hidden = true;
    ui.profileFollowBtn.style.display = "none";
    ui.profileFollowBtn.disabled = false;
    ui.profileFollowBtn.textContent = "Follow";
    ui.profileFollowBtn.dataset.mode = "";
    return;
  }

  ui.profileFollowBtn.hidden = false;
  ui.profileFollowBtn.style.display = "inline-flex";
  ui.profileFollowBtn.dataset.mode = "follow";
  ui.profileFollowBtn.disabled = state.followBusy;
  ui.profileFollowBtn.textContent = state.followBusy
    ? "Saving..."
    : state.isFollowingProfile
      ? "Unfollow"
      : "Follow";
}

async function refreshFollowState() {
  if (!ui.profileFollowBtn) return;
  const viewer = connectedAddress();
  const target = normalizeAddress(state.address || "");
  if (!viewer || !target || viewer.toLowerCase() === target.toLowerCase()) {
    state.isFollowingProfile = false;
    syncFollowButton();
    return;
  }

  try {
    const payload = await api.followState(viewer, target);
    state.isFollowingProfile = Boolean(payload?.isFollowing);
    if (state.payload) {
      state.payload.followersCount = Number(payload?.followersCount || state.payload.followersCount || 0);
      state.payload.followingCount = Number(payload?.followingCount || state.payload.followingCount || 0);
      state.payload.socialIncluded = true;
      setSummary(state.payload);
      if (state.activeTab === "followers") {
        await loadSocialIfNeeded();
      }
    }
  } catch {
    // no-op
  } finally {
    syncFollowButton();
  }
}

function setupAddressCopy() {
  ui.profileCopyAddressBtn?.addEventListener("click", async () => {
    const address = String(ui.profileCopyAddressBtn?.dataset.copyAddress || "");
    if (!address) return;
    try {
      await copyText(address);
      showCopyToast("Address copied to clipboard");
    } catch {
      setAlert(ui.alert, "Could not copy wallet address", true);
    }
  });
}

function getAddressExplorerUrl(address, chainId) {
  const id = Number(chainId || 0);
  if (!address) return "";
  if (id === 1) return `https://etherscan.io/address/${address}`;
  if (id === 11155111) return `https://sepolia.etherscan.io/address/${address}`;
  return "";
}

function renderCreatedMiniList(created = []) {
  if (!ui.createdMiniList) return;
  if (!created.length) {
    ui.createdMiniList.innerHTML = `<p class="muted">No created coins yet.</p>`;
    return;
  }

  ui.createdMiniList.innerHTML = created
    .slice(0, 6)
    .map((item) => {
      const image = resolveCoinImage(item);
      return `
        <a class="profile-mini-item" href="/token?token=${item.token}">
          <img src="${image}" alt="${item.symbol}" />
          <div>
            <strong>${item.name}</strong>
            <span>$${item.symbol}</span>
          </div>
          <div class="profile-mini-metric">
            <b>${formatMcapUsd(item.pool?.marketCapWei || "0")}</b>
            <span>${humanAgo(item.createdAt)}</span>
          </div>
        </a>
      `;
    })
    .join("");
}

function renderBalancesTab(holdings = []) {
  if (!holdings.length) {
    return `<p class="muted">No balances found for this profile.</p>`;
  }

  const rows = holdings
    .sort((a, b) => Number(b.pool?.marketCapEth || 0) - Number(a.pool?.marketCapEth || 0))
    .map((item) => {
      const balance = BigInt(item.holderBalance || "0");
      const price = effectivePriceWeiFromPool(item.pool);
      const valueWei = (balance * price) / 10n ** 18n;
      const image = resolveCoinImage(item);
      return `
        <a class="profile-balance-row" href="/token?token=${item.token}">
          <div class="profile-balance-left">
            <img src="${image}" alt="${item.symbol}" />
            <div>
              <strong>${item.name}</strong>
              <span>${formatToken(item.holderBalance || "0", 18, 2)} ${item.symbol}</span>
            </div>
          </div>
          <div class="profile-balance-right">
            <b>${formatCompactUsd(weiToUsd(valueWei, state.ethUsd))}</b>
            <span>MC ${formatMcapUsd(item.pool?.marketCapWei || "0")}</span>
          </div>
        </a>
      `;
    })
    .join("");

  return `<div class="profile-balance-list">${rows}</div>`;
}

function renderCoinsTab(created = []) {
  if (!created.length) {
    return `<p class="muted">This profile has not created coins yet.</p>`;
  }

  return `
    <div class="coin-grid">
      ${created
        .map((item) => {
          const image = resolveCoinImage(item);
          return `
            <article class="coin-card">
              <a href="/token?token=${item.token}" class="coin-image-wrap">
                <img class="coin-image" src="${image}" alt="${item.symbol}" />
                <span class="coin-badge">Uniswap</span>
              </a>
              <div class="coin-body">
                <div class="coin-head">
                  <h3><a href="/token?token=${item.token}">${item.name}</a></h3>
                  <span>$${item.symbol}</span>
                </div>
                <div class="coin-stats">
                  <span>MC ${formatMcapUsd(item.pool?.marketCapWei || "0")}</span>
                  <span>Created ${humanAgo(item.createdAt)}</span>
                </div>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderFollowersTab(payload) {
  if (!state.socialLoaded) {
    return `<p class="muted">${state.socialLoading ? "Loading followers..." : "Open this tab to load followers and following."}</p>`;
  }

  const followers = payload?.followers || [];
  const following = payload?.following || [];

  const renderFollowRow = (row, fallbackDetail) => {
    const detail = Array.isArray(row.details) && row.details.length ? row.details[0] : fallbackDetail;
    const interactions = Math.max(1, Number(row.interactions || 1));
    const address = normalizeAddress(row.address || "");
    const displayName = displayNameForAddress(address);
    const profile = loadUserProfile(address);
    const imageUri = String(profile.imageUri || "");
    const initials = String(displayName || "EP")
      .replace(/\s+/g, "")
      .slice(0, 2)
      .toUpperCase() || "EP";
    const avatarMarkup = imageUri
      ? `<span class="profile-follow-avatar with-image"><img src="${escapeHtml(imageUri)}" alt="${escapeHtml(displayName)}" loading="lazy" /></span>`
      : `<span class="profile-follow-avatar">${escapeHtml(initials)}</span>`;

    return `
      <a class="profile-follow-row" href="/profile?address=${address}">
        <div class="profile-follow-left">
          ${avatarMarkup}
          <div>
            <strong>${escapeHtml(displayName)}</strong>
            <span>${escapeHtml(shortAddress(address))}</span>
          </div>
        </div>
        <div class="profile-follow-meta">
          <b>${interactions}x</b>
          <span>${escapeHtml(detail)}</span>
        </div>
      </a>
    `;
  };

  const followerHtml = followers.length
    ? followers
        .map((row) => renderFollowRow(row, "Follower"))
        .join("")
    : `<p class="muted">No followers detected yet.</p>`;

  const followingHtml = following.length
    ? following
        .map((row) => renderFollowRow(row, "Following"))
        .join("")
    : `<p class="muted">Not following anyone yet.</p>`;

  return `
    <div class="profile-follow-grid">
      <section>
        <h3>Followers</h3>
        ${followerHtml}
      </section>
      <section>
        <h3>Following</h3>
        ${followingHtml}
      </section>
    </div>
  `;
}

function renderCreatorRewardsTab(payload) {
  const created = payload?.created || [];
  if (!created.length) {
    return `<p class="muted">No created coins yet, so no creator rewards.</p>`;
  }

  const ws = walletState();
  const viewer = normalizeAddress(ws.address || "");
  let availableValueWeiTotal = 0n;
  let claimedValueWeiTotal = 0n;

  const rows = created
    .map((item) => {
      const claimWei = BigInt(item?.feeSnapshot?.creatorClaimableWei || "0");
      const claimedWei = BigInt(item?.feeSnapshot?.creatorClaimedWei || "0");
      const claimStr = formatToken(claimWei, 18, 4);
      const claimedStr = formatToken(claimedWei, 18, 4);
      const priceWei = effectivePriceWeiFromPool(item?.pool);
      const claimValueWei = priceWei > 0n ? (claimWei * priceWei) / 10n ** 18n : 0n;
      const claimedValueWei = priceWei > 0n ? (claimedWei * priceWei) / 10n ** 18n : 0n;
      availableValueWeiTotal += claimValueWei;
      claimedValueWeiTotal += claimedValueWei;

      const claimValueUsd = weiToUsd(claimValueWei, state.ethUsd);
      const claimUsd = formatCompactUsd(claimValueUsd);
      const claimedUsd = formatCompactUsd(weiToUsd(claimedValueWei, state.ethUsd));
      const creator = normalizeAddress(item?.creator || "");
      const claimReady = claimWei > 0n && claimValueUsd >= CLAIM_MIN_USD;
      const canClaim = claimReady && viewer && creator && viewer === creator;
      return `
        <article class="profile-reward-row">
          <div class="profile-reward-main">
            <strong>${item.name} (${item.symbol})</strong>
            <div class="profile-reward-breakdown">
              <span>Available to claim: ${claimStr} ${item.symbol} (~${claimUsd})</span>
              <span>Minimum to claim: $${CLAIM_MIN_USD} equivalent</span>
              <span>Already claimed: ${claimedStr} ${item.symbol} (~${claimedUsd})</span>
            </div>
          </div>
          ${
            canClaim
              ? `<button class="btn-primary tiny" data-claim-token="${item.token}">Claim</button>`
              : claimWei > 0n && viewer && creator && viewer === creator
                ? `<button class="btn-ghost tiny" type="button" disabled>Below minimum</button>`
              : `<a class="btn-ghost tiny" href="/token?token=${item.token}">Open</a>`
          }
        </article>
      `;
    })
    .join("");

  const totalAcrossUsd = formatCompactUsd(weiToUsd(availableValueWeiTotal + claimedValueWeiTotal, state.ethUsd));
  const availableUsd = formatCompactUsd(weiToUsd(availableValueWeiTotal, state.ethUsd));
  const claimedUsd = formatCompactUsd(weiToUsd(claimedValueWeiTotal, state.ethUsd));

  return `
    <section class="profile-reward-summary-grid">
      <article class="profile-reward-summary-card">
        <small>Total across all coins</small>
        <strong>${totalAcrossUsd}</strong>
      </article>
      <article class="profile-reward-summary-card">
        <small>Available to claim</small>
        <strong>${availableUsd}</strong>
      </article>
      <article class="profile-reward-summary-card">
        <small>Already claimed</small>
        <strong>${claimedUsd}</strong>
      </article>
    </section>
    <div class="profile-reward-list">${rows}</div>
  `;
}

function renderActiveTab() {
  const payload = state.payload;
  if (!payload) {
    ui.profileTabContent.innerHTML = `<p class="muted">Load a profile to see details.</p>`;
    return;
  }

  if (state.activeTab === "balances") {
    ui.profileTabContent.innerHTML = renderBalancesTab(payload.holdings || []);
    return;
  }
  if (state.activeTab === "coins") {
    ui.profileTabContent.innerHTML = renderCoinsTab(payload.created || []);
    return;
  }
  if (state.activeTab === "followers") {
    ui.profileTabContent.innerHTML = renderFollowersTab(payload);
    return;
  }
  if (state.activeTab === "creatorRewards") {
    ui.profileTabContent.innerHTML = renderCreatorRewardsTab(payload);
    return;
  }
  ui.profileTabContent.innerHTML = `<p class="muted">No notifications yet.</p>`;
}

function updateTabButtons() {
  for (const button of ui.profileTabButtons) {
    const active = button.dataset.tab === state.activeTab;
    button.classList.toggle("active", active);
  }
}

async function loadSocialIfNeeded() {
  if (!state.payload || state.socialLoaded || state.socialLoading) return;
  const normalized = normalizeAddress(state.payload.address);
  if (!normalized) return;

  state.socialLoading = true;
  if (state.activeTab === "followers") {
    renderActiveTab();
  }

  try {
    const social = await api.profile(normalized, { includeSocial: true });
    const currentAddress = normalizeAddress(state.payload?.address || "");
    if (!currentAddress || currentAddress !== normalized) return;

    state.payload = {
      ...state.payload,
      followers: social.followers || [],
      following: social.following || state.payload.following || [],
      followersCount: social.followersCount,
      followingCount: social.followingCount,
      socialIncluded: true
    };
    state.socialLoaded = true;
    setSummary(state.payload);
  } finally {
    state.socialLoading = false;
    if (state.activeTab === "followers") {
      renderActiveTab();
    }
  }
}

function setupTabs() {
  for (const button of ui.profileTabButtons) {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab || "balances";
      updateTabButtons();
      renderActiveTab();
      if (state.activeTab === "followers") {
        loadSocialIfNeeded().catch(() => {
          setAlert(ui.alert, "Could not load followers right now", true);
        });
      }
    });
  }
}

function setupCreatorRewardsActions() {
  ui.profileTabContent?.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-claim-token]");
    if (!trigger) return;
    const tokenAddress = normalizeAddress(trigger.dataset.claimToken || "");
    if (!tokenAddress) return;

    try {
      const ws = walletState();
      if (!ws.signer || !ws.address) {
        throw new Error("Connect wallet first");
      }
      trigger.disabled = true;
      setAlert(ui.alert, "Claiming creator rewards...");

      const token = makeTokenContract(tokenAddress);
      const claimableWei = BigInt((await token.creatorClaimable()).toString());
      const launchRow = (state.payload?.created || []).find((row) => normalizeAddress(row?.token || "") === tokenAddress);
      const priceWei = effectivePriceWeiFromPool(launchRow?.pool);
      const claimValueWei = priceWei > 0n ? (claimableWei * priceWei) / 10n ** 18n : 0n;
      const claimValueUsd = weiToUsd(claimValueWei, state.ethUsd);
      if (claimValueUsd < CLAIM_MIN_USD) {
        throw new Error(`Minimum claim is $${CLAIM_MIN_USD} equivalent`);
      }
      const tx = await sendTxWithFallback({
        label: "Claim Creator Fees",
        populatedTx: token.claimCreatorFees.populateTransaction(),
        walletNativeSend: () => token.claimCreatorFees()
      });
      await tx.wait();

      setAlert(ui.alert, "Creator rewards claimed");
      await loadProfile(state.address);
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    } finally {
      trigger.disabled = false;
    }
  });
}

function setSummary(payload) {
  const created = payload.created || [];
  const holdings = payload.holdings || [];
  const followersCount = Number(payload.followersCount || (payload.followers || []).length || 0);
  const followingCount = Number(payload.followingCount || (payload.following || []).length || 0);
  const valueWei = computePortfolioValueWei(holdings);

  if (ui.statFollowers) ui.statFollowers.textContent = String(followersCount);
  if (ui.statFollowing) ui.statFollowing.textContent = String(followingCount);
  if (ui.statCreated) ui.statCreated.textContent = String(created.length);
  if (ui.statValue) ui.statValue.textContent = formatCompactUsd(weiToUsd(valueWei, state.ethUsd));
  if (ui.createdCountInline) ui.createdCountInline.textContent = String(created.length);
  renderProfileHeader(payload.address);
  renderCreatedMiniList(created);
}

async function refreshEthUsd(force = false) {
  const price = await fetchEthUsdPrice(force);
  if (Number.isFinite(price) && price > 0) {
    state.ethUsd = price;
  }
}

async function loadProfile(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    throw new Error("Enter a valid wallet address");
  }

  state.address = normalized;
  updateQuery(normalized);
  const payload = await api.profile(normalized);
  const relatedAddresses = new Set([normalized]);
  for (const row of payload?.created || []) {
    if (row?.creator) relatedAddresses.add(row.creator);
  }
  for (const row of payload?.holdings || []) {
    if (row?.creator) relatedAddresses.add(row.creator);
  }
  for (const row of payload?.followers || []) {
    if (row?.address) relatedAddresses.add(row.address);
  }
  for (const row of payload?.following || []) {
    if (row?.address) relatedAddresses.add(row.address);
  }
  await hydrateUserProfiles([...relatedAddresses], { force: true });
  state.payload = payload;
  state.socialLoaded = Boolean(payload.socialIncluded);
  state.socialLoading = false;
  setSummary(payload);
  renderActiveTab();
  await refreshFollowState();
}

async function loadConfig() {
  const cfg = await api.config();
  state.chainId = Number(cfg.chainId || 1);
  setPreferredChainId(state.chainId);
  ui.netChip.textContent = `Chain ${cfg.chainId}`;
  ui.factoryChip.textContent = shortAddress(cfg.factoryAddress);
}

async function openEditProfileModal() {
  const ws = walletState();
  if (!ws.address) {
    setAlert(ui.alert, "Connect wallet first", true);
    return;
  }

  await hydrateUserProfile(ws.address, { force: true });
  const profile = loadUserProfile(ws.address);
  if (ui.editUsername) ui.editUsername.value = profile.username || defaultUsername(ws.address);
  if (ui.editBio) ui.editBio.value = profile.bio || "";
  state.pendingProfileImageUri = String(profile.imageUri || "");
  updateEditAvatarPreview((profile.username || "EP").slice(0, 2).toUpperCase(), state.pendingProfileImageUri);

  ui.editProfileModal?.classList.add("open");
  ui.editProfileModal?.setAttribute("aria-hidden", "false");
}

function setupEditProfileModal() {
  ui.closeEditProfileModal?.addEventListener("click", hideEditProfileModal);
  ui.editProfileModal?.addEventListener("click", (event) => {
    if (event.target === ui.editProfileModal) {
      hideEditProfileModal();
    }
  });

  ui.editAvatarPickBtn?.addEventListener("click", () => {
    ui.editAvatarFile?.click();
  });

  ui.editAvatarRemoveBtn?.addEventListener("click", () => {
    state.pendingProfileImageUri = "";
    const text = String(ui.editUsername?.value || "EP").slice(0, 2).toUpperCase();
    updateEditAvatarPreview(text || "EP", "");
    if (ui.editAvatarFile) ui.editAvatarFile.value = "";
  });

  ui.editAvatarFile?.addEventListener("change", async (event) => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) throw new Error("Pick a valid image file");
      if (file.size > MAX_PROFILE_IMAGE_BYTES) throw new Error("Profile image too large. Keep it under 2 MB.");

      const dataUrl = await readFileAsDataUrl(file);
      setAlert(ui.alert, "Uploading profile image...");
      const uploaded = await api.uploadImage(dataUrl);
      state.pendingProfileImageUri = uploaded.url;
      const text = String(ui.editUsername?.value || "EP").slice(0, 2).toUpperCase();
      updateEditAvatarPreview(text || "EP", state.pendingProfileImageUri);
      setAlert(ui.alert, "Profile image uploaded");
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    }
  });

  ui.editUsername?.addEventListener("input", () => {
    const text = String(ui.editUsername?.value || "EP").slice(0, 2).toUpperCase();
    updateEditAvatarPreview(text || "EP", state.pendingProfileImageUri);
  });

  ui.saveEditProfileBtn?.addEventListener("click", async () => {
    const ws = walletState();
    if (!ws.address) {
      setAlert(ui.alert, "Connect wallet first", true);
      return;
    }

    const username = String(ui.editUsername?.value || "").trim();
    const bio = String(ui.editBio?.value || "").trim();
    if (!username) {
      setAlert(ui.alert, "Username is required", true);
      return;
    }

    const saved = await saveUserProfile(ws.address, { username, bio, imageUri: state.pendingProfileImageUri });
    updateProfileIdentity();
    if (normalizeAddress(state.address) === normalizeAddress(ws.address)) {
      renderProfileHeader(ws.address);
    }
    hideEditProfileModal();
    if (saved?.synced) {
      setAlert(ui.alert, "Profile updated");
    } else {
      setAlert(ui.alert, "Profile saved locally, but cloud sync failed. Check backend env/API.", true);
    }
  });
}

function setupProfileMenu() {
  ui.profileMenuBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    walletHub?.setOpen(false);
    setProfileMenuOpen(!ui.profileMenu?.classList.contains("open"));
  });

  document.addEventListener("click", (event) => {
    if (!ui.profileMenu || !ui.profileMenuBtn) return;
    if (ui.profileMenu.contains(event.target) || ui.profileMenuBtn.contains(event.target)) return;
    setProfileMenuOpen(false);
  });

  ui.editProfileBtn?.addEventListener("click", () => {
    if (ui.editProfileBtn.disabled) return;
    setProfileMenuOpen(false);
    openEditProfileModal();
  });

  ui.profileShareBtn?.addEventListener("click", async () => {
    const ws = walletState();
    if (!ws.address) return;
    const profileUrl = new URL(`/profile?address=${ws.address}`, window.location.origin).toString();
    try {
      await copyText(profileUrl);
      showCopyToast("Profile link copied");
    } catch {
      setAlert(ui.alert, "Could not copy profile link", true);
    }
  });

  ui.menuLogoutBtn?.addEventListener("click", () => {
    const ws = walletState();
    if (!ws.signer || !ws.address) {
      if (walletControls?.connect) {
        walletControls.connect();
      } else {
        ui.connectBtn?.click();
      }
      setProfileMenuOpen(false);
      return;
    }
    disconnectWallet();
    setWalletLabel(ui.walletLabel);
    if (ui.disconnectBtn?.style) ui.disconnectBtn.style.display = "none";
    setAlert(ui.alert, "Wallet disconnected");
    setProfileMenuOpen(false);
    updateProfileIdentity();
    walletHub?.refresh();
  });
}

function setupAddressControls() {
  ui.profileLoadBtn?.addEventListener("click", async () => {
    try {
      await loadProfile(ui.profileAddressInput.value);
      setAlert(ui.alert, "Profile loaded");
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    }
  });

  ui.profileAddressInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    try {
      await loadProfile(ui.profileAddressInput.value);
      setAlert(ui.alert, "Profile loaded");
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    }
  });
}

function setupFollowButton() {
  ui.profileFollowBtn?.addEventListener("click", async () => {
    if (ui.profileFollowBtn?.dataset?.mode === "edit") {
      try {
        await openEditProfileModal();
      } catch (err) {
        setAlert(ui.alert, parseUiError(err), true);
      }
      return;
    }

    try {
      const viewer = connectedAddress();
      const target = normalizeAddress(state.address || "");
      if (!viewer) {
        throw new Error("Connect wallet first");
      }
      if (!target) {
        throw new Error("Load a profile first");
      }
      if (viewer.toLowerCase() === target.toLowerCase()) {
        return;
      }

      state.followBusy = true;
      syncFollowButton();
      const payload = await api.setFollow(viewer, target, !state.isFollowingProfile);
      state.isFollowingProfile = Boolean(payload?.isFollowing);
      setAlert(ui.alert, state.isFollowingProfile ? "Followed profile" : "Unfollowed profile");
      await loadProfile(target);
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    } finally {
      state.followBusy = false;
      syncFollowButton();
    }
  });
}

async function init() {
  try {
    await refreshEthUsd();
  } catch {
    // keep fallback ETH/USD price
  }

  await loadConfig();

  walletHub = initWalletHubMenu({
    triggerEl: ui.walletHubBtn,
    menuEl: ui.walletHubMenu,
    balanceEl: ui.walletHubBalance,
    balanceLargeEl: ui.walletHubBalanceLarge,
    nativeEl: ui.walletHubNative,
    addressBtnEl: ui.walletHubAddressBtn,
    historyLinkEl: ui.walletHubHistoryLink,
    depositBtnEl: ui.walletHubDepositBtn,
    tradeLinkEl: ui.walletHubTradeLink,
    buyLinkEl: ui.walletHubBuyLink,
    depositModalEl: ui.depositModal,
    depositCloseBtnEl: ui.depositCloseBtn,
    depositCopyBtnEl: ui.depositCopyBtn,
    depositAddressEl: ui.depositAddressText,
    depositQrEl: ui.depositQrImage,
    alertEl: ui.alert,
    onOpen: () => setProfileMenuOpen(false)
  });

  walletControls = initWalletControls({
    selectEl: ui.walletSelect,
    connectBtn: ui.connectBtn,
    disconnectBtn: ui.disconnectBtn,
    labelEl: ui.walletLabel,
    alertEl: ui.alert,
    onConnected: async () => {
      updateProfileIdentity();
      setProfileMenuOpen(false);
      await walletHub?.refresh();
      const ws = walletState();
      if (ws.address && !state.address) {
        await loadProfile(ws.address);
      }
    }
  });

  ui.disconnectBtn?.addEventListener("click", () => {
    updateProfileIdentity();
    setProfileMenuOpen(false);
    walletHub?.refresh();
  });
  ui.connectBtn?.addEventListener("click", () => {
    setTimeout(() => {
      updateProfileIdentity();
      walletHub?.refresh();
    }, 20);
  });
  ui.walletSelect?.addEventListener("change", () => {
    setTimeout(() => {
      updateProfileIdentity();
      walletHub?.refresh();
    }, 20);
  });

  ui.signInBtn?.addEventListener("click", () => {
    if (walletControls?.connect) {
      walletControls.connect();
      return;
    }
    ui.connectBtn?.click();
  });

  setupProfileMenu();
  setupEditProfileModal();
  setupAddressControls();
  setupFollowButton();
  initCoinSearchOverlay({ triggerInputs: [ui.profileAddressInput] });
  setupAddressCopy();
  setupTabs();
  setupCreatorRewardsActions();
  updateTabButtons();
  updateProfileIdentity();
  renderActiveTab();

  setInterval(() => {
    refreshEthUsd(true)
      .then(() => {
        if (state.payload) {
          setSummary(state.payload);
          renderActiveTab();
        }
      })
      .catch(() => {
        // ignore ETH/USD polling failures
      });
  }, 60_000);

  const fromUrl = getAddressFromUrl();
  if (fromUrl) {
    await loadProfile(fromUrl);
    return;
  }

  const ws = walletState();
  if (ws.address) {
    await loadProfile(ws.address);
    return;
  }

  renderProfileHeader("");
}

init().catch((err) => {
  setAlert(ui.alert, parseUiError(err), true);
});
