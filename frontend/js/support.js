import { api } from "./api.js";
import { defaultUsername, loadUserProfile, shortAddress, walletState } from "./core.js";
import { setAlert } from "./ui.js";

const SUPPORT_MODAL_ID = "supportWidgetModal";
const SUPPORT_LINK_ID = "supportSideLink";

const HELP_COLLECTIONS = [
  {
    key: "creating",
    title: "Creating and Managing Coins",
    description: "Token setup, launch flow, and post-launch management.",
    author: "Etherpump Team",
    articles: [
      {
        key: "create-coin",
        title: "Create a Coin on Etherpump.fun",
        summary: "Launch flow, costs, and setup FAQs.",
        blocks: [
          { type: "p", text: "Coin creation on Etherpump.fun deploys your token and opens Uniswap trading in one flow." },
          {
            type: "faq",
            items: [
              { q: "How much does it cost to create and buy?", a: "You pay Ethereum gas, launch fee, chosen initial liquidity, and optional creator buy amount." },
              { q: "What is a ticker?", a: "Ticker is your short symbol like PEPE, EP, DOGE." },
              { q: "What image files are supported?", a: "Use PNG, JPG, WEBP, or GIF. Square images are best for cards and profile rows." },
              { q: "How do I add socials?", a: "Fill optional social fields in Create. External indexers may need extra time to sync." },
              { q: "Why does launch sometimes fail estimation?", a: "Usually gas spikes, low balance, or invalid inline image data. Re-upload image and retry." }
            ]
          }
        ],
        related: ["coin-not-showing", "edit-coin-meta"]
      },
      {
        key: "coin-not-showing",
        title: "Coin Isn't Showing When I Search",
        summary: "How indexing works across explorers and Dex trackers.",
        blocks: [
          { type: "p", text: "New pools can take time to index. Verify deployment with token address first, then pair visibility on Dex trackers." },
          {
            type: "list",
            items: [
              "Confirm you are on Ethereum mainnet.",
              "Verify token contract on Etherscan.",
              "Use pair address for Dex pair checks.",
              "Some indexers can lag 30-120 seconds."
            ]
          }
        ],
        related: ["create-coin"]
      },
      {
        key: "edit-coin-meta",
        title: "How to Edit Coin Image, Description, and Socials",
        summary: "What can be changed and what is immutable.",
        blocks: [
          { type: "p", text: "Set coin name, symbol, image, and description carefully before launch. External services cache data on their own schedules." },
          { type: "note", text: "If old metadata appears, wait for indexer refresh or force re-index on the external platform." }
        ],
        related: ["create-coin"]
      }
    ]
  },
  {
    key: "wallet",
    title: "Managing Your Wallet",
    description: "Depositing, making a trade, and withdrawing.",
    author: "Etherpump Team",
    articles: [
      {
        key: "depositing-funds",
        title: "Depositing Funds",
        summary: "Funding wallet for launches and trades.",
        blocks: [
          {
            type: "list",
            items: [
              "Keep extra ETH for gas.",
              "Use one wallet for consistent profile/follow data.",
              "Check gas before launching."
            ]
          }
        ],
        related: ["making-a-trade", "withdrawing-funds"]
      },
      {
        key: "making-a-trade",
        title: "Making a Trade",
        summary: "Buy/sell execution and slippage tips.",
        blocks: [
          { type: "p", text: "Enter token or ETH amount, confirm output, then sign in wallet. If route fails, lower size and retry." }
        ],
        related: ["depositing-funds"]
      },
      {
        key: "withdrawing-funds",
        title: "Withdrawing Funds",
        summary: "Moving assets out safely.",
        blocks: [
          { type: "p", text: "Withdrawals are normal wallet transfers. Keep enough ETH for transfer gas and approval tx if needed." }
        ],
        related: ["depositing-funds"]
      }
    ]
  },
  {
    key: "fees",
    title: "Tokenomics & Fees",
    description: "Launch fee, creator rewards, and platform split.",
    author: "Etherpump Team",
    articles: [
      {
        key: "tx-fees",
        title: "Transaction Fees on Etherpump.fun",
        summary: "Fee structure in one place.",
        blocks: [
          {
            type: "list",
            items: [
              "Launch fee is charged when coin is created.",
              "Trade fee split allocates to creator + platform.",
              "Creator rewards accrue from actual trading activity."
            ]
          }
        ],
        related: ["creator-rewards"]
      },
      {
        key: "creator-rewards",
        title: "Creator Rewards and Claims",
        summary: "How claim works and minimum threshold behavior.",
        blocks: [
          { type: "p", text: "Claim button activates only after minimum claim threshold is met. Profile tab shows total/claimed/unclaimed values." }
        ],
        related: ["tx-fees"]
      }
    ]
  },
  {
    key: "liquidity",
    title: "Uniswap Liquidity",
    description: "How launch liquidity works and risk basics.",
    author: "Etherpump Team",
    articles: [
      {
        key: "liquidity-basics",
        title: "Liquidity on Uniswap",
        summary: "What initial liquidity impacts.",
        blocks: [
          {
            type: "list",
            items: [
              "Higher liquidity usually reduces early volatility.",
              "Thin pools can move sharply on small trades.",
              "External chart feeds may lag right after launch."
            ]
          }
        ],
        related: ["dev-risk"]
      },
      {
        key: "dev-risk",
        title: "Can the developer rug?",
        summary: "Liquidity and holder concentration realities.",
        blocks: [
          { type: "p", text: "Liquidity mechanics can be constrained by platform rules, but large holder concentration can still impact price heavily." }
        ],
        related: ["liquidity-basics"]
      }
    ]
  }
];

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeAddress(value = "") {
  const text = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text : "";
}

