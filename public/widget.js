/*! Jun Desk widget loader | MIT License
 * Usage: <script src="https://<your-desk>/widget.js" data-key="wk_..." async></script>
 * Put it in <head> so it can see errors from the start of the page.
 * Shows a chat button; the chat itself (an iframe from the desk) loads on first open.
 * Captures recent JS errors, failed requests and page navigation in memory only, masked,
 * and shares them with support only when the visitor sends a message. data-capture="off"
 * disables capture. API: window.JunDesk.open() / .close() / .toggle()
 */
(function () {
  var script = document.currentScript;
  if (!script || window.JunDesk) return;
  var key = script.getAttribute("data-key");
  if (!key) return console.warn("[Jun Desk] Missing data-key on the widget script tag.");
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#2f5bea";

  // ---------- debug capture (P1). Same masking rules as shared/debug.ts. ----------
  var events = [];
  var capture = script.getAttribute("data-capture") !== "off";

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

      var nativeFetch = window.fetch;
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

      var nav = function () { push({ kind: "navigation", url: cleanUrl(location.href) }); };
      ["pushState", "replaceState"].forEach(function (name) {
        var orig = history[name];
        history[name] = function () { var r = orig.apply(this, arguments); nav(); return r; };
      });
      window.addEventListener("popstate", nav);
      nav();
    } catch (e) { /* never break the host page */ }
  }

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

  // ---------- launcher ----------
  var host = document.createElement("div");
  host.setAttribute("data-jun-desk", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    ".btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;" +
    "background:" + color + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:2147483000;display:grid;place-items:center;transition:transform .15s}" +
    ".btn:hover{transform:scale(1.05)}.btn svg{width:26px;height:26px}" +
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e5484d;" +
    "color:#fff;font:600 11px/18px system-ui,sans-serif;display:none}" +
    ".frame{position:fixed;right:20px;bottom:88px;width:380px;height:min(640px,calc(100vh - 120px));border:0;border-radius:16px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483000;background:#fff;display:none}" +
    "@media (max-width:480px){.frame{right:0;bottom:0;width:100vw;height:100vh;border-radius:0}}" +
    "</style>" +
    '<button class="btn" aria-label="Open chat" aria-expanded="false">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="badge"></span></button>';

  var button = root.querySelector(".btn");
  var badge = root.querySelector(".badge");
  var frame = null;
  var open = false;

  function post(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, origin);
  }

  function setOpen(next) {
    open = next;
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.className = "frame";
      frame.title = "Chat";
      frame.allow = "clipboard-write";
      frame.src = origin + "/widget?key=" + encodeURIComponent(key);
      root.appendChild(frame);
    }
    if (frame) frame.style.display = open ? "block" : "none";
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    post({ type: open ? "jun:open" : "jun:close" });
  }

  button.addEventListener("click", function () { setOpen(!open); });

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || !frame || e.source !== frame.contentWindow) return;
    var type = e.data.type;
    // The frame says when it's listening; tell it whether it's currently shown.
    if (type === "jun:ready") post({ type: open ? "jun:open" : "jun:close" });
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
  };

  // Loaded from <head> (recommended, for early error capture) there's no body yet.
  if (document.body) document.body.appendChild(host);
  else document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(host); });
})();
