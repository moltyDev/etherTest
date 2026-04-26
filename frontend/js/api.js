import { getPreferredChainId } from "./core.js";

function withPreferredChain(path) {
  const chainId = getPreferredChainId();
  if (!chainId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}chainId=${chainId}`;
}

export async function apiGet(path) {
  const target = withPreferredChain(path);
  const res = await fetch(target, { cache: "no-store" });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.json();
}

export async function apiPost(path, body) {
  const target = withPreferredChain(path);
  const res = await fetch(target, {
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
      // ignore
    }
    throw new Error(message);
  }

  return res.json();
}

export const api = {
  health: () => apiGet("/api/health"),
  config: () => apiGet("/api/config"),
  stats: () => apiGet("/api/stats"),
  launches: (limit = 20, offset = 0) => apiGet(`/api/launches?limit=${limit}&offset=${offset}`),
  token: (tokenAddress, options = {}) => {
    const params = new URLSearchParams();
    if (options.fresh) params.set("fresh", "1");
    if (options.lite) params.set("lite", "1");
    const qs = params.toString();
    return apiGet(`/api/token/${tokenAddress}${qs ? `?${qs}` : ""}`);
  },
  profile: (address, options = {}) => {
    const params = new URLSearchParams();
    if (options.includeSocial) params.set("includeSocial", "1");
    const qs = params.toString();
    return apiGet(`/api/profile/${address}${qs ? `?${qs}` : ""}`);
  },
  userProfile: (address) => apiGet(`/api/user-profile/${address}`),
  userProfiles: (addresses = []) => apiPost("/api/user-profiles", { addresses }),
  saveUserProfile: (address, body = {}) => apiPost(`/api/user-profile/${address}`, body),
  followState: (viewer, target) =>
    apiGet(`/api/follow/state?viewer=${encodeURIComponent(String(viewer || ""))}&target=${encodeURIComponent(String(target || ""))}`),
  setFollow: (viewer, target, follow) =>
    apiPost("/api/follow", {
      viewer,
      target,
      follow: Boolean(follow)
    }),
  uploadImage: (dataUrl) => apiPost("/api/upload-image", { dataUrl })
};
