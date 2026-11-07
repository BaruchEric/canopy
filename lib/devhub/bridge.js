// Loaded after the library's own scripts, inside Canopy's same-origin frame.
(function () {
  // The dashboard's writes (/library/open, /library/api/...) need the page's
  // caller token under enforce. It is the one Canopy's page keeps for this
  // origin, and it goes to this origin alone. The dashboard calls fetch when
  // a button is pressed, after this wrap is in place.
  const pageFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let token = null;
    try { token = localStorage.getItem('canopy.token.' + location.origin); } catch (e) { token = null; }
    let url = null;
    try { url = new URL(input instanceof Request ? input.url : String(input), location.href); } catch (e) { url = null; }
    // a URL that will not parse is fetch's to refuse, with no token on it
    if (!token || !url || url.origin !== location.origin) return pageFetch(input, init);
    const headers = new Headers(init && init.headers ? init.headers : input instanceof Request ? input.headers : undefined);
    headers.set('X-Canopy-Token', token);
    return pageFetch(input, Object.assign({}, init, {headers: headers}));
  };
  // theme.css's colors and fonts, each taken from the Canopy token it stands
  // for. A custom property reads back unresolved, light-dark() and all, so
  // the frame resolves it on its own scheme, which follows the page's theme.
  const TOKENS = {'--bg':'--bark0', '--panel':'--bark1', '--float':'--float', '--float-edge':'--float-edge', '--float-shadow':'--float-shadow', '--border':'--hair', '--text':'--ink', '--muted':'--ink-dim', '--faint':'--ink-faint', '--accent':'--moss', '--green':'--moss', '--amber':'--lichen', '--red':'--rust', '--words':'--sans', '--code':'--mono'};
  function shareTheme() {
    if (parent === window) return;
    const root = parent.document.documentElement;
    document.documentElement.dataset.theme = root.dataset.theme || 'system';
    const css = parent.getComputedStyle(root);
    for (const [mine, theirs] of Object.entries(TOKENS)) {
      const value = css.getPropertyValue(theirs).trim();
      if (value) document.documentElement.style.setProperty(mine, value);
    }
  }
  shareTheme();
  // The frame is a document of its own, so the fonts the page bundled mean
  // nothing here until it has their @font-face rules. Their urls are relative
  // to the page's stylesheet, so each is made absolute on the way over.
  function shareFonts() {
    if (parent === window) return;
    const faces = [];
    for (const sheet of parent.document.styleSheets) {
      let rules = [];
      try { rules = sheet.cssRules; } catch (e) { rules = []; }
      for (const rule of rules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const base = sheet.href || parent.location.href;
        faces.push(rule.cssText.replace(/url\("?([^")]+)"?\)/g, (all, url) => 'url("' + new URL(url, base).href + '")'));
      }
    }
    const style = document.createElement('style');
    style.textContent = faces.join('\n');
    document.head.append(style);
  }
  shareFonts();
  // The dashboard's summary and controls go in a rail beside its projects,
  // which theme.css lays out. The engine finds all of them by id, so moving
  // them changes nothing it does.
  const wrap = document.querySelector('.wrap');
  if (wrap) {
    const rail = document.createElement('aside');
    const shelf = document.createElement('main');
    rail.className = 'rail';
    shelf.className = 'shelf';
    for (const el of [...wrap.children]) (['content', 'strays'].includes(el.id) ? shelf : rail).append(el);
    wrap.append(rail, shelf);
  }
  // the stamp as a person reads it; the engine writes ISO
  const stamp = document.querySelector('header .sub');
  if (stamp && stamp.firstChild) stamp.firstChild.textContent = stamp.firstChild.textContent.replace(/\d{4}-\d\d-\d\dT[\d:+-]+/, iso => new Date(iso).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}));
  const restart = document.getElementById('gmRestart');
  if (restart) restart.remove();
  if (parent !== window) new MutationObserver(shareTheme).observe(parent.document.documentElement, {attributes:true, attributeFilter:['data-theme', 'data-palette', 'data-contrast']});
  document.addEventListener('click', function (event) {
    const link = event.target.closest('a[href="/library/ports"]');
    if (link && parent !== window) { event.preventDefault(); parent.postMessage({type:'canopy:ports'}, location.origin); return; }
    const button = event.target.closest('.canopy-git');
    if (button) parent.postMessage({type:'canopy:open-repo', path:button.dataset.path}, location.origin);
  });
  const project = new URLSearchParams(location.search).get('project');
  if (project && typeof DATA !== 'undefined' && typeof openDetail === 'function') {
    const projects = Object.values(DATA.categories).flatMap(category => category.projects || []);
    const match = projects.concat(DATA.strays || []).find(p => DATA.dev_root + '/' + p.path === project);
    if (match) openDetail(match);
  }
})();
