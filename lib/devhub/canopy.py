#!/usr/bin/env python3
"""Canopy's workspace-library adapter. The imported engine stays stdlib-only."""
import argparse
import contextlib
import fcntl
import hmac
import http.server
import json
import os
from pathlib import Path
import shutil
import sys
import threading

import engine as hub

ASSETS = Path(__file__).resolve().parent
_LOCK = threading.RLock()
_LOCAL = threading.local()


def configure(root, state):
    root, state = Path(root).resolve(), Path(state).resolve()
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    hub.HERE, hub.DEV_ROOT = state, root
    for attr, filename in {
        'CONFIG_PATH': 'categories.json', 'MANIFEST_PATH': 'manifest.json',
        'INDEX_PATH': 'index.html', 'REFS_PATH': 'references.json',
        'TAGS_PATH': 'tags.json', 'RELATIONS_PATH': 'relations.json',
        'HEALTH_PATH': 'health.json', 'RUNNING_PATH': 'running.json',
        'TMP_DIR': '.import_tmp',
    }.items():
        setattr(hub, attr, state / filename)
    hub.REFS_DIR = root / 'references'
    with locked():
        if not hub.CONFIG_PATH.exists():
            source = root / '_devhub'
            existing = source / 'categories.json'
            cfg = json.loads((existing if existing.is_file() else ASSETS / 'categories.default.json').read_text())
            # Only durable metadata is migrated, never generated HTML or live PIDs.
            for name in ('references.json', 'tags.json', 'relations.json', 'health.json'):
                if (source / name).is_file():
                    shutil.copyfile(source / name, state / name)
            cfg['host_root'] = str(root)
            cfg['trusted_origins'] = []
            cfg['helper_port'] = 7333
            cfg.setdefault('ignore', []).append('_devhub')
            # A flat repo collection works too: show root repos without moving them.
            cfg.setdefault('categories', {}).setdefault('projects', {
                'label': 'Projects', 'keywords': [], 'blurb': 'Projects in the workspace root.'})
            for child in root.iterdir():
                if child.is_dir() and not child.name.startswith('.') and (child / '.git').exists():
                    cfg.setdefault('overrides', {}).setdefault(child.name, 'projects')
            hub.save_config(cfg)
            (state / 'migration.json').write_text(json.dumps({
                'root': str(root), 'source': str(source) if existing.is_file() else None,
            }, indent=2) + '\n')
    return root, state


