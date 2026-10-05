/*! Jun Desk widget loader | MIT License
 * Usage: <script src="https://<your-desk>/widget.js" data-key="wk_..." async></script>
 * Put it in <head> so it can see errors from the start of the page.
 * Shows a chat button; the chat itself (an iframe from the desk) loads on first open.
 * Captures recent JS errors, failed requests and page navigation in memory only, masked,
 * and shares them with support only when the visitor sends a message. data-capture="off"
 * disables capture. Shows the visitor on the desk's live visitor list (data-consent="required"
 * waits for JunDesk.consent(true) and stores nothing before it).
 * API: window.JunDesk.open() / .close() / .toggle() / .identify(jwt) / .logout() / .consent(bool)
 * identify() takes a JWT your backend signs with the desk's identity secret (data-user-token works too).
 */
(function () {
  var script = document.currentScript;
  if (!script || window.JunDesk) return;
  var key = script.getAttribute("data-key");
  if (!key) return console.warn("[Jun Desk] Missing data-key on the widget script tag.");
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color"); // overrides the desk's branding colour

  // ---------- debug capture (P1). Same masking rules as shared/debug.ts. ----------
  var events = [];
  var capture = script.getAttribute("data-capture") !== "off";
  var nativeFetch = window.fetch;

  function redact(s, max) {
    max = max || 500;
    return String(s == null ? "" : s).slice(0, max * 2)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
      .replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1[token]")
      .replace(/\b(sk|pk|rk)_(live|test)_[\w]+/gi, "[key]")
      .replace(/((?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth\w*|session\w*|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, "$1[redacted]")
      .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]")
      .slice(0, max);
  }
  function cleanUrl(u) {
    try {
      var x = new URL(String(u), location.href), q = [];
      x.searchParams.forEach(function (_, k) { if (q.indexOf(k) < 0 && q.length < 10) q.push(k); });
      var path = redact(x.pathname, 300) + (q.length ? "?" + q.map(function (k) { return redact(k, 40) + "=…"; }).join("&") : "");
      return x.origin === location.origin ? path : x.origin + path;
    } catch (e) { return redact(String(u).split(/[?#]/)[0], 300); }
  }
  function push(e) {
    e.t = Date.now();
    events.push(e);
    if (events.length > 40) events.shift();
    maybeNudge(e);
  }
  // Our own traffic (the chat iframe, uploads) isn't the customer's problem.
  function ours(u) { try { var x = new URL(String(u), location.href); return x.origin === origin && /^\/(api\/(widget|files)|widget)/.test(x.pathname); } catch (e) { return false; } }
  function stackOf(err) { return redact(err && err.stack || "", 800).split("\n").slice(0, 5).join("\n") || undefined; }

  if (capture) {
    try {
      window.addEventListener("error", function (e) {
        var el = e.target;
        if (el && el !== window && (el.src || el.href)) {
          if (!ours(el.src || el.href)) push({ kind: "network", method: "GET", url: cleanUrl(el.src || el.href), status: 0, message: "failed to load " + String(el.tagName || "").toLowerCase() });
        } else {
          push({ kind: "error", message: redact(e.message || (e.error && e.error.message)), source: e.filename ? cleanUrl(e.filename) + ":" + e.lineno : undefined, stack: stackOf(e.error) });
        }
      }, true);
      window.addEventListener("unhandledrejection", function (e) {
        var r = e.reason;
        push({ kind: "error", message: "Unhandled promise rejection: " + redact(r && r.message || r), stack: stackOf(r) });
      });

      if (nativeFetch) {
        window.fetch = function (input, init) {
          var url = typeof input === "string" ? input : input && input.url || String(input);
          var method = String(init && init.method || input && input.method || "GET").toUpperCase();
          var started = Date.now();
          var p = nativeFetch.apply(this, arguments);
          if (ours(url)) return p;
          return p.then(function (res) {
            if (res.status >= 400) push({ kind: "network", method: method, url: cleanUrl(url), status: res.status, durationMs: Date.now() - started });
            return res;
          }, function (err) {
            push({ kind: "network", method: method, url: cleanUrl(url), status: 0, message: redact(err && err.message), durationMs: Date.now() - started });
            throw err;
          });
        };
      }

      var xhr = XMLHttpRequest.prototype, open = xhr.open, send = xhr.send;
      xhr.open = function (method, url) { this.__jun = { method: String(method).toUpperCase(), url: url }; return open.apply(this, arguments); };
      xhr.send = function () {
        var info = this.__jun, x = this, started = Date.now();
        if (info && !ours(info.url)) {
          x.addEventListener("loadend", function () {
            if (x.status >= 400 || x.status === 0) push({ kind: "network", method: info.method, url: cleanUrl(info.url), status: x.status, durationMs: Date.now() - started });
          });
        }
        return send.apply(this, arguments);
      };

    } catch (e) { /* never break the host page */ }
  }

  // Page changes feed both the debug trail and the live visitor list.
  function nav() {
    if (capture) push({ kind: "navigation", url: cleanUrl(location.href) });
    sendPage();
  }
  try {
    ["pushState", "replaceState"].forEach(function (name) {
      var orig = history[name];
      history[name] = function () { var r = orig.apply(this, arguments); nav(); return r; };
    });
    window.addEventListener("popstate", nav);
  } catch (e) {}

  // ---------- live visitor (V-01), identity (V-03), consent (V-06) ----------
  // data-consent="required": store nothing and stay off the visitor list until JunDesk.consent(true).
  var consented = script.getAttribute("data-consent") !== "required";
  var userToken = script.getAttribute("data-user-token") || null;
  var sid, started, live, liveTries = 0;
  function store(k, v) { try { if (!consented) return null; if (v != null) sessionStorage.setItem(k, v); return sessionStorage.getItem(k); } catch (e) { return null; } }
  function rid() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function liveSend(m) { if (live && live.readyState === 1) live.send(JSON.stringify(m)); }
  function sendPage() {
    var tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    liveSend({ t: "page", url: location.origin + cleanUrl(location.href), title: redact(document.title, 120), ref: document.referrer ? cleanUrl(document.referrer) : "", start: started, lang: navigator.language, tz: tz });
  }
  function connect() {
    if (!consented || live || !window.WebSocket) return;
    sid = sid || store("jun:s") || store("jun:s", rid()) || rid();
    started = started || Number(store("jun:t") || store("jun:t", String(Date.now()))) || Date.now();
    var ws = live = new WebSocket(origin.replace(/^http/, "ws") + "/api/widget/" + encodeURIComponent(key) + "/live?s=" + sid);
    ws.onopen = function () { liveTries = 0; if (userToken) liveSend({ t: "id", token: userToken }); sendPage(); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === "invite" && !open) showInvite(m);
    };
    // Reconnect with backoff, unless this socket was replaced or dropped on purpose.
    ws.onclose = function () { if (live !== ws) return; live = null; if (liveTries < 8) setTimeout(connect, 1000 * Math.pow(2, liveTries++)); };
  }
  function disconnect() { var ws = live; live = null; if (ws) ws.close(); }
  setInterval(function () { if (live && live.readyState === 1) live.send("ping"); }, 30000);

  function snapshot() {
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    return {
      page: { url: location.origin + cleanUrl(location.href), title: redact(document.title, 200) },
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      language: navigator.language,
      timezone: tz,
      capturedAt: Date.now(),
      events: capture ? events.slice() : [],
    };
  }

  // ---------- proactive help (P-01): offer a chat when something really breaks ----------
  var nudged = false, nudgeTimer, nudgeEvent;
  function worthNudging(e) {
    if (e.kind === "error") return true;
    // Failed API calls, not noisy asset loads or 404s on GETs.
    return e.kind === "network" && !/^failed to load/.test(e.message || "") &&
      (e.status === 0 || e.status >= 500 || (e.status >= 400 && e.method !== "GET"));
  }
  function maybeNudge(e) {
    if (nudged || open || !worthNudging(e)) return;
    nudgeEvent = e;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(showNudge, 1200); // errors come in bursts; wait for things to settle
  }
  function showCard(text, from) {
    var card = root.querySelector(".nudge");
    card.querySelector(".nudge-text").textContent = text;
    card.querySelector(".nudge-from").textContent = from || "";
    card.style.display = "block";
  }
  // The desk words it from what failed (S-11). Plain-text POST: no CORS preflight.
  function showNudge() {
    if (nudged || open) return;
    (nativeFetch || fetch)(origin + "/api/widget/" + encodeURIComponent(key) + "/nudge", {
      method: "POST",
      body: JSON.stringify({ event: nudgeEvent, page: { url: location.origin + cleanUrl(location.href), title: redact(document.title, 200) } }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.show || !res.text || nudged || open) return;
      nudged = true;
      cardOpener = { text: res.text };
      showCard(res.text);
    }).catch(function () {});
  }
  // V-07: a teammate started a chat from the desk's visitor list.
  var cardOpener = null;
  function showInvite(m) {
    nudged = true;
    cardOpener = { text: String(m.body).slice(0, 1000), inviteId: m.id, from: m.from };
    showCard(cardOpener.text, m.from);
  }
  function hideNudge() { var card = root.querySelector(".nudge"); if (card) card.style.display = "none"; }

  // ---------- launcher ----------
  var host = document.createElement("div");
  host.setAttribute("data-jun-desk", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    "<style>" +
    ":host{all:initial}.w{--c:#2f5bea;--t:#fff;visibility:hidden}.w.on{visibility:visible}" +
    ".l .btn,.l .frame,.l .nudge{right:auto;left:20px}" +
    ".btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;" +
    "background:var(--c);color:var(--t);box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:2147483000;display:grid;place-items:center;transition:transform .15s}" +
    ".btn:hover{transform:scale(1.05)}.btn svg{width:26px;height:26px}" +
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e5484d;" +
    "color:#fff;font:600 11px/18px system-ui,sans-serif;display:none}" +
    ".frame{position:fixed;right:20px;bottom:88px;width:380px;height:min(640px,calc(100vh - 120px));border:0;border-radius:16px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483000;background:#fff;display:none}" +
    "@media (max-width:480px){.frame,.l .frame{right:0;left:0;bottom:0;width:100vw;height:100vh;border-radius:0}}" +
    ".nudge{position:fixed;right:20px;bottom:88px;max-width:280px;padding:14px 16px;border-radius:14px;background:#fff;color:#1c1c1a;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.18);z-index:2147483000;font:14px/1.45 system-ui,sans-serif;display:none}" +
    ".nudge p{margin:0 18px 10px 0}.nudge-from{font-size:12px;color:#6b6b66;margin-bottom:4px}.nudge .go{border:0;border-radius:8px;padding:7px 12px;background:var(--c);color:var(--t);font:600 13px system-ui,sans-serif;cursor:pointer}" +
    ".nudge .x{position:absolute;top:6px;right:8px;border:0;background:none;font-size:18px;line-height:1;color:#6b6b66;cursor:pointer}" +
    "</style><div class=\"w\">" +
    '<div class="nudge" role="dialog" aria-label="Need help?"><button class="x" aria-label="Dismiss">×</button>' +
    '<div class="nudge-from"></div><p class="nudge-text"></p><button class="go">Chat with us</button></div>' +
    '<button class="btn" aria-label="Open chat" aria-expanded="false">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="badge"></span></button></div>';

  var wrap = root.querySelector(".w");
  var button = root.querySelector(".btn");
  // W-04: colour and side from the desk's settings, so changing them needs no new snippet.
  // Hidden until then (at most 1.5 s) so the button doesn't flash in the default colour.
  function brand(cfg) {
    var c = color || (cfg && cfg.color);
    if (c && /^#[0-9a-f]{6}$/i.test(c)) {
      var n = parseInt(c.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
      wrap.style.setProperty("--c", c);
      wrap.style.setProperty("--t", lum > 0.65 ? "#1c1c1a" : "#fff");
    }
    if (cfg && cfg.position === "left") wrap.classList.add("l");
    wrap.classList.add("on");
  }
  setTimeout(brand, 1500);
  (nativeFetch || fetch)(origin + "/api/widget/" + encodeURIComponent(key) + "/config").then(function (r) { return r.json(); }).then(brand, function () { brand(); });
  var badge = root.querySelector(".badge");
  var frame = null;
  var open = false;

  function post(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, origin);
  }

  var pendingOpener = null;
  function setOpen(next) {
    open = next;
    if (open) hideNudge();
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.className = "frame";
      frame.title = "Chat";
      frame.allow = "clipboard-write";
      frame.src = origin + "/widget?key=" + encodeURIComponent(key) + (consented ? "" : "&persist=0");
      wrap.appendChild(frame);
    }
    if (frame) frame.style.display = open ? "block" : "none";
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    post({ type: open ? "jun:open" : "jun:close" });
    if (open && pendingOpener && frame && frame.contentWindow) post({ type: "jun:proactive", opener: pendingOpener, sessionId: sid });
  }

  button.addEventListener("click", function () { setOpen(!open); });
  root.querySelector(".nudge .x").addEventListener("click", hideNudge);
  root.querySelector(".nudge .go").addEventListener("click", function () {
    pendingOpener = cardOpener;
    setOpen(true);
  });

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || !frame || e.source !== frame.contentWindow) return;
    var type = e.data.type;
    // The frame says when it's listening; tell it whether it's currently shown.
    if (type === "jun:ready") {
      post({ type: "jun:session", sessionId: sid || null, userToken: userToken, persist: consented });
      post({ type: open ? "jun:open" : "jun:close" });
      if (pendingOpener) post({ type: "jun:proactive", opener: pendingOpener, sessionId: sid });
    }
    if (type === "jun:proactive-shown") pendingOpener = null;
    if (type === "jun:close") setOpen(false);
    if (type === "jun:context-request") post({ type: "jun:context", id: e.data.id, context: snapshot() });
    if (type === "jun:unread") {
      var n = Number(e.data.count) || 0;
      badge.textContent = n > 9 ? "9+" : String(n);
      badge.style.display = n > 0 && !open ? "block" : "none";
    }
  });

  window.JunDesk = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!open); },
    // Signed-in user: a JWT from your backend. The chat and the visitor list then know who it is.
    identify: function (token) {
      userToken = token || null;
      if (userToken) liveSend({ t: "id", token: userToken });
      post({ type: "jun:identify", userToken: userToken });
    },
    // On sign-out: forget this browser's chat identity so the next person starts fresh.
    logout: function () {
      userToken = null;
      post({ type: "jun:identify", userToken: null });
      disconnect();
      sid = null; started = null;
      store("jun:s", rid()); store("jun:t", String(Date.now()));
      connect();
    },
    consent: function (yes) {
      consented = Boolean(yes);
      post({ type: "jun:consent", persist: consented });
      if (consented) connect();
      else disconnect();
    },
  };
  connect();

  // Loaded from <head> (recommended, for early error capture) there's no body yet.
  if (document.body) document.body.appendChild(host);
  else document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(host); });
})();