function nowAgo(unixSeconds) {
  const ts = Number(unixSeconds || 0) * 1000;
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const d = Date.now() - ts;
  if (d < 60_000) return "now";
  const mins = Math.floor(d / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function currentAddress() {
  return normalizeAddress(walletState()?.address || "");
}

function profileName(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return "Guest";
  const profile = loadUserProfile(normalized);
  return profile.username || defaultUsername(normalized);
}

function ensureSupportSideLink() {
  const nav = document.querySelector(".side-nav");
  if (!nav) return null;
  let link = document.getElementById(SUPPORT_LINK_ID);
  if (link) return link;
  link = document.createElement("a");
  link.id = SUPPORT_LINK_ID;
  link.className = "side-link side-link-support";
  link.href = "#";
  link.innerHTML = `
    <span class="side-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6.2 7.2A7.1 7.1 0 0 1 12 4.5c4 0 7.2 3.2 7.2 7.2v1.4a3.4 3.4 0 0 1-3.4 3.4h-1.4v-5.8a2.4 2.4 0 0 1 2.4-2.4"></path>
        <path d="M17.8 16.5v.7a3.5 3.5 0 0 1-3.5 3.5h-4.6"></path>
        <path d="M4.8 16.5h-.6a2.6 2.6 0 0 1-2.6-2.6v-1.9a2.6 2.6 0 0 1 2.6-2.6h.6"></path>
      </svg>
    </span>
    <span class="side-link-label">Support</span>
  `;
  const terminal = Array.from(nav.querySelectorAll("a.side-link")).find((x) =>
    String(x.textContent || "").toLowerCase().includes("terminal")
  );
  if (terminal) terminal.insertAdjacentElement("beforebegin", link);
  else nav.appendChild(link);
  return link;
}

function createModal() {
  let modal = document.getElementById(SUPPORT_MODAL_ID);
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = SUPPORT_MODAL_ID;
  modal.className = "support-widget-overlay";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="support-widget-card support-v2">
      <button class="support-widget-close" id="supportWidgetCloseBtn" type="button">X</button>
      <div id="supportWidgetBody"></div>
      <div class="support-widget-nav">
        <button type="button" data-support-tab="home" class="active">Home</button>
        <button type="button" data-support-tab="messages">Messages</button>
        <button type="button" data-support-tab="help">Help</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function articleMap() {
  const map = new Map();
  for (const c of HELP_COLLECTIONS) {
    for (const a of c.articles || []) {
      map.set(a.key, a);
    }
  }
  return map;
}

function renderBlocks(article) {
  const map = articleMap();
  const content = (article.blocks || [])
    .map((b) => {
      if (b.type === "p") return `<p>${escapeHtml(b.text || "")}</p>`;
      if (b.type === "note") return `<div class="support-note-box">${escapeHtml(b.text || "")}</div>`;
      if (b.type === "list") return `<ul>${(b.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join("")}</ul>`;
      if (b.type === "faq") {
        return `<div class="support-accordion">${(b.items || [])
          .map((row) => `<details><summary>${escapeHtml(row.q || "")}</summary><p>${escapeHtml(row.a || "")}</p></details>`)
          .join("")}</div>`;
      }
      return "";
    })
    .join("");
  const related = (article.related || [])
    .map((k) => map.get(k))
    .filter(Boolean)
    .map((a) => `<button type="button" class="support-article-row" data-support-article="${escapeHtml(a.key)}"><span>${escapeHtml(a.title)}</span><em>></em></button>`)
    .join("");
  return `${content}${related ? `<hr /><h5>Related Articles</h5><div class="support-article-list">${related}</div>` : ""}`;
}

export function initSupportWidget({ alertEl = null } = {}) {
  const sideLink = ensureSupportSideLink();
  const modal = createModal();
  if (!sideLink || !modal) return null;

  const body = modal.querySelector("#supportWidgetBody");
  const closeBtn = modal.querySelector("#supportWidgetCloseBtn");
  const navBtns = Array.from(modal.querySelectorAll("[data-support-tab]"));
  const state = {
    open: false,
    tab: "home",
    view: "tab",
    collectionKey: "",
    articleKey: "",
    search: "",
    config: null,
    messages: [],
    inbox: [],
    isAdmin: false
  };

  function setTab(tab) {
    state.tab = tab;
    state.view = "tab";
    state.collectionKey = "";
    state.articleKey = "";
    for (const btn of navBtns) btn.classList.toggle("active", btn.dataset.supportTab === tab);
    render().catch(() => {});
  }

  async function loadConfigAndMessages() {
    if (!state.config) {
      try {
        const cfg = await api.supportConfig();
        state.config = cfg || {};
      } catch {
        state.config = {};
      }
    }
    const address = currentAddress();
    const platformAddress = normalizeAddress(state.config?.platformAddress || "");
    state.isAdmin =
      Boolean(address) &&
      Boolean(platformAddress) &&
      String(address).toLowerCase() === String(platformAddress).toLowerCase();

    if (address) {
      try {
        const payload = await api.supportMessages(address);
        state.messages = Array.isArray(payload?.messages) ? payload.messages : [];
      } catch {
        state.messages = [];
      }
      if (state.isAdmin) {
        try {
          const inboxPayload = await api.supportInbox(address);
          state.inbox = Array.isArray(inboxPayload?.messages) ? inboxPayload.messages : [];
        } catch {
          state.inbox = [];
        }
      } else {
        state.inbox = [];
      }
    } else {
      state.messages = [];
      state.inbox = [];
    }
  }

  function renderHome() {
    const recent = state.messages?.[0];
    const allArticles = HELP_COLLECTIONS.flatMap((c) => c.articles || []);
    const query = String(state.search || "").trim().toLowerCase();
    const featured = query
      ? allArticles
          .filter((a) => `${a.title} ${a.summary || ""}`.toLowerCase().includes(query))
          .slice(0, 4)
      : HELP_COLLECTIONS.flatMap((c) => c.articles.slice(0, 1)).slice(0, 4);
    return `
      <div class="support-home-hero">
        <div class="support-home-top">
          <div class="support-home-logo"><img src="/assets/support-pill-main.png" alt="Etherpump logo" /></div>
          <div class="support-home-avatars">
            <img src="/assets/support-nft-1.jpg" alt="NFT avatar 1" loading="lazy" />
            <img src="/assets/support-nft-2.png" alt="NFT avatar 2" loading="lazy" />
            <img src="/assets/support-nft-3.png" alt="NFT avatar 3" loading="lazy" />
          </div>
        </div>
        <h3>Hi there</h3>
        <p>How may we help?</p>
      </div>
      ${
        recent
          ? `<button type="button" class="support-recent-card" data-open-messages="1"><small>Recent message</small><strong>${escapeHtml(recent.subject || "Support request")}</strong><span>${escapeHtml((recent.body || "").slice(0, 84))}</span><em>${escapeHtml(nowAgo(recent.createdAt))}</em></button>`
          : `<button type="button" class="support-send-card" data-compose="general"><strong>Send us a message</strong><span>We usually reply in under 5 minutes</span></button>`
      }
      <div class="support-help-box">
        <label class="support-widget-search-wrap"><input id="supportSearchInput" placeholder="Search for help" value="${escapeHtml(state.search)}" /></label>
        <div class="support-help-quick-list">
          ${
            featured.length
              ? featured
                  .map(
                    (a) =>
                      `<button type="button" class="support-help-quick-item" data-support-article="${escapeHtml(a.key)}"><span>${escapeHtml(a.title)}</span><em>></em></button>`
                  )
                  .join("")
              : `<p class="muted">No help results found.</p>`
          }
        </div>
      </div>
    `;
  }

  function renderMessages() {
    const address = currentAddress();
    if (!address) {
      return `<div class="support-pane white"><h4>Messages</h4><p class="muted">Connect wallet to send support requests.</p><button id="supportConnectWalletBtn" class="support-widget-primary" type="button">Connect wallet</button></div>`;
    }
    const inboxBlock = state.isAdmin
      ? `
        <div class="support-admin-inbox">
          <div class="support-admin-head">
            <strong>Admin inbox</strong>
            <small>${state.inbox.length} message${state.inbox.length === 1 ? "" : "s"}</small>
          </div>
          <div class="support-message-thread-list">
            ${
              state.inbox.length
                ? state.inbox
                    .slice(0, 8)
                    .map(
                      (m) => `
                        <div class="support-message-thread">
                          <div>
                            <strong>${escapeHtml(m.subject || "Support request")}</strong>
                            <span>From ${escapeHtml(shortAddress(m.fromAddress || ""))}${m.tokenAddress ? ` · ${escapeHtml(shortAddress(m.tokenAddress))}` : ""}</span>
                          </div>
                          <em>${escapeHtml(nowAgo(m.createdAt))}</em>
                        </div>
                      `
                    )
                    .join("")
                : `<p class="muted">No incoming user messages yet.</p>`
            }
          </div>
        </div>
      `
      : "";
    return `
      <div class="support-pane white">
        <div class="support-pane-head"><h4>Messages</h4></div>
        ${inboxBlock}
        <div class="support-message-thread-list">
          ${
            state.messages.length
              ? state.messages.map((m) => `<div class="support-message-thread"><div><strong>${escapeHtml(m.subject || "Support request")}</strong><span>${escapeHtml((m.body || "").slice(0, 84))}</span></div><em>${escapeHtml(nowAgo(m.createdAt))}</em></div>`).join("")
              : `<p class="muted">No messages yet.</p>`
          }
        </div>
        <button class="support-send-btn" type="button" data-compose="general">Send us a message ></button>
      </div>
    `;
  }

  function filteredCollections() {
    const q = String(state.search || "").trim().toLowerCase();
    if (!q) return HELP_COLLECTIONS;
    return HELP_COLLECTIONS.filter((c) => `${c.title} ${c.description} ${(c.articles || []).map((a) => a.title).join(" ")}`.toLowerCase().includes(q));
  }

  function renderHelp() {
    return `
      <div class="support-pane white">
        <div class="support-pane-head"><h4>Help</h4></div>
        <label class="support-widget-search-wrap"><input id="supportHelpSearchInput" placeholder="Search for help" value="${escapeHtml(state.search)}" /></label>
        <div class="support-collection-list">
          ${filteredCollections().map((c) => `<button type="button" class="support-collection-item" data-support-collection="${escapeHtml(c.key)}"><div><strong>${escapeHtml(c.title)}</strong><span>${escapeHtml(c.description)}</span><small>${c.articles.length} articles</small></div><em>></em></button>`).join("")}
        </div>
      </div>
    `;
  }

  function renderCollection() {
    const c = HELP_COLLECTIONS.find((x) => x.key === state.collectionKey);
    if (!c) return renderHelp();
    return `
      <div class="support-pane white">
        <div class="support-back-row"><button type="button" class="support-back-btn" data-back="help"><</button><h4>Help</h4></div>
        <label class="support-widget-search-wrap"><input id="supportHelpSearchInput" placeholder="Search for help" value="${escapeHtml(state.search)}" /></label>
        <div class="support-collection-head"><strong>${escapeHtml(c.title)}</strong><span>${escapeHtml(c.description)}</span><small>By ${escapeHtml(c.author)}</small></div>
        <div class="support-article-list">${c.articles.map((a) => `<button type="button" class="support-article-row" data-support-article="${escapeHtml(a.key)}"><span>${escapeHtml(a.title)}</span><em>></em></button>`).join("")}</div>
      </div>
    `;
  }

  function renderArticle() {
    for (const c of HELP_COLLECTIONS) {
      const a = c.articles.find((row) => row.key === state.articleKey);
      if (a) {
        return `
          <div class="support-pane white">
            <div class="support-back-row"><button type="button" class="support-back-btn" data-back="collection"><</button><h4>${escapeHtml(a.title)}</h4></div>
            <p class="support-article-meta">${escapeHtml(c.title)} - By ${escapeHtml(c.author)}</p>
            <div class="support-article-content">${renderBlocks(a)}</div>
          </div>
        `;
      }
    }
    return renderHelp();
  }

  function renderCompose(category = "general") {
    const address = currentAddress();
    if (!address) {
      setAlert(alertEl, "Connect wallet first", true);
      return;
    }
    body.innerHTML = `
      <div class="support-pane support-compose-pane">
        <div class="support-back-row"><button type="button" class="support-back-btn" data-back="messages"><</button><h4>Support chat</h4></div>
        <div class="support-note-box">This chat is for Etherpump support. Please keep messages focused on support issues.</div>
        <form id="supportComposeForm" class="support-compose-form">
          <label>Subject<input id="supportSubject" maxlength="120" value="${escapeHtml(category === "general" ? "Support request" : category.replaceAll("-", " "))}" /></label>
          <label>Token address (optional)<input id="supportTokenAddress" placeholder="0x..." /></label>
          <label>Message<textarea id="supportBodyInput" maxlength="4000" placeholder="How may we assist you?"></textarea></label>
          <div class="support-compose-actions"><button class="btn-ghost" id="supportCancelComposeBtn" type="button">Cancel</button><button class="support-widget-primary" type="submit">Send message</button></div>
        </form>
      </div>
    `;
    body.querySelector("[data-back='messages']")?.addEventListener("click", () => setTab("messages"));
    body.querySelector("#supportCancelComposeBtn")?.addEventListener("click", () => setTab("messages"));
    body.querySelector("#supportComposeForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const subject = String(body.querySelector("#supportSubject")?.value || "").trim();
      const tokenAddress = String(body.querySelector("#supportTokenAddress")?.value || "").trim();
      const msg = String(body.querySelector("#supportBodyInput")?.value || "").trim();
      if (!msg) {
        setAlert(alertEl, "Message is required", true);
        return;
      }
      try {
        await api.sendSupportMessage({
          fromAddress: address,
          subject: subject || "Support request",
          body: msg,
          category,
          tokenAddress: normalizeAddress(tokenAddress) || ""
        });
        setAlert(alertEl, "Support message sent");
        await loadConfigAndMessages();
        setTab("messages");
      } catch (error) {
        setAlert(alertEl, String(error?.message || "Failed to send support message"), true);
      }
    });
  }

  async function rerenderSearchView(inputId, caretPos) {
    await render();
    const nextInput = body.querySelector(`#${inputId}`);
    if (!nextInput) return;
    nextInput.focus();
    const safePos = Number.isFinite(caretPos) ? Math.max(0, Math.min(caretPos, nextInput.value.length)) : nextInput.value.length;
    try {
      nextInput.setSelectionRange(safePos, safePos);
    } catch {
      // ignore selection errors on unsupported input types
    }
  }

  function bind() {
    body.querySelector("[data-open-messages='1']")?.addEventListener("click", () => setTab("messages"));
    body.querySelector("#supportConnectWalletBtn")?.addEventListener("click", () => document.getElementById("signInBtn")?.click());
    for (const btn of body.querySelectorAll("[data-compose]")) btn.addEventListener("click", () => renderCompose(String(btn.dataset.compose || "general")));
    for (const btn of body.querySelectorAll("[data-support-collection]")) {
      btn.addEventListener("click", () => {
        state.collectionKey = String(btn.dataset.supportCollection || "");
        state.view = "collection";
        render().catch(() => {});
      });
    }
    for (const btn of body.querySelectorAll("[data-support-article]")) {
      btn.addEventListener("click", () => {
        state.articleKey = String(btn.dataset.supportArticle || "");
        state.view = "article";
        render().catch(() => {});
      });
    }
    body.querySelector("[data-back='help']")?.addEventListener("click", () => {
      state.view = "tab";
      state.tab = "help";
      render().catch(() => {});
    });
    body.querySelector("[data-back='collection']")?.addEventListener("click", () => {
      state.view = "collection";
      render().catch(() => {});
    });
    body.querySelector("[data-back='messages']")?.addEventListener("click", () => setTab("messages"));

    for (const input of [body.querySelector("#supportSearchInput"), body.querySelector("#supportHelpSearchInput")].filter(Boolean)) {
      input.addEventListener("input", async () => {
        const inputId = input.id;
        const caretPos = input.selectionStart ?? String(input.value || "").length;
        state.search = String(input.value || "");
        if (state.tab === "help" || state.tab === "home") {
          try {
            await rerenderSearchView(inputId, caretPos);
          } catch {
            render().catch(() => {});
          }
        }
      });
    }
  }

  async function render() {
    await loadConfigAndMessages();
    if (state.tab === "home" && state.view === "tab") body.innerHTML = renderHome();
    else if (state.tab === "messages" && state.view === "tab") body.innerHTML = renderMessages();
    else if (state.tab === "help" && state.view === "tab") body.innerHTML = renderHelp();
    else if (state.view === "collection") body.innerHTML = renderCollection();
    else if (state.view === "article") body.innerHTML = renderArticle();
    else body.innerHTML = renderHome();
    bind();
  }

  sideLink.addEventListener("click", (event) => {
    event.preventDefault();
    state.open = true;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    render().catch(() => {});
  });

  closeBtn?.addEventListener("click", () => {
    state.open = false;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      state.open = false;
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
  });

  for (const btn of navBtns) {
    btn.addEventListener("click", () => setTab(String(btn.dataset.supportTab || "home")));
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.open) {
      state.open = false;
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
  });

  return {
    open: () => sideLink.click()
  };
}