@contextlib.contextmanager
def locked():
    """Serialize CLI, HTTP mutations, and background scans across processes."""
    with _LOCK:
        if getattr(_LOCAL, 'depth', 0):
            yield
            return
        with (hub.HERE / '.lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            _LOCAL.depth = 1
            try:
                yield
            finally:
                _LOCAL.depth = 0
                fcntl.flock(handle, fcntl.LOCK_UN)


def adapt_templates():
    for attr in ('DASHBOARD_TEMPLATE', 'PORTS_TEMPLATE', '_DASHBOARD_DEV_JS'):
        text = getattr(hub, attr)
        text = text.replace('http://127.0.0.1:${DATA.helper_port}', '/library')
        text = text.replace('http://127.0.0.1:__HELPER_PORT__', '/library')
        text = text.replace('dev<b>hub</b>', 'canopy')
        text = text.replace('devhub — ~/Arik/dev', 'Canopy · Library')
        text = text.replace('devhub · Ports', 'Canopy · Ports')
        text = text.replace('· ~/Arik/dev', '· Library')
        text = text.replace('python3 _devhub/devhub.py index', 'canopy library index')
        text = text.replace('static snapshot · regenerate with', 'workspace snapshot · refresh above or use')
        text = text.replace('href="/"', 'href="/library/"')
        # A port row carries a name; the helper requires an absolute project path.
        text = text.replace('path=${encodeURIComponent(name)}',
                            'path=${encodeURIComponent(start.dataset.path)}')
        text = text.replace('class="btn act-start" data-name="${esc(r.project)}"',
                            'class="btn act-start" data-path="${esc(r.path)}" data-name="${esc(r.project)}"')
        setattr(hub, attr, text)
    hub.DASHBOARD_TEMPLATE = hub.DASHBOARD_TEMPLATE.replace(
        "const open = [];", "const open = [];\n"
        "  if(p.git) open.push(`<button class=\"btn canopy-git\" data-path=\"${esc(abs)}\">Git cockpit →</button>`);")
    # The existing dashboard keeps its mature editing workflows; these hooks
    # connect repo detail and the shared theme to the React cockpit.
    hooks = (ASSETS / 'bridge.js').read_text()
    style = (ASSETS / 'theme.css').read_text()
    for attr in ('DASHBOARD_TEMPLATE', 'PORTS_TEMPLATE'):
        setattr(hub, attr, getattr(hub, attr) + '\n<style>' + style + '</style>\n<script>' + hooks + '</script>')


def serve():
    token = os.environ.get('CANOPY_LIBRARY_TOKEN', '')
    if not token:
        raise ValueError('The library service must be started by Canopy.')
    parent_pid = os.getppid()
    def watch_parent():
        while os.getppid() == parent_pid:
            threading.Event().wait(2)
        os._exit(0)
    threading.Thread(target=watch_parent, daemon=True).start()
    adapt_templates()
    original_regen = hub.regenerate_dashboard

    def regenerate():
        with locked():
            return original_regen()

    hub.regenerate_dashboard = regenerate
    regenerate()
    original_server = http.server.ThreadingHTTPServer

    class Server(original_server):
        daemon_threads = True

        def __init__(self, address, handler):
            class Handler(handler):
                def parse_request(self):
                    if not super().parse_request():
                        return False
                    if not hmac.compare_digest(self.headers.get('X-Canopy-Library', ''), token):
                        self.send_error(403, 'Canopy authentication required')
                        return False
                    return True

                def do_GET(self):
                    with locked():
                        if self.path.split('?')[0] == '/manifest':
                            self._send(200, json.loads(hub.MANIFEST_PATH.read_text()))
                        else:
                            super().do_GET()

                def do_POST(self):
                    with locked():
                        if self.path == '/refresh':
                            self._send(200, regenerate())
                        elif self.path == '/api/helper/restart':
                            self._send(400, {'error': 'Restart Canopy to restart the library.'})
                        else:
                            super().do_POST()

            super().__init__(('127.0.0.1', 0), Handler)
            worker_path = hub.HERE / '.worker.json'
            fd = os.open(str(worker_path) + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as worker:
                json.dump({'port': self.server_port, 'token': token, 'pid': os.getpid()}, worker)
            os.replace(str(worker_path) + '.tmp', worker_path)
            print(f'CANOPY_LIBRARY_READY {self.server_port}', flush=True)

    http.server.ThreadingHTTPServer = Server
    hub.cmd_serve(argparse.Namespace(port=0))


SYNC_FILES = ('categories.json', 'references.json', 'tags.json', 'relations.json', 'health.json')
SYNC_BACKUPS = 10


def sync_write():
    """Write what a Library sync merged (src/server/libsync.ts), under the
    engine's lock. stdin: {expect: {name: sha256 or null}, files: {name: text}}.
    Refuses with exit 3 when a file no longer hashes to what the merge read,
    so an edit landing mid-merge is never overwritten. Each file it replaces
    is first copied into sync-backups/<stamp>/ (the newest 10 kept), and each
    write goes through a temp file and a rename. sync.json goes last."""
    import datetime
    import hashlib
    req = json.load(sys.stdin)
    expect, files = req.get('expect', {}), req.get('files', {})
    allowed = set(SYNC_FILES) | {'sync.json'}
    if not set(expect) <= set(SYNC_FILES) or not set(files) <= allowed:
        raise ValueError('sync-write names a file it may not write')
    with locked():
        for name, want in expect.items():
            path = hub.HERE / name
            have = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            if have != want:
                print(f'{name} changed since the merge read it', file=sys.stderr)
                sys.exit(3)
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        backups = hub.HERE / 'sync-backups'
        replaced = [n for n in files if n in SYNC_FILES and (hub.HERE / n).is_file()]
        if replaced:
            (backups / stamp).mkdir(parents=True, exist_ok=True)
            for name in replaced:
                shutil.copyfile(hub.HERE / name, backups / stamp / name)
            for old in sorted(p for p in backups.iterdir() if p.is_dir())[:-SYNC_BACKUPS]:
                shutil.rmtree(old, ignore_errors=True)
        for name in sorted(files, key=lambda n: n == 'sync.json'):
            tmp = hub.HERE / f'.{name}.tmp'
            tmp.write_text(files[name], encoding='utf-8')
            os.replace(tmp, hub.HERE / name)
    print(json.dumps({'ok': True, 'backup': stamp if replaced else None}))


def caller_token(port):
    """The CLI's caller token for this backend: the token file named for host and
    port in canopy's config dir, else CANOPY_TOKEN; a blank value is no token."""
    config = os.environ.get('CANOPY_CONFIG_DIR') or str(Path.home() / '.config' / 'canopy')
    try:
        filed = (Path(config) / f'token-127.0.0.1-{int(port)}').read_text().strip()
    except OSError:
        filed = ''
    return filed or os.environ.get('CANOPY_TOKEN', '').strip()


def announce(args):
    """Self-register with Canopy's live worker, best effort like the old CLI."""
    import urllib.request
    try:
        headers = {'Content-Type': 'application/json'}
        if args.helper_port:
            url = f'http://127.0.0.1:{args.helper_port}/library/api/dev/register'
            port = args.helper_port
        else:
            worker = json.loads((hub.HERE / '.worker.json').read_text())
            headers['X-Canopy-Library'] = worker['token']
            url = f"http://127.0.0.1:{int(worker['port'])}/api/dev/register"
            port = worker['port']
        token = caller_token(port)
        if token:
            headers['X-Canopy-Token'] = token
        payload = json.dumps({'project': args.project, 'port': int(args.port)}).encode()
        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=3) as response:
            result = json.load(response)
        print(f'announced {args.project} :{args.port}' if result.get('ok') else 'announce rejected')
    except (OSError, ValueError, KeyError) as exc:
        print(f'announce failed: {exc}', file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description='Canopy workspace library')
    parser.add_argument('--root', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    configure(args.root, args.state)
    command = args.command
    if command and command[0] == '--':
        command = command[1:]
    command = command or ['--help']
    if command[0] == '__serve':
        serve()
        return
    if command[0] == '__sync-write':
        sync_write()
        return
    # Process lifecycle is owned by Canopy. Site-specific publishing remains
    # in the original repo, rather than shipping personal deployment targets.
    if command[0] in ('serve', 'install-agent', 'uninstall-agent', 'gallery'):
        parser.error('Use canopy ui for the service. Site publishing stays in _devhub.')
    adapt_templates()
    hub._git_autostage_index = lambda: None
    hub.cmd_announce = announce
    sys.argv = ['canopy library', *command]
    if command[0] == 'announce':
        hub.main()
    else:
        with locked():
            hub.main()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f'canopy library: {exc}', file=sys.stderr)
        sys.exit(1)
