// Only diagnostic categories leave the browser; never return page text, URLs, cookies or account data.
export function httpReachability(status, challenge = false) {
  if (!status) return "network_error";
  if (challenge) return "challenge";
  if (status === 401) return "authentication_required";
  if (status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  return status >= 400 ? "http_error" : "reachable";
}

export function networkFailure(code = "") {
  if (/CERT|TLS|SSL/i.test(code)) return "certificate";
  if (/ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/i.test(code)) return "dns";
  if (/TIMEOUT|TIMED.?OUT|ABORT/i.test(code)) return "timeout";
  if (/PROXY|TUNNEL/i.test(code)) return "proxy";
  return "connection";
}

export function recordNavigation(instance, event) {
  const registration = instance.sessions.get(event.sessionId);
  if (!registration || registration.type !== "page") return;
  const p = event.params;
  if (event.method === "Network.requestWillBeSent" && p.type === "Document" && p.frameId === registration.frameId) {
    registration.navigation = { requestId: p.requestId, loaderId: p.loaderId, forClaude: /^https:\/\/claude\.ai(?:\/|$)/.test(p.request.url), status: null, challenge: false };
  }
  if (event.method === "Network.responseReceived" && p.type === "Document" && p.frameId === registration.frameId && registration.navigation?.loaderId === p.loaderId) {
    registration.navigation.status = p.response.status;
    registration.navigation.challenge = Object.entries(p.response.headers).some(([name, value]) => name.toLowerCase() === "cf-mitigated" && String(value).toLowerCase() === "challenge");
  }
  if (event.method === "Network.loadingFailed" && p.requestId === registration.navigation?.requestId && !p.canceled) {
    registration.navigation.error = networkFailure(p.errorText);
  }
}

export function inspectClaudePage() {
  if (location.origin !== "https://claude.ai") return { state: "unavailable" };
  const visible = (selector) => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length > 0);
  if (/just a moment|checking your browser|verify you are human/i.test(document.title) || visible("#challenge-running, #challenge-stage, .cf-turnstile, iframe[src*='challenges.cloudflare.com']")) return { state: "challenge" };
  if (document.readyState !== "complete") return { state: "loading" };
  if (visible("[data-testid='user-menu-button'], [data-testid='account-menu-button']") && visible("[contenteditable='true'][role='textbox'], [data-testid='chat-input']")) return { state: "app_ready" };
  if (/^\/(login|signup)(\/|$)/.test(location.pathname) && visible("input[type='email'], input[type='password'], form")) return { state: "login_page" };
  return { state: "page_loaded" };
}

export function browserPageState(page, navigation) {
  if (navigation?.error) return "network_error";
  if (page?.state === "unavailable") return "unavailable";
  if (page?.state === "challenge" || navigation?.challenge) return "challenge";
  if (navigation?.status >= 400) return httpReachability(navigation.status);
  // A DOM snapshot alone cannot establish that this document completed a successful navigation.
  if (!navigation?.status || navigation.status < 200 || navigation.status >= 300) return "loading";
  return page?.state ?? "unavailable";
}
