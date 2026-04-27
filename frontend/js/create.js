import { api } from "./api.js";
import {
  FACTORY_ABI,
  defaultUsername,
  disconnectWallet,
  ethers,
  fetchEthUsdPrice,
  hydrateFollowerCount,
  hydrateUserProfile,
  loadCachedFollowerCount,
  loadUserProfile,
  makeFallbackImage,
  makeFactoryContract,
  parseUiError,
  saveUserProfile,
  sendTxWithFallback,
  setPreferredChainId,
  shortAddress,
  walletState
} from "./core.js";
import { initWalletControls, initWalletHubMenu, setAlert, setWalletLabel, showCopyToast } from "./ui.js";
import { initCoinSearchOverlay } from "./searchModal.js?v=20260424d";

const MIN_INITIAL_LIQUIDITY_ETH = 0.5;
const PLATFORM_TEST_MIN_LIQUIDITY_ETH = 0.0001;

const ui = {
  walletSelect: document.getElementById("walletChoice"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  walletLabel: document.getElementById("walletAddress"),
  alert: document.getElementById("alert"),
  tokenSearchInput: document.getElementById("tokenSearchInput"),
  signInBtn: document.getElementById("signInBtn"),
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
  profileNav: document.getElementById("profileNav"),
  profileNavSide: document.getElementById("profileNavSide"),
  editProfileBtn: document.getElementById("editProfileBtn"),
  menuLogoutBtn: document.getElementById("menuLogoutBtn"),
  netChip: document.getElementById("networkChip"),
  factoryChip: document.getElementById("factoryChip"),
  createForm: document.getElementById("createForm"),
  name: document.getElementById("name"),
  symbol: document.getElementById("symbol"),
  description: document.getElementById("description"),
  image: document.getElementById("image"),
  imageFile: document.getElementById("imageFile"),
  pickFileBtn: document.getElementById("pickFileBtn"),
  uploadDropzone: document.getElementById("uploadDropzone"),
  uploadPreviewImage: document.getElementById("uploadPreviewImage"),
  uploadMediaWrap: document.getElementById("uploadMediaWrap"),
  uploadCopy: document.getElementById("uploadCopy"),
  supply: document.getElementById("supply"),
  creatorBuyEth: document.getElementById("creatorBuyEth"),
  creatorAllocationPreviewWrap: document.getElementById("creatorAllocationPreviewWrap"),
  creatorAllocationPreview: document.getElementById("creatorAllocationPreview"),
  creatorAllocationTokens: document.getElementById("creatorAllocationTokens"),
  creatorAllocationHint: document.getElementById("creatorAllocationHint"),
  website: document.getElementById("website"),
  twitter: document.getElementById("twitter"),
  telegram: document.getElementById("telegram"),
  devBuyEth: document.getElementById("devBuyEth"),
  launchMcapUsd: document.getElementById("launchMcapUsd"),
  launchMathCard: document.getElementById("launchMathCard"),
  launchMathPrimary: document.getElementById("launchMathPrimary"),
  launchMathSecondary: document.getElementById("launchMathSecondary"),
  launchMathTertiary: document.getElementById("launchMathTertiary"),
  launchMathQuaternary: document.getElementById("launchMathQuaternary"),
  imagePreview: document.getElementById("imagePreview"),
  previewName: document.getElementById("previewName"),
  previewSymbol: document.getElementById("previewSymbol"),
  previewDescription: document.getElementById("previewDescription"),
  resultLink: document.getElementById("resultLink"),
  createdModal: document.getElementById("createdModal"),
  createdTokenName: document.getElementById("createdTokenName"),
  createdTokenAddress: document.getElementById("createdTokenAddress"),
  openTokenBtn: document.getElementById("openTokenBtn"),
  copyTokenBtn: document.getElementById("copyTokenBtn"),
  closeCreatedModal: document.getElementById("closeCreatedModal"),
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

const MAX_IMAGE_BYTES = 900 * 1024;
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
const state = {
  config: null,
  ethUsd: 3000
};

let pendingProfileImageUri = "";
let walletHub = null;
let walletControls = null;

function followerMetaText(count) {
  const numeric = Math.max(0, Number(count || 0));
  return `${numeric} ${numeric === 1 ? "follower" : "followers"}`;
}

function isPlatformCreatorAddress(address = "") {
  const connected = String(address || "").trim().toLowerCase();
  if (!connected) return false;
  const platformFromConfig = String(state.config?.deployment?.platformFeeRecipient || "").trim().toLowerCase();
  return Boolean(platformFromConfig) && connected === platformFromConfig;
}

function requiredMinLiquidityEth(address = walletState().address) {
  return isPlatformCreatorAddress(address) ? PLATFORM_TEST_MIN_LIQUIDITY_ETH : MIN_INITIAL_LIQUIDITY_ETH;
}

function syncLiquidityInputMin() {
  if (!ui.devBuyEth) return;
  const minLiquidity = requiredMinLiquidityEth(walletState().address);
  ui.devBuyEth.min = String(minLiquidity);
  const current = parseNumberInput(ui.devBuyEth.value, minLiquidity);
  if (!Number.isFinite(current) || current < minLiquidity) {
    ui.devBuyEth.value = minLiquidity.toFixed(minLiquidity < 0.01 ? 4 : 1);
  }
}

function setAvatarNode(node, text, imageUri = "") {
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

function updateEditAvatarPreview(text = "EP", imageUri = "") {
  setAvatarNode(ui.editAvatarPreview, text, imageUri);
}

function setProfileMenuOpen(open) {
  if (!ui.profileMenu || !ui.profileMenuBtn) return;
  ui.profileMenu.classList.toggle("open", open);
  ui.profileMenuBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function updateProfileIdentity() {
  const ws = walletState();
  const connected = Boolean(ws.signer && ws.address);
  const profile = connected ? loadUserProfile(ws.address) : { username: "Guest", bio: "", imageUri: "" };
  const username = profile.username || (connected ? defaultUsername(ws.address) : "Guest");
  const avatarText = connected ? username.slice(0, 2).toUpperCase() : "EP";
  const imageUri = connected ? profile.imageUri || "" : "";
  const profileHref = connected ? `/profile?address=${ws.address}` : "/profile";

  if (ui.profileMenuName) ui.profileMenuName.textContent = username;
  if (ui.profileMenuNameLarge) ui.profileMenuNameLarge.textContent = username;
  if (ui.profileMenuMeta) {
    if (connected) {
      const cachedFollowers = loadCachedFollowerCount(ws.address);
      ui.profileMenuMeta.textContent = followerMetaText(cachedFollowers ?? 0);
    } else {
      ui.profileMenuMeta.textContent = "Not connected";
    }
  }
  if (ui.signInBtn) ui.signInBtn.style.display = connected ? "none" : "inline-flex";
  if (ui.walletHubBtn) ui.walletHubBtn.style.display = connected ? "inline-flex" : "none";
  if (ui.profileMenuBtn) ui.profileMenuBtn.style.display = connected ? "inline-flex" : "none";
  if (!connected) {
    walletHub?.setOpen(false);
    setProfileMenuOpen(false);
  }
  setAvatarNode(ui.profileAvatar, avatarText, imageUri);
  setAvatarNode(ui.profileAvatarLarge, avatarText, imageUri);
  if (ui.profileNav) ui.profileNav.href = profileHref;
  if (ui.profileNavSide) ui.profileNavSide.href = profileHref;

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
    hydrateFollowerCount(currentAddress).then((followersCount) => {
      const next = walletState();
      if (String(next.address || "").toLowerCase() !== currentAddress.toLowerCase()) return;
      if (ui.profileMenuMeta) {
        ui.profileMenuMeta.textContent = followerMetaText(followersCount);
      }
    }).catch(() => {
      // ignore follower-count hydration failures
    });
    hydrateUserProfile(currentAddress).then(() => {
      const next = walletState();
      if (String(next.address || "").toLowerCase() !== currentAddress.toLowerCase()) return;
      const fresh = loadUserProfile(currentAddress);
      if (fresh.username !== username || String(fresh.imageUri || "") !== String(imageUri || "")) {
        updateProfileIdentity();
      }
    }).catch(() => {
      // ignore profile hydration failures
    });
  }
}

function hideEditProfileModal() {
  if (!ui.editProfileModal) return;
  ui.editProfileModal.classList.remove("open");
  ui.editProfileModal.setAttribute("aria-hidden", "true");
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
  pendingProfileImageUri = String(profile.imageUri || "");
  updateEditAvatarPreview((profile.username || "EP").slice(0, 2).toUpperCase(), pendingProfileImageUri);
  ui.editProfileModal?.classList.add("open");
  ui.editProfileModal?.setAttribute("aria-hidden", "false");
}

function setupProfileMenu() {
  ui.profileMenuBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    walletHub?.setOpen(false);
    const isOpen = ui.profileMenu?.classList.contains("open");
    setProfileMenuOpen(!isOpen);
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
      await navigator.clipboard.writeText(profileUrl);
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
    pendingProfileImageUri = "";
    const text = String(ui.editUsername?.value || "EP").slice(0, 2).toUpperCase();
    updateEditAvatarPreview(text || "EP", "");
    if (ui.editAvatarFile) {
      ui.editAvatarFile.value = "";
    }
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
      pendingProfileImageUri = uploaded.url;
      const text = String(ui.editUsername?.value || "EP").slice(0, 2).toUpperCase();
      updateEditAvatarPreview(text || "EP", pendingProfileImageUri);
      setAlert(ui.alert, "Profile image uploaded");
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    }
  });

  ui.editUsername?.addEventListener("input", () => {
    const text = String(ui.editUsername?.value || "EP").slice(0, 2).toUpperCase();
    updateEditAvatarPreview(text || "EP", pendingProfileImageUri);
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

    const saved = await saveUserProfile(ws.address, { username, bio, imageUri: pendingProfileImageUri });
    updateProfileIdentity();
    hideEditProfileModal();
    if (saved?.synced) {
      setAlert(ui.alert, "Profile updated");
    } else {
      setAlert(ui.alert, "Profile saved locally, but cloud sync failed. Check backend env/API.", true);
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.readAsDataURL(file);
  });
}

function showImagePreview(src) {
  if (!ui.imagePreview) return;
  if (!src) {
    ui.imagePreview.style.display = "none";
    ui.imagePreview.removeAttribute("src");
    return;
  }
  ui.imagePreview.src = src;
  ui.imagePreview.style.display = "block";
}

function showUploadBoxPreview(src) {
  if (!ui.uploadPreviewImage || !ui.uploadMediaWrap || !ui.uploadCopy) return;
  if (!src) {
    ui.uploadPreviewImage.removeAttribute("src");
    ui.uploadPreviewImage.style.display = "none";
    ui.uploadMediaWrap.classList.remove("active");
    ui.uploadCopy.style.display = "grid";
    return;
  }

  ui.uploadPreviewImage.src = src;
  ui.uploadPreviewImage.style.display = "block";
  ui.uploadMediaWrap.classList.add("active");
  ui.uploadCopy.style.display = "none";
}

function parseNumberInput(value, fallback = 0) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function deriveCreatorAllocationPct(liquidityEth, creatorBuyEth) {
  const safeLiquidityEth = Math.max(0, liquidityEth);
  const safeCreatorBuyEth = Math.max(0, creatorBuyEth);
  const totalEth = safeLiquidityEth + safeCreatorBuyEth;
  if (totalEth <= 0) return 0;
  return (safeCreatorBuyEth / totalEth) * 100;
}

function getLaunchEconomics(
  liquidityEthInput = parseNumberInput(ui.devBuyEth?.value, 0),
  creatorBuyEthInput = parseNumberInput(ui.creatorBuyEth?.value, 0)
) {
  const totalSupply = parseNumberInput(ui.supply?.value, 0);
  const liquidityEth = Math.max(0, liquidityEthInput);
  const creatorBuyEth = Math.max(0, creatorBuyEthInput);
  const creatorPct = deriveCreatorAllocationPct(liquidityEth, creatorBuyEth);
  const ethUsd = Number.isFinite(state.ethUsd) && state.ethUsd > 0 ? state.ethUsd : 3000;

  const creatorFraction = Math.min(Math.max(creatorPct / 100, 0), 0.9999);
  const poolFraction = Math.max(0.0001, 1 - creatorFraction);
  const poolTokens = totalSupply * poolFraction;
  const mcapMultiplier = poolTokens > 0 ? totalSupply / poolTokens : 0;

  const marketCapEth = liquidityEth * mcapMultiplier;
  const marketCapUsd = marketCapEth * ethUsd;
  const oneEthMcapUsd = mcapMultiplier * ethUsd;
  const minLiquidityEth = requiredMinLiquidityEth(walletState().address);
  const minTargetMcapUsd = minLiquidityEth * mcapMultiplier * ethUsd;
  return {
    totalSupply,
    creatorPct,
    creatorBuyEth,
    poolFraction,
    poolTokens,
    mcapMultiplier,
    liquidityEth,
    marketCapEth,
    marketCapUsd,
    oneEthMcapUsd,
    minLiquidityEth,
    minTargetMcapUsd
  };
}

function updateLaunchMath({ source = "liquidity" } = {}) {
  if (!ui.launchMathCard) return;
  const economicsFromLiquidity = getLaunchEconomics(parseNumberInput(ui.devBuyEth?.value, 0));
  const targetMcapUsdInput = parseNumberInput(ui.launchMcapUsd?.value, 0);

  if (source === "target" && targetMcapUsdInput > 0 && economicsFromLiquidity.mcapMultiplier > 0) {
    const requiredLiquidityEthRaw = (targetMcapUsdInput / Math.max(state.ethUsd, 1)) / economicsFromLiquidity.mcapMultiplier;
    const requiredLiquidityEth = Math.max(requiredMinLiquidityEth(walletState().address), requiredLiquidityEthRaw);
    if (Number.isFinite(requiredLiquidityEth) && requiredLiquidityEth >= 0) {
      ui.devBuyEth.value = requiredLiquidityEth.toFixed(6);
    }
  }

  const economics = getLaunchEconomics(parseNumberInput(ui.devBuyEth?.value, 0));
  if (source === "liquidity" && ui.launchMcapUsd) {
    const nextTarget = economics.marketCapUsd > 0 ? economics.marketCapUsd : 0;
    ui.launchMcapUsd.value = nextTarget.toFixed(2);
  }

  const creatorWithinCap = economics.creatorPct <= 20;
  const meetsMin = economics.marketCapUsd >= economics.minTargetMcapUsd;
  ui.launchMathCard.classList.toggle("invalid", !meetsMin || !creatorWithinCap);

  if (ui.launchMathPrimary) {
    ui.launchMathPrimary.textContent = `Estimated launch market cap: ${formatUsd(economics.marketCapUsd)} (~${economics.marketCapEth.toFixed(4)} ETH)`;
  }
  if (ui.launchMathSecondary) {
    const platformTag = isPlatformCreatorAddress(walletState().address) ? " (platform test wallet)" : "";
    ui.launchMathSecondary.textContent = `Minimum launch liquidity: ${economics.minLiquidityEth.toFixed(4)} ETH${platformTag}`;
  }
  if (ui.launchMathTertiary) {
    ui.launchMathTertiary.textContent = `Minimum launch market cap at ${economics.minLiquidityEth.toFixed(4)} ETH: ${formatUsd(economics.minTargetMcapUsd)}`;
  }
  if (ui.launchMathQuaternary) {
    ui.launchMathQuaternary.textContent = `At your settings, 1 ETH liquidity ~ ${formatUsd(economics.oneEthMcapUsd)} market cap`;
  }
  if (ui.creatorAllocationPreview) {
    const symbol = String(ui.symbol?.value || "TOKEN").trim().toUpperCase() || "TOKEN";
    const creatorTokens = economics.totalSupply * (economics.creatorPct / 100);
    const maxCreatorBuyEth = economics.liquidityEth * 0.25;
    ui.creatorAllocationPreview.textContent = `${economics.creatorPct.toFixed(2)}% of total supply`;
    if (ui.creatorAllocationTokens) {
      ui.creatorAllocationTokens.textContent = `${formatTokenAmount(creatorTokens)} ${symbol}`;
    }
    if (ui.creatorAllocationHint) {
      ui.creatorAllocationHint.textContent = creatorWithinCap
        ? `At current liquidity, up to ${maxCreatorBuyEth.toFixed(4)} ETH keeps creator at/below 20%.`
        : `Too high: lower creator buy to ${maxCreatorBuyEth.toFixed(4)} ETH or less (20% max).`;
    }
    ui.creatorAllocationPreviewWrap?.classList.toggle("invalid", !creatorWithinCap);
  }
}

function formatUsd(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 2
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(n);
}

function formatTokenAmount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 2
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4
  }).format(n);
}

