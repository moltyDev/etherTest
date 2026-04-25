import {
  connectWallet,
  disconnectWallet,
  discoverWallets,
  ethers,
  fetchEthUsdPrice,
  getSavedWalletChoice,
  restoreWalletFromSession,
  shortAddress,
  walletState,
  parseUiError
} from "./core.js";

export function setAlert(el, message, isError = false) {
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", Boolean(isError));
}

let copyToastEl = null;
let copyToastTimer = null;
const COPY_TOAST_ICON = `
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5"></circle>
    <path d="M6.5 10.2l2.2 2.2 4.8-4.8"></path>
  </svg>
`;

export function showCopyToast(message = "Address copied to clipboard") {
  if (!document?.body) return;
  if (!copyToastEl) {
    copyToastEl = document.createElement("div");
    copyToastEl.className = "copy-toast";
    copyToastEl.setAttribute("role", "status");
    copyToastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(copyToastEl);
  }

  copyToastEl.innerHTML = `${COPY_TOAST_ICON}<span>${message}</span>`;
  copyToastEl.classList.add("show");

  if (copyToastTimer) {
    clearTimeout(copyToastTimer);
  }
  copyToastTimer = setTimeout(() => {
    copyToastEl?.classList.remove("show");
  }, 1700);
}

export function setWalletLabel(el) {
  if (!el) return;
  const ws = walletState();
  if (ws.signer && ws.address) {
    el.textContent = `${ws.walletLabel}: ${shortAddress(ws.address)}`;
  } else {
    el.textContent = "Not connected";
  }
}

