// Loaded after the library's own scripts, inside Canopy's same-origin frame.
(function () {
  function shareTheme() {
    if (parent === window) return;
    const root = parent.document.documentElement;
    document.documentElement.dataset.theme = root.dataset.theme || 'system';
  }
  shareTheme();
  const restart = document.getElementById('gmRestart');
  if (restart) restart.remove();
  if (parent !== window) new MutationObserver(shareTheme).observe(parent.document.documentElement, {attributes:true, attributeFilter:['data-theme']});
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