function updatePreview() {
  const name = ui.name.value.trim() || "Your Coin";
  const symbol = ui.symbol.value.trim().toUpperCase() || "TICKER";
  const description = ui.description.value.trim() || "Your coin description appears here.";

  ui.previewName.textContent = name;
  ui.previewSymbol.textContent = `$${symbol}`;
  ui.previewDescription.textContent = description;

  const explicitImage = ui.image.value.trim();
  const src = explicitImage || makeFallbackImage(name, symbol);
  showImagePreview(src);
  showUploadBoxPreview(explicitImage);
}

function composeDescription() {
  const base = ui.description.value.trim();
  const socials = [];
  const website = ui.website.value.trim();
  const twitter = ui.twitter.value.trim();
  const telegram = ui.telegram.value.trim();

  if (website) socials.push(`Website: ${website}`);
  if (twitter) socials.push(`Twitter: ${twitter}`);
  if (telegram) socials.push(`Telegram: ${telegram}`);

  return [base, socials.join(" | ")].filter(Boolean).join("\n");
}

async function uploadSelectedFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) throw new Error("Pick a valid image file");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Image too large. Keep it under 900 KB.");

  const dataUrl = await readFileAsDataUrl(file);
  setAlert(ui.alert, "Uploading image...");
  const uploaded = await api.uploadImage(dataUrl);
  ui.image.value = uploaded.url;
  updatePreview();
  setAlert(ui.alert, "Image uploaded");
}