function formatUsdBalance(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "$0.00";
  return `$${numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function readNativeBalanceEth(ws, address) {
  if (!ws?.provider || !address) {
    throw new Error("Wallet provider unavailable");
  }

  let wei = null;
  let lastError = null;

  try {
    wei = await ws.provider.getBalance(address);
  } catch (error) {
    lastError = error;
  }

  if ((wei === null || wei === undefined) && ws.activeInjectedProvider?.request) {
    try {
      const hex = await ws.activeInjectedProvider.request({
        method: "eth_getBalance",
        params: [address, "latest"]
      });
      if (typeof hex === "string" && hex.startsWith("0x")) {
        wei = BigInt(hex);
      }
    } catch (error) {
      lastError = lastError || error;
    }
  }

  if (wei === null || wei === undefined) {
    throw lastError || new Error("Could not fetch native wallet balance");
  }

  const eth = Number(ethers.formatEther(wei));
  if (!Number.isFinite(eth) || eth < 0) {
    throw new Error("Balance value is invalid");
  }
  return eth;
}

export function initWalletHubMenu({
  triggerEl,
  menuEl,
  balanceEl,
  balanceLargeEl,
  nativeEl,
  addressBtnEl,
  historyLinkEl,
  depositBtnEl,
  tradeLinkEl,
  buyLinkEl,
  depositModalEl,
  depositCloseBtnEl,
  depositCopyBtnEl,
  depositAddressEl,
  depositQrEl,
  alertEl,
  onOpen
} = {}) {
  let open = false;
  let ethUsd = 3000;

  const setOpen = (nextOpen) => {
    if (!menuEl || !triggerEl) return;
    open = Boolean(nextOpen);
    menuEl.classList.toggle("open", open);
    triggerEl.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && typeof onOpen === "function") onOpen();
  };

  const closeDeposit = () => {
    if (!depositModalEl) return;
    depositModalEl.classList.remove("open");
    depositModalEl.setAttribute("aria-hidden", "true");
  };

  const openDeposit = () => {
    if (!depositModalEl) return;
    depositModalEl.classList.add("open");
    depositModalEl.setAttribute("aria-hidden", "false");
  };

  const connectedAddress = () => {
    const ws = walletState();
    return ws?.signer && ws?.address ? ws.address : "";
  };

  const refresh = async () => {
    const ws = walletState();
    const connected = Boolean(ws.signer && ws.address);

    if (!connected) {
      if (balanceEl) balanceEl.textContent = "$0.00";
      if (balanceLargeEl) balanceLargeEl.textContent = "$0.00";
      if (nativeEl) nativeEl.textContent = "0 ETH";
      if (addressBtnEl) {
        addressBtnEl.textContent = "Not connected";
        addressBtnEl.disabled = true;
      }
      if (historyLinkEl) historyLinkEl.href = "/profile";
      if (depositAddressEl) depositAddressEl.textContent = "Not connected";
      if (depositQrEl) {
        depositQrEl.removeAttribute("src");
        depositQrEl.style.display = "none";
      }
      triggerEl?.classList.remove("connected");
      return;
    }

    triggerEl?.classList.add("connected");
    const address = ws.address;
    if (addressBtnEl) {
      addressBtnEl.textContent = shortAddress(address);
      addressBtnEl.disabled = false;
    }
    if (historyLinkEl) {
      historyLinkEl.href = `/profile?address=${address}`;
    }
    if (tradeLinkEl) tradeLinkEl.href = "/";
    if (buyLinkEl && !buyLinkEl.href) {
      buyLinkEl.href = "https://www.moonpay.com/buy/eth";
    }
    if (depositAddressEl) depositAddressEl.textContent = address;
    if (depositQrEl) {
      const data = encodeURIComponent(address);
      depositQrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=176x176&data=${data}`;
      depositQrEl.style.display = "block";
    }

    let balanceEth = null;
    try {
      balanceEth = await readNativeBalanceEth(ws, address);
    } catch {
      balanceEth = null;
    }

    try {
      ethUsd = await fetchEthUsdPrice(false);
    } catch {
      // keep fallback
    }

    if (balanceEth === null) {
      if (balanceEl) balanceEl.textContent = "--";
      if (balanceLargeEl) balanceLargeEl.textContent = "--";
      if (nativeEl) nativeEl.textContent = "Balance unavailable";
      return;
    }

    const usd = Number(balanceEth) * Number(ethUsd || 3000);
    const usdLabel = formatUsdBalance(usd);
    const nativeLabel = `${Number(balanceEth).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;

    if (balanceEl) balanceEl.textContent = usdLabel;
    if (balanceLargeEl) balanceLargeEl.textContent = usdLabel;
    if (nativeEl) nativeEl.textContent = nativeLabel;
  };

  triggerEl?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const next = !open;
    if (next) {
      await refresh();
    }
    setOpen(next);
  });

  document.addEventListener("click", (event) => {
    if (!open) return;
    if (!menuEl || !triggerEl) return;
    if (menuEl.contains(event.target) || triggerEl.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      closeDeposit();
    }
  });

  addressBtnEl?.addEventListener("click", async () => {
    const address = connectedAddress();
    if (!address) {
      setAlert(alertEl, "Connect wallet first", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      showCopyToast("Address copied to clipboard");
    } catch {
      setAlert(alertEl, "Could not copy address", true);
    }
  });

  depositBtnEl?.addEventListener("click", () => {
    const address = connectedAddress();
    if (!address) {
      setAlert(alertEl, "Connect wallet first", true);
      return;
    }
    setOpen(false);
    openDeposit();
  });

  depositCloseBtnEl?.addEventListener("click", closeDeposit);
  depositModalEl?.addEventListener("click", (event) => {
    if (event.target === depositModalEl) {
      closeDeposit();
    }
  });

  depositCopyBtnEl?.addEventListener("click", async () => {
    const address = connectedAddress();
    if (!address) {
      setAlert(alertEl, "Connect wallet first", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      showCopyToast("Address copied to clipboard");
    } catch {
      setAlert(alertEl, "Could not copy address", true);
    }
  });

  refresh().catch(() => {
    // non-blocking on first paint
  });

  return {
    refresh,
    setOpen
  };
}

function showWalletPickerModal(wallets = []) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(wallets) || !wallets.length) {
      reject(new Error("No wallet extension detected"));
      return;
    }

    const preferredOrder = ["metamask", "rabby", "coinbase", "phantom", "injected", "unknown"];
    const orderedWallets = [...wallets].sort((a, b) => {
      const ai = preferredOrder.indexOf(a.key);
      const bi = preferredOrder.indexOf(b.key);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    const primaryWallets = orderedWallets.slice(0, 2);
    const extraWallets = orderedWallets.slice(2);
    const recentChoice = getSavedWalletChoice();

    const iconLabel = (wallet) => {
      if (wallet.key === "metamask") return "MM";
      if (wallet.key === "rabby") return "RB";
      if (wallet.key === "coinbase") return "CB";
      if (wallet.key === "phantom") return "PH";
      return "W";
    };

    const renderWalletButton = (wallet, withStatus = true) => {
      const isRecent = recentChoice && (wallet.id === recentChoice || wallet.key === recentChoice);
      const status = withStatus ? (isRecent ? "RECENT" : "DETECTED") : "";
      const badge = status
        ? `<span class="wallet-picker-badge ${status === "RECENT" ? "recent" : "detected"}"><i></i>${status}</span>`
        : `<span class="wallet-picker-arrow">></span>`;

      return `
        <button type="button" class="btn-ghost wallet-picker-btn" data-wallet-id="${wallet.id || wallet.key}">
          <span class="wallet-picker-btn-left">
            <span class="wallet-picker-icon wallet-${wallet.key}">${iconLabel(wallet)}</span>
            <span class="wallet-picker-name">${wallet.label}</span>
          </span>
          ${badge}
        </button>
      `;
    };

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open wallet-picker-overlay";
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("role", "dialog");
    overlay.innerHTML = `
      <div class="modal-card wallet-picker-card">
        <button type="button" class="wallet-picker-close" aria-label="Close">x</button>
        <div class="wallet-picker-head">
          <div class="wallet-picker-brand">
            <img src="/assets/etherpump-logo.png?v=20260423c" alt="Etherpump" />
          </div>
          <h3>Welcome back</h3>
          <p>Connect your wallet or continue with email.</p>
        </div>
        <div class="wallet-picker-list">
          ${primaryWallets.map((wallet) => renderWalletButton(wallet, true)).join("")}
          <button type="button" class="btn-ghost wallet-picker-btn wallet-picker-more-btn" data-wallet-more ${
            extraWallets.length ? "" : "disabled"
          }>
            <span class="wallet-picker-btn-left">
              <span class="wallet-picker-icon wallet-more">+</span>
              <span class="wallet-picker-name">More wallets</span>
            </span>
            <span class="wallet-picker-arrow">></span>
          </button>
          <div class="wallet-picker-more-list" ${extraWallets.length ? "hidden" : ""}>
            ${extraWallets.map((wallet) => renderWalletButton(wallet, false)).join("")}
          </div>
        </div>
        <div class="wallet-picker-divider"><span>or</span></div>
        <button type="button" class="btn-ghost wallet-picker-btn wallet-picker-email" data-wallet-email>
          <span class="wallet-picker-btn-left">
            <span class="wallet-picker-icon wallet-email">U</span>
            <span>
              <span class="wallet-picker-name">Email or Social</span>
              <small>Zero confirmation trading</small>
            </span>
          </span>
          <span class="wallet-picker-arrow">></span>
        </button>
        <div class="wallet-picker-actions">
          <button type="button" class="btn-ghost wallet-picker-cancel">Cancel</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
    };

    const closeWithError = (message) => {
      cleanup();
      reject(new Error(message));
    };

    const onKeydown = (event) => {
      if (event.key === "Escape") {
        closeWithError("Wallet connection cancelled");
      }
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeWithError("Wallet connection cancelled");
      }
    });

    overlay.querySelector(".wallet-picker-cancel")?.addEventListener("click", () => {
      closeWithError("Wallet connection cancelled");
    });
    overlay.querySelector(".wallet-picker-close")?.addEventListener("click", () => {
      closeWithError("Wallet connection cancelled");
    });

    overlay.querySelector("[data-wallet-more]")?.addEventListener("click", () => {
      const more = overlay.querySelector(".wallet-picker-more-list");
      if (!more) return;
      const hidden = more.hasAttribute("hidden");
      if (hidden) {
        more.removeAttribute("hidden");
      } else {
        more.setAttribute("hidden", "");
      }
    });

    overlay.querySelector("[data-wallet-email]")?.addEventListener("click", () => {
      // placeholder for future email/social login
    });

    overlay.querySelectorAll("[data-wallet-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = String(button.getAttribute("data-wallet-id") || "");
        cleanup();
        resolve(key);
      });
    });

    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
    overlay.querySelector("[data-wallet-id]")?.focus();
  });
}

