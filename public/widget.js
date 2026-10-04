/*! Jun Desk widget loader | MIT License
 * Usage: <script src="https://<your-desk>/widget.js" data-key="wk_..." async></script>
 * Shows a chat button; the chat itself (an iframe from the desk) loads on first open.
 * API: window.JunDesk.open() / .close() / .toggle()
 */
(function () {
  var script = document.currentScript;
  if (!script || window.JunDesk) return;
  var key = script.getAttribute("data-key");
  if (!key) return console.warn("[Jun Desk] Missing data-key on the widget script tag.");
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#2f5bea";

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

  function post(type) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: type }, origin);
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
    post(open ? "jun:open" : "jun:close");
  }

  button.addEventListener("click", function () { setOpen(!open); });

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || !frame || e.source !== frame.contentWindow) return;
    // The frame says when it's listening; tell it whether it's currently shown.
    if (e.data.type === "jun:ready") post(open ? "jun:open" : "jun:close");
    if (e.data.type === "jun:close") setOpen(false);
    if (e.data.type === "jun:unread") {
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

  (document.body || document.documentElement).appendChild(host);
})();