function setupFormEnhancements() {
  const onInput = () => {
    updatePreview();
  };

  ui.name.addEventListener("input", onInput);
  ui.symbol.addEventListener("input", onInput);
  ui.symbol.addEventListener("input", () => updateLaunchMath({ source: "liquidity" }));
  ui.description.addEventListener("input", onInput);
  ui.image.addEventListener("input", onInput);
  ui.supply?.addEventListener("input", () => updateLaunchMath({ source: "liquidity" }));
  ui.creatorBuyEth?.addEventListener("input", () => updateLaunchMath({ source: "liquidity" }));
  ui.devBuyEth?.addEventListener("input", () => updateLaunchMath({ source: "liquidity" }));
  ui.launchMcapUsd?.addEventListener("input", () => updateLaunchMath({ source: "target" }));
  ui.pickFileBtn?.addEventListener("click", () => {
    ui.imageFile?.click();
  });

  const activateDrop = (active) => {
    ui.uploadDropzone?.classList.toggle("drag-active", active);
  };
  const prevent = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  ui.uploadDropzone?.addEventListener("dragenter", (event) => {
    prevent(event);
    activateDrop(true);
  });
  ui.uploadDropzone?.addEventListener("dragover", (event) => {
    prevent(event);
    activateDrop(true);
  });
  ui.uploadDropzone?.addEventListener("dragleave", (event) => {
    prevent(event);
    activateDrop(false);
  });
  ui.uploadDropzone?.addEventListener("drop", async (event) => {
    try {
      prevent(event);
      activateDrop(false);
      const file = event.dataTransfer?.files?.[0];
      await uploadSelectedFile(file);
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    }
  });

  ui.imageFile.addEventListener("change", async (event) => {
    try {
      const file = event.target.files?.[0];
      await uploadSelectedFile(file);
    } catch (err) {
      setAlert(ui.alert, parseUiError(err), true);
    }
  });
}

