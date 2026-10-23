/**
 * The preview's element picker, the script the proxy puts in each framed
 * page (`PICK_PATH`). It does nothing until canopy's panel, the frame's
 * parent, turns it on, so a page opened in a tab of its own or framed by
 * anyone else gets no picker. While on, it outlines what the pointer is
 * over and answers a click with what it can say about that element, to the
 * origin that turned it on and nowhere else.
 *
 * Messages, all `{canopy: ...}` objects:
 * - parent to page: `{canopy:"pick", on:true|false}`
 * - page to parent: `{canopy:"pick-ready"}` for each enable,
 *   `{canopy:"picked", selector, html, text, path, styles, rect}` on a click,
 *   `{canopy:"pick-off"}` when Esc in the page stops it.
 *
 * Plain ES2017 in a string, since it runs in whatever page the dev server
 * serves: no backticks or template holes inside it.
 */

/** where each preview slot serves the picker, ahead of the dev server */
export const PICK_PATH = "/__canopy/pick.js";

/** the tag the proxy appends to a framed page's head */
export const PICK_TAG = `<script src="${PICK_PATH}"></script>`;

/** how much of an element the page sends: the parent truncates again */
export const PICK_HTML_MAX = 2000;
export const PICK_TEXT_MAX = 300;

export const PICK_SCRIPT = `(function () {
  "use strict";
  if (window.parent === window || window.__canopyPick) return;
  window.__canopyPick = true;
  var on = false;
  var origin = null;
  var box = null;
  var hovered = null;
  var STYLES = ["display", "position", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "padding", "margin", "border", "border-radius", "gap"];
  var BLOCK = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick"];

  function post(msg) {
    if (origin === null) return;
    try { window.parent.postMessage(msg, origin); } catch (e) {}
  }
  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\\\" + c; });
  }
  function part(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id) return tag + "#" + esc(el.id);
    var s = tag;
    var cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    for (var i = 0; i < cls.length; i++) s += "." + esc(cls[i]);
    var parent = el.parentElement;
    if (parent) {
      var same = 0, nth = 0;
      for (var k = 0; k < parent.children.length; k++) {
        var c = parent.children[k];
        if (c.tagName === el.tagName) { same++; if (c === el) nth = same; }
      }
      if (same > 1) s += ":nth-of-type(" + nth + ")";
    }
    return s;
  }
  function selectorOf(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      parts.unshift(part(n));
      if (n.id || n === document.body || n === document.documentElement) break;
    }
    return parts.join(" > ");
  }
  function draw(el) {
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("data-canopy-pick", "");
      box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);border-radius:2px;transition:all 60ms linear;";
      (document.body || document.documentElement).appendChild(box);
    }
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    box.style.display = "block";
  }
  function target(e) {
    var el = e.target;
    return el && el.nodeType === 1 && el !== box ? el : null;
  }
  function move(e) {
    var el = target(e);
    if (!el) return;
    hovered = el;
    draw(el);
  }
  function redraw() {
    if (hovered && hovered.isConnected) draw(hovered);
  }
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  function click(e) {
    var el = target(e);
    swallow(e);
    if (!el) return;
    var cs = window.getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLES.length; i++) styles[STYLES[i]] = cs.getPropertyValue(STYLES[i]);
    var r = el.getBoundingClientRect();
    post({
      canopy: "picked",
      selector: selectorOf(el),
      html: String(el.outerHTML || "").slice(0, ${PICK_HTML_MAX}),
      text: String(el.innerText || el.textContent || "").trim().slice(0, ${PICK_TEXT_MAX}),
      path: location.pathname + location.search,
      styles: styles,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    });
    stop();
  }
  function key(e) {
    if (e.key !== "Escape") return;
    swallow(e);
    stop();
    post({ canopy: "pick-off" });
  }
  function start() {
    if (on) return;
    on = true;
    window.addEventListener("mousemove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", redraw, true);
    for (var i = 0; i < BLOCK.length; i++) window.addEventListener(BLOCK[i], swallow, true);
  }
  function stop() {
    if (!on) return;
    on = false;
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("scroll", redraw, true);
    for (var i = 0; i < BLOCK.length; i++) window.removeEventListener(BLOCK[i], swallow, true);
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
    hovered = null;
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== "object" || d.canopy !== "pick") return;
    if (d.on === true) {
      origin = e.origin;
      start();
      post({ canopy: "pick-ready" });
    } else if (d.on === false) {
      stop();
    }
  });
})();
`;