export function initWalletControls({ selectEl, connectBtn, disconnectBtn, labelEl, alertEl, onConnected } = {}) {
  if (selectEl) {
    selectEl.style.display = "none";
    selectEl.setAttribute("aria-hidden", "true");
    selectEl.tabIndex = -1;
  }
  setWalletLabel(labelEl);

  disconnectBtn?.style && (disconnectBtn.style.display = walletState().signer ? "inline-block" : "none");

  const notifyConnected = async () => {
    if (disconnectBtn?.style) disconnectBtn.style.display = "inline-block";
    if (onConnected) await onConnected();
  };

  const notifyDisconnected = () => {
    if (disconnectBtn?.style) disconnectBtn.style.display = "none";
  };

  (async () => {
    try {
      const restored = await restoreWalletFromSession("");
      if (!restored?.signer) return;
      setWalletLabel(labelEl);
      await notifyConnected();
    } catch {
      // keep page usable even if silent reconnect fails
    }
  })();

  const doConnect = async () => {
    try {
      const wallets = discoverWallets();
      if (!wallets.length) {
        throw new Error("No wallet extension detected. Install MetaMask/Rabby and refresh.");
      }
      const choice = await showWalletPickerModal(wallets);
      await connectWallet(choice);
      setWalletLabel(labelEl);
      await notifyConnected();
      setAlert(alertEl, "Wallet connected");
    } catch (err) {
      const message = parseUiError(err);
      if (String(message).toLowerCase().includes("cancelled")) {
        setAlert(alertEl, "Wallet connection cancelled");
        return;
      }
      setAlert(alertEl, message, true);
      showCopyToast(message);
    }
  };

  const doDisconnect = () => {
    disconnectWallet();
    setWalletLabel(labelEl);
    notifyDisconnected();
    setAlert(alertEl, "Wallet disconnected");
  };

  connectBtn?.addEventListener("click", doConnect);
  disconnectBtn?.addEventListener("click", doDisconnect);

  return {
    connect: doConnect,
    disconnect: doDisconnect
  };
}