function extractLaunchCreated(receipt) {
  const iface = new ethers.Interface(FACTORY_ABI);
  for (const log of receipt.logs || []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "LaunchCreated") {
        return {
          token: parsed.args.token,
          pool: parsed.args.pool,
          launchId: parsed.args.launchId
        };
      }
    } catch {
      // skip unrelated logs
    }
  }
  return null;
}

function hideCreatedModal() {
  if (!ui.createdModal) return;
  ui.createdModal.classList.remove("open");
  ui.createdModal.setAttribute("aria-hidden", "true");
}

function showCreatedModal({ name, symbol, token }) {
  if (!ui.createdModal || !token) return;
  ui.createdTokenName.textContent = `${name} ($${symbol})`;
  ui.createdTokenAddress.textContent = token;
  ui.openTokenBtn.href = `/token?token=${token}`;
  ui.createdModal.classList.add("open");
  ui.createdModal.setAttribute("aria-hidden", "false");
}

function setupCreatedModal() {
  ui.closeCreatedModal?.addEventListener("click", hideCreatedModal);
  ui.createdModal?.addEventListener("click", (event) => {
    if (event.target === ui.createdModal) {
      hideCreatedModal();
    }
  });
  ui.copyTokenBtn?.addEventListener("click", async () => {
    try {
      const value = ui.createdTokenAddress?.textContent || "";
      if (!value || value === "-") return;
      await navigator.clipboard.writeText(value);
      showCopyToast("Address copied to clipboard");
    } catch {
      setAlert(ui.alert, "Could not copy address", true);
    }
  });
}

async function onCreate(event) {
  event.preventDefault();

  try {
    const ws = walletState();
    if (!ws.signer) throw new Error("Connect wallet first");

    const name = ui.name.value.trim();
    const symbol = ui.symbol.value.trim().toUpperCase();
    const totalSupplyInput = ui.supply.value.trim();
    const creatorBuyEth = parseNumberInput(ui.creatorBuyEth?.value, 0);
    let imageUri = ui.image.value.trim();
    const description = composeDescription();
    const initialLiquidityEthInput = ui.devBuyEth.value.trim();

    if (!name || !symbol) throw new Error("Coin name and ticker are required");
    if (!Number.isFinite(creatorBuyEth) || creatorBuyEth < 0) {
      throw new Error("Creator buy amount must be 0 or higher");
    }

    if (!imageUri) {
      imageUri = makeFallbackImage(name, symbol);
    }

  if (imageUri.startsWith("data:image/")) {
      const uploaded = await api.uploadImage(imageUri);
      imageUri = uploaded.url;
      ui.image.value = imageUri;
    }

    if (imageUri.startsWith("data:image/")) {
      imageUri = `${window.location.origin}/assets/etherpump-logo.png`;
      ui.image.value = imageUri;
      setAlert(
        ui.alert,
        "Image upload returned inline data. Using hosted fallback image to avoid gas-estimation failure."
      );
    }

    const totalSupply = ethers.parseUnits(totalSupplyInput, 18);
    const factory = makeFactoryContract(state.config.factoryAddress);

    const initialLiquidityEth = ethers.parseEther(initialLiquidityEthInput || "0");
    if (initialLiquidityEth <= 0n) {
      throw new Error("Initial ETH liquidity is required for instant Uniswap launch");
    }
    const minLiquidityEthRequired = requiredMinLiquidityEth(ws.address);
    const minLiquidityWei = ethers.parseEther(String(minLiquidityEthRequired));
    if (initialLiquidityEth < minLiquidityWei) {
      throw new Error(`Minimum launch liquidity is ${minLiquidityEthRequired} ETH`);
    }
    const creatorPct = deriveCreatorAllocationPct(parseNumberInput(initialLiquidityEthInput, 0), creatorBuyEth);
    if (creatorPct > 20) {
      const maxCreatorBuyEth = parseNumberInput(initialLiquidityEthInput, 0) * 0.25;
      throw new Error(
        `Creator buy amount is too high for launch liquidity. Max ${maxCreatorBuyEth.toFixed(4)} ETH keeps allocation at or below 20%.`
      );
    }
    const creatorBps = BigInt(Math.round(creatorPct * 100));
    const launchFeeWei = BigInt(state.config?.deployment?.launchFeeWei || "0");
    const totalValue = initialLiquidityEth + launchFeeWei;

    const simulated = await factory.createLaunchInstant.staticCall(
      name,
      symbol,
      imageUri,
      description,
      totalSupply,
      creatorBps,
      { value: totalValue }
    );

    if (launchFeeWei > 0n) {
      const launchFeeEth = Number(ethers.formatEther(launchFeeWei)).toFixed(6);
      setAlert(ui.alert, `Launching to Uniswap (launch fee ${launchFeeEth} ETH)...`);
    } else {
      setAlert(ui.alert, "Launching directly to Uniswap...");
    }
    const tx = await sendTxWithFallback({
      label: "Create Instant Launch",
      populatedTx: factory.createLaunchInstant.populateTransaction(
        name,
        symbol,
        imageUri,
        description,
        totalSupply,
        creatorBps,
        { value: totalValue }
      ),
      walletNativeSend: () =>
        factory.createLaunchInstant(name, symbol, imageUri, description, totalSupply, creatorBps, {
          value: totalValue
        })
    });

    const receipt = await tx.wait();
    const launchInfo = extractLaunchCreated(receipt) || {
      launchId: simulated?.[0],
      token: simulated?.[1],
      pool: simulated?.[2]
    };

    if (launchInfo?.token) {
      ui.resultLink.href = `/token?token=${launchInfo.token}`;
      ui.resultLink.textContent = `Open ${shortAddress(launchInfo.token)} token page`;
      ui.resultLink.style.display = "inline-block";
      showCreatedModal({ name, symbol, token: launchInfo.token });
    }

    ui.createForm.reset();
    updatePreview();
    updateLaunchMath({ source: "liquidity" });
    setAlert(ui.alert, "Launch created on Uniswap successfully");
  } catch (err) {
    setAlert(ui.alert, parseUiError(err), true);
  }
}

async function init() {
  try {
    state.ethUsd = await fetchEthUsdPrice();
  } catch {
    state.ethUsd = 3000;
  }

  state.config = await api.config();
  setPreferredChainId(Number(state.config.chainId || 1));
  ui.netChip.textContent = `Chain ${state.config.chainId}`;
  ui.factoryChip.textContent = shortAddress(state.config.factoryAddress);

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
      syncLiquidityInputMin();
      updateLaunchMath({ source: "liquidity" });
      await walletHub?.refresh();
    }
  });

  ui.disconnectBtn?.addEventListener("click", () => {
    updateProfileIdentity();
    setProfileMenuOpen(false);
    syncLiquidityInputMin();
    updateLaunchMath({ source: "liquidity" });
    walletHub?.refresh();
  });

  ui.connectBtn?.addEventListener("click", () => {
    setTimeout(() => {
      updateProfileIdentity();
      syncLiquidityInputMin();
      updateLaunchMath({ source: "liquidity" });
      walletHub?.refresh();
    }, 20);
  });

  ui.walletSelect?.addEventListener("change", () => {
    setTimeout(() => {
      updateProfileIdentity();
      syncLiquidityInputMin();
      updateLaunchMath({ source: "liquidity" });
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
  setupFormEnhancements();
  setupCreatedModal();
  initCoinSearchOverlay({ triggerInputs: [ui.tokenSearchInput] });
  updatePreview();
  syncLiquidityInputMin();
  updateLaunchMath({ source: "liquidity" });
  updateProfileIdentity();
  ui.createForm.addEventListener("submit", onCreate);
}

init().catch((err) => {
  setAlert(ui.alert, parseUiError(err), true);
});
