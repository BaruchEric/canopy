#!/usr/bin/env python3
"""
devhub - a self-evolving manager for the ~/Arik/dev workspace.

Keeps projects sorted into topic folders, onboards new ones (repos AND links),
runs health checks, and regenerates a static HTML dashboard. Stdlib only.

Usage:
    python3 devhub.py scan                 # rebuild manifest.json
    python3 devhub.py index                # scan + regenerate index.html
    python3 devhub.py doctor               # health report
    python3 devhub.py classify [PATH]      # suggest a category for strays or a path
    python3 devhub.py import SRC [opts]    # onboard a repo URL, youtube/web link, or folder
    python3 devhub.py move PROJECT CAT     # re-file a project (learns an override)
    python3 devhub.py add-category NAME LABEL [KEYWORD ...]
    python3 devhub.py refs                 # list saved links/references
    python3 devhub.py unref QUERY          # remove a reference by id/title/url

`import` auto-detects what you paste:
    - git repo URL (github/gitlab/bitbucket/git@/.git)  -> clones + files as a project
    - youtube.com / youtu.be link                       -> saves a classified reference
    - any other http(s) link                            -> saves a classified reference
    - a local folder path                               -> moves it into the right category

import options:
    --category CAT     force a category (skip auto-classify)
    --name NAME        destination folder name (repos/folders)
    --title TITLE      title for a saved link (skips title fetch)

The dev root is the parent of this script's folder, so the toolkit is portable.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
DEV_ROOT = HERE.parent
CONFIG_PATH = HERE / "categories.json"
MANIFEST_PATH = HERE / "manifest.json"
INDEX_PATH = HERE / "index.html"
REFS_PATH = HERE / "references.json"
TAGS_PATH = HERE / "tags.json"
RELATIONS_PATH = HERE / "relations.json"
HEALTH_PATH = HERE / "health.json"
RUNNING_PATH = HERE / "running.json"
TMP_DIR = HERE / ".import_tmp"
REFS_DIR = DEV_ROOT / "references"

WEBLOC_TEMPLATE = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    '<plist version="1.0">\n<dict>\n\t<key>URL</key>\n'
    '\t<string>{url}</string>\n</dict>\n</plist>\n'
)

LANG_MARKERS = [
    ("package.json", "JavaScript/TypeScript"),
    ("tsconfig.json", "TypeScript"),
    ("Cargo.toml", "Rust"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("setup.py", "Python"),
    ("go.mod", "Go"),
    ("Gemfile", "Ruby"),
    ("pom.xml", "Java"),
    ("build.gradle", "Java/Kotlin"),
    ("composer.json", "PHP"),
    ("Package.swift", "Swift"),
    ("CMakeLists.txt", "C/C++"),
    ("Makefile.am", "C/C++"),
    ("configure.ac", "C/C++"),
]

# Canonical README filenames, checked in priority order. Used everywhere a
# project's README is read so the set never drifts between call sites.
README_NAMES = (
    "README.md", "README.MD", "Readme.md", "README.rst", "README.txt", "README",
)

# Docker-compose marker filenames (any of these implies a compose project).
COMPOSE_FILES = (
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
)

# Deep-scan tuning (used only by `build`, never by the regular `scan`/`index`).
# Folders we never descend into when discovering nested subprojects.
DEEP_SCAN_IGNORE = {
    "node_modules", ".git", ".hg", ".svn", "target", "dist", "build",
    ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "env", "vendor",
    "__pycache__", ".turbo", ".cache", "coverage", ".idea", ".vscode",
    "out", ".pytest_cache", ".mypy_cache", ".gradle", "Pods", ".terraform",
    ".expo", "DerivedData", "bin", "obj",
}
DEEP_SCAN_MAX_DEPTH = 3      # levels below a top-level project to descend
DEEP_SCAN_MAX_HITS = 60      # cap subprojects reported per top-level project

# A nested folder counts as its own subproject if it carries one of these.
SUBPROJECT_MARKERS = (
    "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile",
    "pom.xml", "composer.json", "Package.swift", "requirements.txt",
)

# Allowed project folder names — also blocks path traversal ("../") when a name
# arrives from the (CORS-reachable) helper POST endpoints.
PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CATEGORY_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

# Hosts that are never the project's own deployed app (docs, badges, repos…).
NON_APP_HOSTS = (
    "github.com", "gitlab.com", "bitbucket.org", "shields.io",
    "npmjs.com", "youtube.com", "youtu.be", "twitter.com", "x.com",
    "linkedin.com", "apple.com", "w3.org", "mozilla.org", "anthropic.com",
    "discord.gg", "discord.com", "bun.sh", "astral.sh", "trendshift.io",
    "storage.googleapis.com", "oxc.rs", "groq.com",
    "convex.dev", "nodejs.org", "python.org", "rust-lang.org", "docker.com",
)


STOPWORDS = {
    "the", "and", "for", "with", "you", "your", "this", "that", "from", "into",
    "over", "not", "but", "are", "was", "were", "have", "has", "had", "its",
    "our", "their", "they", "them", "there", "then", "what", "when", "where",
    "why", "how", "who", "all", "any", "make", "makes", "made", "new", "get",
    "got", "one", "two", "three", "entire", "obsolete", "tutorial", "docs",
    "documentation", "guide", "intro", "update", "welcome", "page", "read",
    "next", "ref", "watch", "com", "org", "net", "www", "html", "htm", "post",
    "posts", "video", "videos", "ksr", "auto", "registered", "users", "mktg",
    "https", "http", "youtube", "github", "gitlab", "bitbucket", "site",
    "blog", "article", "email", "backer", "project",
}


def _tokenize(s: str) -> list:
    return [t for t in re.findall(r"[a-z][a-z0-9]{2,}", (s or "").lower())
            if t not in STOPWORDS]


def find_topic(title: str, url: str, refs: list, exclude=None, token_cache=None):
    """Return (topic_key, matched_ref) if this ref strongly relates to another.

    `token_cache` (dict keyed by id(ref)) lets a caller looping over many refs
    tokenize each ref once instead of once per find_topic call."""
    new_tokens = set(_tokenize(title) + _tokenize(url))
    if not new_tokens:
        return None, None
    best_score, best_ref, best_common = 0, None, set()
    for r in refs:
        if exclude is not None and r is exclude:
            continue
        if token_cache is None:
            other = set(_tokenize(r.get("title", "")) + _tokenize(r.get("url", "")))
        else:
            other = token_cache.get(id(r))
            if other is None:
                other = token_cache[id(r)] = set(
                    _tokenize(r.get("title", "")) + _tokenize(r.get("url", "")))
        common = new_tokens & other
        score = (len(common) if len(common) >= 2
                 else (1 if any(len(t) >= 7 for t in common) else 0))
        if score > best_score:
            best_score, best_ref, best_common = score, r, common
    if not best_ref:
        return None, None
    if best_ref.get("topic"):
        return best_ref["topic"], best_ref
    # build key from the 2 most distinctive (longest) shared tokens
    chosen = sorted(best_common, key=lambda t: (-len(t), t))[:2]
    return "-".join(sorted(chosen)), best_ref


def detect_project_match(title: str, url: str, project_names: list):
    """Return an existing project name whose name (or a meaningful sub-word of
    its hyphenated name) appears as a whole word in title/url."""
    hay = (title + " " + url).lower()
    by_length = sorted(project_names, key=len, reverse=True)
    # Pass 1: full name (longest first)
    for name in by_length:
        if len(name) >= 4 and re.search(
                r"\b" + re.escape(name.lower()) + r"\b", hay):
            return name
    # Pass 2: require ALL sub-words (≥5 chars) of a hyphenated name to appear
    for name in by_length:
        parts = [p for p in re.split(r"[-_ ]+", name.lower()) if len(p) >= 5]
        if not parts:
            continue
        if all(re.search(r"\b" + re.escape(p) + r"\b", hay) for p in parts):
            return name
    return None


def _is_app_url(u: str) -> bool:
    u = u.rstrip(".,")
    if not u.startswith("http"):
        return False
    host = (urlparse(u).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    # Reject only when the host equals a known non-app host or is a subdomain
    # of one — a substring check wrongly rejected e.g. "prefixx.com".
    if any(host == h or host.endswith("." + h) for h in NON_APP_HOSTS):
        return False
    if host in ("localhost", "127.0.0.1"):
        return False
    if re.search(r"\.(svg|png|jpe?g|gif|webp|ico)(\?|#|$)", u, re.I):
        return False
    return True


# --------------------------------------------------------------------------- #
# config + refs persistence
# --------------------------------------------------------------------------- #
DEFAULT_DEV_PORT_BASE = 6100


def assign_dev_ports(cfg: dict, project_names: list[str]) -> list[str]:
    """Assign a stable dev_port to every named project that lacks one.

    Ports come from cfg['dev_port_base'] (default 6100) upward, skipping any
    port already assigned/pinned to any project. Mutates cfg['links'] in place
    and returns the list of projects newly assigned. Idempotent.
    """
    base = int(cfg.get("dev_port_base") or DEFAULT_DEV_PORT_BASE)
    links = cfg.setdefault("links", {})
    used = {int(v["dev_port"]) for v in links.values()
            if isinstance(v, dict) and v.get("dev_port")}
    nxt = base
    assigned = []
    for name in project_names:
        entry = links.setdefault(name, {})
        if entry.get("dev_port"):
            continue
        while nxt in used:
            nxt += 1
        entry["dev_port"] = nxt
        used.add(nxt)
        assigned.append(name)
        nxt += 1
    return assigned


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")


def load_refs() -> list:
    if REFS_PATH.exists():
        try:
            return json.loads(REFS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def save_refs(refs: list) -> None:
    with open(REFS_PATH, "w", encoding="utf-8") as fh:
        json.dump(refs, fh, indent=2)
        fh.write("\n")


def load_tags() -> dict:
    if TAGS_PATH.exists():
        try:
            return json.loads(TAGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_tags(d: dict) -> None:
    with open(TAGS_PATH, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=2)
        fh.write("\n")


def _normalize_tag(t: str) -> str:
    return re.sub(r"\s+", "-", t.strip().lower())


def load_relations() -> list:
    if RELATIONS_PATH.exists():
        try:
            data = json.loads(RELATIONS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data.get("pairs", [])
            # Tolerate a legacy bare-list file so we don't discard it on save.
            return data if isinstance(data, list) else []
        except Exception:
            return []
    return []


def save_relations(pairs: list) -> None:
    # store as sorted unique pairs of sorted strings
    seen = set()
    clean = []
    for a, b in pairs:
        key = tuple(sorted([a, b]))
        if key in seen or key[0] == key[1]:
            continue
        seen.add(key)
        clean.append(list(key))
    clean.sort()
    with open(RELATIONS_PATH, "w", encoding="utf-8") as fh:
        json.dump({"pairs": clean}, fh, indent=2)
        fh.write("\n")


def load_health() -> dict:
    """Last-known live-URL health, keyed by deployed URL. Written by `build`."""
    try:
        data = json.loads(HEALTH_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_health(d: dict) -> None:
    try:
        HEALTH_PATH.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# git + metadata helpers
# --------------------------------------------------------------------------- #
def git(args, cwd) -> str:
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(cwd),
            capture_output=True, text=True, timeout=20,
        )
        # Distinguish a real failure (e.g. detached/empty HEAD, not a repo)
        # from genuinely empty output — both used to look the same.
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def is_git_repo(path: Path) -> bool:
    return (path / ".git").exists()


# Environment that makes git *network* ops fail fast instead of blocking on a
# credential/passphrase/known-hosts prompt. Essential for the parallel fetch in
# `build` and the `git` batch subcommands: without it, a single repo with an
# uncached HTTPS remote, a passphrase-protected key, or a dead remote would
# deadlock the whole concurrent pass waiting on stdin.
GIT_NONINTERACTIVE_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=10",
    "GIT_ASKPASS": "true",        # never invoke a GUI/askpass credential helper
    "SSH_ASKPASS_REQUIRE": "never",
}


def git_run(args, cwd, timeout: int = 60):
    """git() for *mutating / network* ops: returns (ok, message).

    Runs non-interactively so a batch never hangs on an auth prompt, and
    surfaces stdout+stderr so callers can report why a fetch/pull/push failed.
    """
    env = dict(os.environ, **GIT_NONINTERACTIVE_ENV)
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(cwd),
            capture_output=True, text=True, timeout=timeout, env=env,
        )
        return out.returncode == 0, (out.stdout + out.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    except Exception as e:
        return False, str(e)


def git_status_summary(path: Path) -> dict:
    """All the git state the monitor needs in ONE subprocess.

    Parses `git status --branch --porcelain=v2`, which replaces three calls
    (rev-parse HEAD + status --porcelain + a rev-list ahead/behind count).
    porcelain v2 reports the counts ahead-then-behind (`# branch.ab +a -b`),
    and omits the `branch.upstream`/`branch.ab` lines entirely when the branch
    has no upstream — a clean signal for never-pushed / unpushed-branch work.
    """
    s = {"branch": "", "detached": False, "has_upstream": False,
         "ahead": 0, "behind": 0, "dirty": False, "dirty_count": 0}
    out = git(["status", "--branch", "--porcelain=v2"], path)
    if not out:
        return s
    dirty = 0
    for ln in out.splitlines():
        if ln.startswith("# branch.head "):
            head = ln[len("# branch.head "):].strip()
            if head == "(detached)":
                s["detached"] = True
            else:
                s["branch"] = head
        elif ln.startswith("# branch.upstream "):
            s["has_upstream"] = True
        elif ln.startswith("# branch.ab "):
            try:
                parts = ln.split()          # ['#','branch.ab','+a','-b']
                s["ahead"] = int(parts[2].lstrip("+"))
                s["behind"] = int(parts[3].lstrip("-"))
            except (ValueError, IndexError):
                pass
        elif not ln.startswith("#"):
            dirty += 1
    s["dirty_count"] = dirty
    s["dirty"] = dirty > 0
    return s


def _read_pkg(path: Path) -> dict:
    """Parse a project's package.json once; return {} on absence/error."""
    pj = path / "package.json"
    if not pj.exists():
        return {}
    try:
        data = json.loads(pj.read_text(encoding="utf-8", errors="ignore"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def detect_language(path: Path) -> str:
    found = []
    for marker, lang in LANG_MARKERS:
        if (path / marker).exists():
            found.append(lang)
    if not found:
        if any((path / c).exists() for c in COMPOSE_FILES):
            return "Docker Compose"
        exts = {}
        try:
            for p in list(path.iterdir())[:200]:
                if p.is_file():
                    exts[p.suffix] = exts.get(p.suffix, 0) + 1
        except Exception:
            pass
        ext_lang = {".py": "Python", ".rs": "Rust", ".go": "Go",
                    ".js": "JavaScript", ".ts": "TypeScript", ".sh": "Shell",
                    ".c": "C", ".cpp": "C++", ".rb": "Ruby", ".md": "Docs"}
        for ext, _n in sorted(exts.items(), key=lambda kv: -kv[1]):
            if ext in ext_lang:
                return ext_lang[ext]
        return "—"
    uniq = []
    for f in found:
        if f not in uniq:
            uniq.append(f)
    if "TypeScript" in uniq and "JavaScript/TypeScript" in uniq:
        uniq.remove("JavaScript/TypeScript")
    return ", ".join(uniq[:2])


def _strip_md_emphasis(s: str) -> str:
    """Strip inline Markdown emphasis/code markers from a one-line description.

    Card descriptions are plain text, so leftover **bold**, *italic*, and `code`
    markers (and any stray ``**``) just read as noise. Balanced markers are
    unwrapped; an unbalanced trailing ``**`` is dropped.
    """
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)                        # **bold**
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"\1", s)  # *italic*
    s = re.sub(r"`([^`]+)`", r"\1", s)                            # `code`
    return s.replace("**", "").strip()


def _read_toml_description(path: Path) -> str:
    """Best-effort one-line description from Python/Rust package metadata.

    stdlib-only (no tomllib — that's 3.11+ — and the zero-dep rule forbids
    tomli), so this is a targeted line scan, not a full TOML parse: it tracks
    the current table header and reads a single-line ``description = "..."``
    from the tables that conventionally hold one — pyproject's
    ``[project]`` / ``[tool.poetry]`` and Cargo's ``[package]`` /
    ``[workspace.package]``. A ``description.workspace = true`` inheritance line
    has no quoted value, so it's skipped and the real string is picked up from
    ``[workspace.package]`` instead.
    """
    sources = (
        ("pyproject.toml", ("project", "tool.poetry")),
        ("Cargo.toml", ("package", "workspace.package")),
    )
    for fname, tables in sources:
        fp = path / fname
        if not fp.exists():
            continue
        try:
            section = None
            for raw in fp.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = raw.strip()
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1].strip()
                    continue
                if section in tables:
                    m = re.match(r'''description\s*=\s*(["'])(.*?)\1\s*$''', line)
                    if m and m.group(2).strip():
                        return _strip_md_emphasis(m.group(2).strip())[:240]
        except Exception:
            pass
    return ""


def read_description(path: Path, pkg: dict | None = None) -> str:
    pkg = _read_pkg(path) if pkg is None else pkg
    d = (pkg.get("description") or "").strip()
    if d:
        return _strip_md_emphasis(d)[:240]
    td = _read_toml_description(path)
    if td:
        return td
    for name in README_NAMES:
        rp = path / name
        if rp.exists():
            try:
                in_anchor = False
                for raw in rp.read_text(encoding="utf-8", errors="ignore").splitlines():
                    # Skip blockquote callouts/admonitions (> **Note**, > **Warning**,
                    # GitHub-style alerts) — they're disclaimers, not the tagline.
                    if raw.lstrip().startswith(">"):
                        continue
                    # Skip text inside multi-line HTML anchors (sponsor banners,
                    # linked logo blocks) — link text spanning lines is never the
                    # tagline. Single-line <a>text</a> keeps its text as before.
                    opens = len(re.findall(r"<a[\s>]", raw))
                    closes = raw.count("</a>")
                    if in_anchor:
                        if closes:
                            in_anchor = False
                        continue
                    if opens > closes:
                        in_anchor = True
                        continue
                    line = re.sub(r"<[^>]+>", "", raw).strip()
                    line = re.sub(r"^[#>*\-\s]+", "", line).strip()
                    if not line:
                        continue
                    if line.startswith("![") or line.startswith("[!["):
                        continue
                    if line.lower() == path.name.lower():
                        continue
                    line = _strip_md_emphasis(line)
                    if len(line) < 8:
                        continue
                    return line[:240]
            except Exception:
                pass
    return ""


def detect_deployed(path: Path, pkg: dict | None = None) -> str:
    """Conservative guess of a project's live/deployed URL.

    Only accepts package.json `homepage` or a README URL that is explicitly
    introduced by a deploy keyword — avoids grabbing install/docs/badge links.
    """
    pkg = _read_pkg(path) if pkg is None else pkg
    hp = (pkg.get("homepage") or "").strip()
    if _is_app_url(hp):
        return hp.rstrip("/")
    for name in README_NAMES:
        rp = path / name
        if not rp.exists():
            continue
        try:
            txt = rp.read_text(encoding="utf-8", errors="ignore")[:8000]
        except Exception:
            break
        for kw in ("live at", "live demo", "live site", "production runs at",
                   "production at", "production:", "deployed at", "deployed to",
                   "hosted at", "available at", "runs at", "demo at",
                   "demo:", "app:", "url:", "website:"):
            # Exclude Markdown emphasis/code delimiters (* and `) from the URL
            # capture so a bold- or code-wrapped link like **https://x.com**
            # doesn't swallow the trailing markers into the URL.
            m = re.search(re.escape(kw) + r"[^\n]*?(https?://[^\s)\]\"'>*`]+)",
                          txt, re.I)
            if m and _is_app_url(m.group(1)):
                return m.group(1).rstrip(".,")
        break
    return ""


def _scan_entry_port(path: Path, scripts: dict) -> str | None:
    """If the ``dev``/``start`` script launches a local server *file*
    (e.g. ``tsx server.ts``, ``node src/app.js``), read that file and pull
    out the port it listens on.

    Covers custom Node/Express servers whose framework default (Vite's 5173,
    say) would otherwise be guessed wrong — e.g. a project that depends on
    ``vite`` but actually serves it through Express on another port. Best
    effort: returns the first port found as a string, or ``None``.
    """
    if not isinstance(scripts, dict):
        return None
    for key in ("dev", "start"):
        cmd = scripts.get(key) or ""
        # The first local script file the command references, if any.
        fm = re.search(r"(?<![\w./@-])([\w./-]+\.(?:ts|js|mjs|cjs))\b", cmd)
        if not fm:
            continue
        entry = path / fm.group(1)
        if not entry.exists():
            continue
        txt = _read_head(entry)
        m = (re.search(r"(?:const|let|var)\s+PORT\b\s*=\s*(\d{2,5})", txt)
             or re.search(r"process\.env\.PORT\s*\|\|\s*['\"]?(\d{2,5})", txt)
             or re.search(r"\.listen\(\s*(\d{2,5})\b", txt)
             or re.search(r"\bport\s*:\s*(\d{2,5})\b", txt))
        if m:
            return m.group(1)
    return None


def detect_dev_url(path: Path, pkg: dict | None = None) -> str:
    """Best-effort guess of the local dev-server URL."""
    port = None
    deps: set = set()
    scripts: dict = {}
    pkg = _read_pkg(path) if pkg is None else pkg
    if pkg:
        scripts = pkg.get("scripts", {})
        blob = " ".join(scripts.values()) if isinstance(scripts, dict) else ""
        m = re.search(r"(?:--port[ =]|-p[ =])(\d{2,5})", blob)
        if m:
            port = m.group(1)
        deps = set((pkg.get("dependencies") or {}).keys()) | \
               set((pkg.get("devDependencies") or {}).keys())
    if not port:
        # A custom server file (tsx server.ts, …) is authoritative over the
        # framework default below — read its actual listen port.
        port = _scan_entry_port(path, scripts)
    if not port:
        for vc in ("vite.config.ts", "vite.config.js", "vite.config.mjs"):
            p = path / vc
            if p.exists():
                try:
                    m = re.search(r"port\s*:\s*(\d{2,5})",
                                  p.read_text(encoding="utf-8", errors="ignore"))
                    if m:
                        port = m.group(1)
                except Exception:
                    pass
                break
    if not port:
        if "next" in deps:
            port = "3000"
        elif "vite" in deps:
            port = "5173"
        elif "react-scripts" in deps or "@remix-run/dev" in deps:
            port = "3000"
    return f"http://localhost:{port}" if port else ""


def _resolved_dev_url(path: Path, cfg: dict | None = None,
                      fallback: str | None = None) -> str:
    """The dev URL the dashboard/helper should use for a project.

    Authority: a *manual* links.<name>.dev (no `auto` flag) wins and freezes
    detection; else an assigned `dev_port` (+ optional `dev_path`); else the
    best-effort `detect_dev_url`. Used by the dashboard render and by the
    helper's `dev`/`devstatus` actions so a pinned URL is actually honored.
    """
    cfg = load_config() if cfg is None else cfg
    ov = (cfg.get("links") or {}).get(path.name) or {}
    dev = ov.get("dev")
    if dev and not ov.get("auto"):
        return str(dev)
    port = ov.get("dev_port")
    if port:
        base = str(ov.get("dev_path") or "")
        return f"http://localhost:{int(port)}{base}"
    # `fallback` lets a caller that already ran detect_dev_url (project_info
    # shares its parsed package.json) skip a second disk-reading detection.
    return detect_dev_url(path) if fallback is None else fallback


def detect_dev_command(path: Path, cfg: dict | None = None) -> str:
    """Best-effort shell command that starts the project's local dev server.

    Resolution order:
      1. a manual ``dev_cmd`` override in categories.json ``links[<name>]``
         (escape hatch for monorepos / non-standard setups);
      2. the ``dev`` (then ``start``) script in package.json, run with the
         package manager inferred from the lockfile / ``packageManager`` field.
    Returns "" when nothing is detectable.
    """
    cfg = load_config() if cfg is None else cfg
    override = ((cfg.get("links") or {}).get(path.name) or {}).get("dev_cmd")
    if override:
        return str(override)
    pkg = _read_pkg(path)
    if not pkg:
        return ""
    scripts = pkg.get("scripts") or {}
    script = "dev" if "dev" in scripts else ("start" if "start" in scripts else "")
    if not script:
        return ""
    pm = str(pkg.get("packageManager") or "")
    if (path / "bun.lockb").exists() or (path / "bun.lock").exists() or pm.startswith("bun"):
        runner = "bun run"
    elif (path / "pnpm-lock.yaml").exists() or pm.startswith("pnpm"):
        runner = "pnpm"
    elif (path / "yarn.lock").exists() or pm.startswith("yarn"):
        runner = "yarn"
    else:
        runner = "npm run"
    return f"{runner} {script}"


def _dev_port(url: str) -> int | None:
    """Extract the TCP port from a localhost dev URL, or None."""
    m = re.search(r":(\d{2,5})(?:/|$)", url or "")
    return int(m.group(1)) if m else None


def _pid_on_port(port: int) -> int | None:
    """PID of the process LISTENING on a localhost port, via lsof, or None."""
    try:
        out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                             capture_output=True, text=True, timeout=3)
        line = (out.stdout or "").strip().splitlines()
        return int(line[0]) if line else None
    except Exception:
        return None


def _pid_cwd(pid: int) -> Path | None:
    """Working directory of a pid (macOS lsof -d cwd), resolved, or None."""
    try:
        out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                             capture_output=True, text=True, timeout=3)
        for ln in (out.stdout or "").splitlines():
            if ln.startswith("n"):
                return Path(ln[1:]).resolve()
    except Exception:
        pass
    return None


def _pid_uid(pid: int) -> int | None:
    try:
        out = subprocess.run(["ps", "-o", "uid=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=3)
        s = (out.stdout or "").strip()
        return int(s) if s else None
    except Exception:
        return None


def _safe_to_kill(*, pid: int, assigned_port: int) -> bool:
    """Refuse unless the pid is the process actually LISTENING on the project's
    assigned dev_port, owned by the current user, with cwd under DEV_ROOT."""
    if not pid or not assigned_port:
        return False
    if _pid_on_port(assigned_port) != pid:   # the pid must own the assigned port
        return False
    if _pid_uid(pid) != os.getuid():
        return False
    cwd = _pid_cwd(pid)
    root = DEV_ROOT.resolve()
    return bool(cwd and (cwd == root or root in cwd.parents))


def _kill_proc_group(pid: int, grace: float = 4.0):
    """SIGTERM the process group, then SIGKILL after a grace if still alive."""
    try:
        pgid = os.getpgid(pid)
    except Exception:
        pgid = pid
    if pgid == os.getpgid(os.getpid()):
        return  # never signal devhub's own process group
    try:
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        return
    deadline = time.time() + grace
    while time.time() < deadline:
        try:
            os.killpg(pgid, 0)  # still alive?
        except OSError:
            return  # gone
        time.sleep(0.2)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except Exception:
        pass


def _port_flag_for(devcmd: str, port: int) -> str:
    """The port flag a recognized runner needs, or "" if it isn't recognized."""
    if re.search(r"(?:^|\s)vite(?:\s|$)", devcmd):
        return f"--port {port} --strictPort"
    if re.search(r"(?:^|\s)next(?:\s|$)", devcmd):
        return f"-p {port}"
    if re.search(r"(?:^|\s)astro(?:\s|$)", devcmd):
        return f"--port {port}"
    return ""


def dev_env_prefix(name: str, port: int) -> str:
    """Environment a dev server needs to be reachable by its short .test name.

    DEVHUB_PORT/PORT pin the port. The Vite variable matters for HMR: Vite's
    server.allowedHosts 403s an unrecognized Host, and its HMR websocket runs
    on its own port (24678 by default) that the Caddy proxy is not in front of,
    so a Host rewrite there is impossible — the app itself has to accept the
    name. `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` appends one host to
    allowedHosts at config time, which needs no edit to any repo.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import dns as _dns
        host = f"{_dns.slug(name)}.{_dns.TLD}"
    except Exception:
        return f"DEVHUB_PORT={port} PORT={port}"
    return (f"DEVHUB_PORT={port} PORT={port} "
            f"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS={host}")


def build_launch_command(devcmd: str, port: int, path: Path | None = None) -> str:
    """Append the right port flag to a dev command for recognized runners.

    Handles two shapes:
      1. a direct runner invocation ("vite", "next dev");
      2. a package-runner form ("bun run dev") whose *script* is a direct
         runner — the flag goes after ``--`` so the runner forwards it. Without
         this, `bun run dev` wrapping vite silently ignores its assigned port
         and binds 5173, because Vite does not read PORT from the environment.

    Composite commands (containing & ; |) and unknown runners are returned
    unchanged — the launcher still exports DEVHUB_PORT for those.
    """
    if any(sep in devcmd for sep in ("&", ";", "|")):
        return devcmd  # composite: rely on DEVHUB_PORT env, never inject a flag

    direct = _port_flag_for(devcmd, port)
    if direct:
        return f"{devcmd} {direct}"

    m = re.match(r"^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)$", devcmd.strip())
    if m and path is not None:
        pkg = _read_pkg(path) or {}
        script = (pkg.get("scripts") or {}).get(m.group(1), "")
        flag = _port_flag_for(str(script), port) if script else ""
        if flag:
            return f"{devcmd} -- {flag}"
    return devcmd


def _port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.3) -> bool:
    """Quick TCP probe: is something already accepting connections on `port`?"""
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _read_head(path: Path, n: int = 8000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:n]
    except Exception:
        return ""


def _valid_mined_url(u: str) -> bool:
    """Reject mined URLs polluted by CI/template expressions or markdown.

    The regex miners have no YAML/TOML/Markdown parser, so they can grab
    fragments like ``https://${{`` (a GitHub Actions ``${{ … }}`` expression
    leaking from a workflow ``url:``) or ``https://x**`` (markdown bold
    leaking from a README). Any URL carrying template/markup/whitespace
    characters is not a real deployment target — drop it rather than persist
    it as an auto-link.
    """
    if any(ch in u for ch in "${}*<>`\"'\\ \t"):
        return False
    host = u.split("://", 1)[-1].split("/", 1)[0].split("?")[0]
    return "." in host and len(host) > 3


def detect_deploy_targets(path: Path, pkg: dict | None = None) -> dict:
    """Mine deploy-config files + CI for a deployment URL and the platform.

    Regex on known patterns only (no YAML/TOML parser, no deps) — accepts
    partial coverage. Returns {"url": str, "method": str}; either may be "".
    Falls back to the conservative package.json/README detector for the URL.
    """
    pkg = _read_pkg(path) if pkg is None else pkg
    url, method = "", ""

    fb = path / "firebase.json"
    if fb.exists():
        method = method or "firebase"
        m = re.search(r'"site"\s*:\s*"([A-Za-z0-9-]+)"', _read_head(fb))
        if m and not url:
            url = f"https://{m.group(1)}.web.app"

    fly = path / "fly.toml"
    if fly.exists():
        method = method or "fly"
        m = re.search(r'^\s*app\s*=\s*"([A-Za-z0-9-]+)"', _read_head(fly), re.M)
        if m and not url:
            url = f"https://{m.group(1)}.fly.dev"

    for wr in ("wrangler.toml", "wrangler.jsonc", "wrangler.json"):
        wp = path / wr
        if wp.exists():
            method = method or "cloudflare"
            txt = _read_head(wp)
            m = (re.search(r'(?:pattern|route)\s*=\s*["\']([^"\'*]+)', txt)
                 or re.search(r'"(?:pattern|route)"\s*:\s*"([^"*]+)"', txt))
            if m and not url:
                host = m.group(1).strip().strip("/").split("/")[0]
                if "." in host:
                    url = f"https://{host}"
            break

    vj = path / "vercel.json"
    if vj.exists():
        method = method or "vercel"
        m = re.search(r'"alias"\s*:\s*(?:\[\s*)?"([^"]+)"', _read_head(vj))
        if m and not url:
            url = f"https://{m.group(1)}"

    if (path / "netlify.toml").exists():
        method = method or "netlify"

    cn = path / "CNAME"
    if cn.exists():
        first = _read_head(cn, 256).strip().splitlines()
        cand = first[0].strip() if first else ""
        if cand and "." in cand and " " not in cand:
            method = method or "gh-pages"
            if not url:
                url = f"https://{cand}"

    wf = path / ".github" / "workflows"
    if wf.is_dir():
        try:
            for yml in sorted(wf.glob("*.y*ml"))[:12]:
                txt = _read_head(yml, 12000)
                if not method:
                    low = txt.lower()
                    for kw, mname in (
                        ("amondnet/vercel-action", "vercel"), ("vercel", "vercel"),
                        ("netlify", "netlify"),
                        ("firebasehosting", "firebase"), ("firebase deploy", "firebase"),
                        ("cloudflare/pages-action", "cloudflare"), ("wrangler", "cloudflare"),
                        ("superfly/flyctl", "fly"), ("flyctl deploy", "fly"),
                        ("peaceiris/actions-gh-pages", "gh-pages"),
                        ("actions/deploy-pages", "gh-pages"),
                    ):
                        if kw in low:
                            method = mname
                            break
                if not url:
                    m = re.search(
                        r'environment:\s*\n(?:[^\n]*\n)?\s*url:\s*["\']?'
                        r'(https?://[^\s"\'#]+)', txt)
                    if m:
                        url = m.group(1).rstrip("/")
                if method and url:
                    break
        except Exception:
            pass

    if not url:
        url = detect_deployed(path, pkg)
    url = url.rstrip("/") if url else ""
    if url and not _valid_mined_url(url):
        url = ""
    return {"url": url, "method": method}


def discover_subprojects(root: Path) -> list:
    """Walk below a top-level project to find nested project folders.

    Returns lightweight dicts (name/path/language/deployed/has_readme). Skips
    heavy build/vendor dirs, caps depth and total hits. Deep-scan only.
    """
    out: list = []

    def walk(d: Path, depth: int):
        if depth > DEEP_SCAN_MAX_DEPTH or len(out) >= DEEP_SCAN_MAX_HITS:
            return
        try:
            children = sorted((c for c in d.iterdir() if c.is_dir()),
                              key=lambda p: p.name.lower())
        except Exception:
            return
        for c in children:
            if c.name.startswith(".") or c.name in DEEP_SCAN_IGNORE:
                continue
            if len(out) >= DEEP_SCAN_MAX_HITS:
                return
            if any((c / mk).exists() for mk in SUBPROJECT_MARKERS) or is_git_repo(c):
                pkg = _read_pkg(c)
                out.append({
                    "name": c.name,
                    "path": str(c.relative_to(DEV_ROOT)),
                    "language": detect_language(c),
                    "deployed": detect_deploy_targets(c, pkg)["url"],
                    "has_readme": any((c / n).exists() for n in README_NAMES),
                })
            walk(c, depth + 1)

    walk(root, 1)
    return out


def _check_url(url: str) -> dict:
    """Single-URL reachability probe. 2xx/3xx and auth walls count as 'up'."""
    import ssl
    import urllib.error
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        url, method="GET",
        headers={"User-Agent": "devhub-healthcheck/1"})
    try:
        with urllib.request.urlopen(req, timeout=6, context=ctx) as resp:
            code = int(getattr(resp, "status", 0) or 0)
            return {"status": code, "ok": 200 <= code < 400}
    except urllib.error.HTTPError as e:
        return {"status": int(e.code), "ok": e.code in (401, 403)}
    except Exception:
        return {"status": 0, "ok": False}


def health_check_urls(urls: list) -> dict:
    """Probe a list of URLs in parallel; returns {url: {status, ok, checked}}."""
    from concurrent.futures import ThreadPoolExecutor
    uniq = list(dict.fromkeys(u for u in urls if u))
    if not uniq:
        return {}
    now = dt.datetime.now().astimezone().replace(microsecond=0).isoformat()
    results: dict = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for u, res in zip(uniq, ex.map(_check_url, uniq)):
            res["checked"] = now
            results[u] = res
    return results


def fetch_repos(paths: list) -> dict:
    """Parallel `git fetch` across repos so ahead/behind reflects the live
    remote. Non-interactive (see git_run) so one auth-required or dead remote
    can't hang the whole pass. Returns {abs_path_str: (ok, message)}."""
    from concurrent.futures import ThreadPoolExecutor
    uniq = list(dict.fromkeys(str(p) for p in paths))
    if not uniq:
        return {}

    def _one(p):
        return p, git_run(["fetch", "--quiet", "--prune"], p, timeout=45)

    results: dict = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for p, res in ex.map(_one, uniq):
            results[p] = res
    return results


def _git_state_fields(gs: dict, remote: str) -> dict:
    """Map a `git_status_summary` dict (+ remote) to the manifest's per-repo
    monitor fields — the single home of the derivations (notably the
    no-upstream rule: a repo with a remote but no upstream tracking on its
    branch = work that's never been pushed; detached HEADs legitimately have
    no upstream, so they aren't flagged)."""
    return {
        "branch": gs["branch"] or ("HEAD" if gs["detached"] else ""),
        "detached": gs["detached"],
        "dirty": gs["dirty"], "dirty_count": gs["dirty_count"],
        "ahead": gs["ahead"], "behind": gs["behind"],
        "no_upstream": bool(remote) and not gs["has_upstream"] and not gs["detached"],
    }


def _git_fields(target: Path) -> dict:
    """The monitor's per-repo git fields for one repo — the same shape the
    dashboard cards read, recomputed live. Used by `git_action` (so the helper
    can hand fresh state back to the UI) and the bulk endpoints."""
    remote = git(["remote", "get-url", "origin"], target)
    fields = _git_state_fields(git_status_summary(target), remote)
    fields["stash_count"] = len(git(["stash", "list"], target).splitlines())
    return fields


def git_action(target: Path, action: str) -> dict:
    """Run ONE git management verb on ONE repo with the monitor's safety rules.
    The single source of truth shared by the `devhub git` CLI batch ops and the
    dashboard's helper endpoints, so both behave identically.

    Returns {ok, status, message, git} where `git` is the fresh `_git_fields`
    after the op and status ∈ done|noop|skipped|guidance|failed|error. Network
    ops go through git_run (non-interactive, can't hang on an auth prompt).
    """
    if action not in ("fetch", "pull", "push", "sync"):
        return {"ok": False, "status": "error",
                "message": f"unknown action: {action}", "git": {}}
    if not is_git_repo(target):
        return {"ok": False, "status": "error", "message": "not a git repo", "git": {}}

    def done(ok, status, message):
        return {"ok": ok, "status": status, "message": message,
                "git": _git_fields(target)}

    if action == "fetch":
        ok, msg = git_run(["fetch", "--quiet", "--prune"], target)
        return done(ok, "done" if ok else "failed",
                    "fetched" if ok else (_last_err(msg) or "fetch failed"))
    if action == "sync":
        ok, msg = git_run(["fetch", "--quiet", "--prune"], target)
        if not ok:
            return done(False, "failed", _last_err(msg) or "fetch failed")
        g = _git_fields(target)
        if g["dirty"] or g["no_upstream"] or g["detached"]:
            return done(True, "done", "fetched (pull skipped: dirty / no upstream)")
        ok, msg = git_run(["pull", "--ff-only", "--quiet"], target)
        return done(ok, "done" if ok else "failed",
                    "synced" if ok else (_last_err(msg) or "sync failed"))
    f = _git_fields(target)   # decision inputs (dirty / ahead / no_upstream)
    if action == "pull":
        if f["dirty"]:
            return done(True, "skipped", "skipped: uncommitted changes")
        if f["no_upstream"] or f["detached"]:
            return done(True, "skipped", "skipped: no upstream")
        ok, msg = git_run(["pull", "--ff-only", "--quiet"], target)
        return done(ok, "done" if ok else "failed",
                    "pulled" if ok else (_last_err(msg) or "pull failed"))
    if action == "push":
        if f["detached"]:
            return done(True, "skipped", "skipped: detached HEAD")
        if f["no_upstream"]:
            return done(True, "guidance",
                        f"no upstream — git push -u origin {f['branch'] or 'HEAD'}")
        if not f["ahead"]:
            return done(True, "noop", "nothing to push")
        ok, msg = git_run(["push", "--quiet"], target)
        return done(ok, "done" if ok else "failed",
                    f"pushed {f['ahead']} commit(s)" if ok
                    else (_last_err(msg) or "push failed"))


def _last_err(msg: str) -> str:
    """Last non-empty line of git's combined output — the useful part of a
    failure (e.g. 'Not possible to fast-forward, aborting.')."""
    lines = [ln for ln in (msg or "").splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def _parse_owner(remote: str) -> str:
    """Extract the user/org from a git remote URL.

    Handles the shapes we see in the wild:
      git@github.com:owner/repo.git   →  "owner"
      https://github.com/owner/repo   →  "owner"
      ssh://git@gitlab.com/owner/repo →  "owner"
      git@gist.github.com:abc123.git  →  "abc123"  (single-segment scp; gist id)
    Returns "" when the remote is empty, unparseable, OR points at a local
    filesystem path (file:// or absolute path) — those have no GitHub-style
    owner and should not be classified by ownership.
    """
    if not remote:
        return ""
    r = remote.strip()
    # Local-path remotes (file:// or bare /Users/...): no owner. urlparse
    # would happily return "Users" as the first path segment otherwise.
    if r.startswith(("/", "file://", "./", "../")):
        return ""
    # scp-like ssh: git@host:owner/repo(.git) — capture up to a slash OR end.
    # The "or end" branch also covers single-segment scp like gist URLs.
    m = re.match(r"^[\w.-]+@[\w.-]+:([^/]+?)(?:\.git)?(?:/|$)", r)
    if m:
        return m.group(1)
    # https://host/owner/repo  or  ssh://user@host/owner/repo
    try:
        path = urlparse(r).path.lstrip("/")
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2:
            return parts[0]
    except Exception:
        pass
    return ""


def _is_mine(remote: str, login: str) -> bool:
    """A repo is 'yours' if it has no remote, or its origin's owner segment
    matches your login (case-insensitive, exact). With no configured login we
    treat everything as yours (no filtering).

    Uses _parse_owner so the substring-match foot-gun (login='eric' matching
    'github.com/americansolar/...') is gone. Falls back to substring only when
    the remote can't be parsed — that path was the old behavior, kept as a
    defensive backstop.
    """
    if not remote or not login:
        return True
    owner = _parse_owner(remote)
    if owner:
        return owner.lower() == login.lower()
    return login.lower() in remote.lower()


def days_since(date_str: str):
    if not date_str:
        return None
    try:
        d = dt.datetime.strptime(date_str[:10], "%Y-%m-%d").date()
        return (dt.date.today() - d).days
    except Exception:
        return None


def project_info(path: Path, category, login: str) -> dict:
    name = path.name
    pkg = _read_pkg(path)  # parse package.json once, share across detectors
    info = {
        "name": name,
        "path": str(path.relative_to(DEV_ROOT)),
        "category": category,
        "git": False,
        "remote": "",
        "branch": "",
        "last_commit_date": "",
        "last_commit_subject": "",
        "dirty": False,
        # git-monitor fields (defaults so non-git folders & the dashboard JS
        # always see them defined; refreshed below for real repos).
        "dirty_count": 0,
        "ahead": 0,
        "behind": 0,
        "no_upstream": False,
        "detached": False,
        "stash_count": 0,
        "language": detect_language(path),
        "description": read_description(path, pkg),
        "has_readme": any((path / n).exists() for n in README_NAMES),
        # `mine`/`owner` drive the dashboard's source filter & owner pill.
        # Default to mine=True so non-git folders and the no-login case keep
        # the existing "everything is yours" semantics from _is_mine.
        "mine": True,
        "owner": "",
    }
    # Folder timestamps: birthtime ≈ when the project was imported/cloned into
    # the workspace (macOS APFS); mtime ≈ last time its top-level contents
    # changed. Distinct from the git-aware "last activity" computed below.
    try:
        st = path.stat()
        info["modified"] = dt.date.fromtimestamp(st.st_mtime).isoformat()
        bt = getattr(st, "st_birthtime", None)
        info["created"] = dt.date.fromtimestamp(bt).isoformat() if bt else ""
    except Exception:
        info["modified"] = info["created"] = ""
    if is_git_repo(path):
        info["git"] = True
        info["remote"] = git(["remote", "get-url", "origin"], path)
        info["mine"] = _is_mine(info["remote"], login)
        info["owner"] = _parse_owner(info["remote"])
        gs = git_status_summary(path)   # one subprocess: branch+ahead/behind+dirty
        info.update(_git_state_fields(gs, info["remote"]))
        info["stash_count"] = len(git(["stash", "list"], path).splitlines())
        info["commit_count"] = git(["rev-list", "--count", "HEAD"], path)
        # One `log -5` feeds both the recent-commits list and the latest-commit
        # fields (avoids two extra `log -1` subprocesses per repo per scan).
        log = git(["log", "-5", "--format=%cs%x09%s"], path)
        recent = [
            {"date": ln.split("\t", 1)[0], "subject": ln.split("\t", 1)[1][:100]}
            for ln in log.splitlines() if "\t" in ln
        ]
        info["recent_commits"] = recent
        info["last_commit_date"] = recent[0]["date"] if recent else ""
        info["last_commit_subject"] = recent[0]["subject"] if recent else ""
        info["last_activity"] = info["last_commit_date"]
    else:
        info["last_activity"] = info["modified"]
    info["stale_days"] = days_since(info.get("last_activity", ""))
    dtgt = detect_deploy_targets(path, pkg)
    info["deployed"] = dtgt["url"]
    info["deploy_method"] = dtgt["method"]
    info["dev"] = detect_dev_url(path, pkg)
    return info


# --------------------------------------------------------------------------- #
# classification (the self-evolving brain)
# --------------------------------------------------------------------------- #
def score_categories(hay: str, cfg: dict, markers: str = "", remote: str = "") -> dict:
    """Score every category against a lowercase haystack of text."""
    hay = hay.lower()
    remote = remote.lower()
    scores: dict[str, int] = {}
    for cat, meta in cfg["categories"].items():
        score = 0
        for kw in meta.get("keywords", []):
            if kw.lower() in hay:
                score += 2 if " " in kw else 1
        # Optional taxonomy-driven boosts (categories.json): `marker_boosts`
        # match against build-file markers, `remote_keywords` against the git
        # remote URL. Data, not code, so renaming a category keeps its rules.
        for mk in meta.get("marker_boosts", []):
            if mk.lower() in markers:
                score += 3
        for rk in meta.get("remote_keywords", []):
            if rk.lower() in remote:
                score += 3
        if score:
            scores[cat] = score
    return scores


def classify(path: Path, cfg: dict):
    """Return (category_or_None, scores) for a project folder on disk."""
    name = path.name
    overrides = cfg.get("overrides", {})
    if name in overrides:
        return overrides[name], {overrides[name]: 999}
    remote = git(["remote", "get-url", "origin"], path) if is_git_repo(path) else ""
    desc = read_description(path)
    markers = " ".join(m for m, _ in LANG_MARKERS if (path / m).exists())
    if any((path / c).exists() for c in COMPOSE_FILES):
        markers += " docker-compose"
    hay = " ".join([name, remote, desc, markers])
    scores = score_categories(hay, cfg, markers, remote)
    if not scores:
        return None, {}
    return max(scores, key=scores.get), scores


# --------------------------------------------------------------------------- #
# URL handling for `import`
# --------------------------------------------------------------------------- #
def url_kind(src: str) -> str:
    s = src.strip()
    if re.match(r"^(git@|ssh://|git://)", s):
        return "repo"
    if re.search(r"(?:^|//|\.)(youtube\.com|youtu\.be)\b", s, re.I):
        return "youtube"
    if re.match(r"^https?://(?:www\.)?(?:github|gitlab|bitbucket)\.(?:com|org)"
                r"/[^/]+/[^/]+/?(?:\.git)?$", s, re.I):
        return "repo"
    if s.endswith(".git"):
        return "repo"
    if re.match(r"^https?://", s, re.I):
        return "link"
    return "path"


def fetch_title(url: str, kind: str) -> str:
    """Best-effort title fetch. Returns '' on any failure (offline-safe)."""
    try:
        import urllib.parse
        if kind == "youtube":
            o = ("https://www.youtube.com/oembed?format=json&url="
                 + urllib.parse.quote(url, safe=""))
            req = urllib.request.Request(o, headers={"User-Agent": "devhub"})
            with urllib.request.urlopen(req, timeout=8) as r:
                return (json.load(r).get("title") or "").strip()
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 devhub"})
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read(200000).decode("utf-8", "ignore")
        m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
        if m:
            return html.unescape(re.sub(r"\s+", " ", m.group(1)).strip())
    except Exception:
        return ""
    return ""


def safe_filename(s: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|]+", " ", s).strip()
    s = re.sub(r"\s+", " ", s)
    return (s[:80].rstrip(". ") or "link")


def derived_title(url: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", url).rstrip("/")[:80]


def add_reference(url: str, kind: str, cfg: dict, title=None, category=None):
    title = (title or "").strip() or fetch_title(url, kind) or derived_title(url)
    fallback = False
    if not category:
        scores = score_categories(title + " " + url, cfg)
        if scores:
            category = max(scores, key=scores.get)
        else:
            category = "notes"
            fallback = True
    refs = [r for r in load_refs() if r.get("url") != url]
    rid = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]
    new_ref = {
        "id": rid, "type": kind, "url": url, "title": title,
        "category": category, "added": dt.date.today().isoformat(),
    }
    # auto-link: topic cluster + project attachment
    topic_key, matched = find_topic(title, url, refs)
    if topic_key:
        new_ref["topic"] = topic_key
        if matched is not None and not matched.get("topic"):
            matched["topic"] = topic_key
    project_names = _all_project_names(cfg)
    pm = detect_project_match(title, url, project_names)
    if pm:
        new_ref["project"] = pm
    refs.append(new_ref)
    save_refs(refs)
    cat_dir = REFS_DIR / category
    cat_dir.mkdir(parents=True, exist_ok=True)
    webloc = cat_dir / (safe_filename(title) + ".webloc")
    webloc.write_text(WEBLOC_TEMPLATE.format(url=html.escape(url)), encoding="utf-8")
    return category, fallback, title, webloc


# --------------------------------------------------------------------------- #
# scanning
# --------------------------------------------------------------------------- #
def known_categories(cfg: dict) -> list:
    return list(cfg["categories"].keys())


def _iter_projects(cfg: dict):
    """Yield (category, project_dir) for every project folder inside every
    known category — the single home of the walk rule (dirs only, dot-names
    skipped). Does NOT include pinned top-level projects; name→path lookups
    that must see those go through `_find_project_path`."""
    for cat in known_categories(cfg):
        cdir = DEV_ROOT / cat
        if not cdir.is_dir():
            continue
        for child in sorted(cdir.iterdir(), key=lambda p: p.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                yield cat, child


def _all_project_names(cfg: dict) -> list:
    return [child.name for _, child in _iter_projects(cfg)]


def _pinned_top_level(cfg: dict) -> dict:
    """name -> Path for override-pinned projects living at DEV_ROOT/<name>
    (i.e. not already inside their category folder). Lets the toolkit folder
    itself, or any root-level utility, appear as a real card under its
    category without being moved. Shared by build_manifest and the ports
    handlers so both see the same project set."""
    cats = set(known_categories(cfg))
    out = {}
    for nm, dest in cfg.get("overrides", {}).items():
        if dest not in cats:
            continue
        top = DEV_ROOT / nm
        if (top.is_dir() and top.parent == DEV_ROOT
                and not (DEV_ROOT / dest / nm).exists()):
            out[nm] = top
    return out


def _attach_relations(manifest: dict, refs: list) -> None:
    """Attach `related` arrays to every project and ref from relations.json.

    Pure (no git, no disk writes): derives only from the manifest's projects,
    the refs list, and relations.json. Shared by both the full `build_manifest`
    scan and the fast `_quick_manifest_and_write` POST path so relation chips
    stay consistent across the two.
    """
    pairs = load_relations()
    adj: dict[str, set] = {}
    for a, b in pairs:
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    ref_by_id = {r["id"]: r for r in refs}

    def _resolve_id(item_id):
        kind, _, rest = item_id.partition(":")
        if kind == "project":
            for blk in manifest["categories"].values():
                for p in blk["projects"]:
                    if p["name"] == rest:
                        return {"type": "project", "name": p["name"],
                                "category": p["category"]}
            return {"type": "project", "name": rest, "missing": True}
        if kind == "ref":
            r = ref_by_id.get(rest)
            if r:
                return {"type": "ref", "id": r["id"],
                        "title": r.get("title", "") or r.get("url", ""),
                        "url": r["url"], "category": r.get("category", "")}
            return {"type": "ref", "id": rest, "missing": True}
        return None

    for blk in manifest["categories"].values():
        for p in blk["projects"]:
            p["related"] = [_resolve_id(o)
                            for o in sorted(adj.get(f"project:{p['name']}", []))]
    for r in refs:
        r["related"] = [_resolve_id(o)
                        for o in sorted(adj.get(f"ref:{r['id']}", []))]


_REF_NOTE_CACHE: dict = {}  # str(md path) -> (st_mtime, embedded note text)


def _attach_ref_notes(refs: list) -> None:
    """Attach `note_md` to any ref that has a sidecar markdown digest.

    A reference's `.webloc` may sit beside a same-stem `.md` file (e.g. a
    `/watch` summary persisted next to a saved video, written by the devhub
    skill). When present, its text is embedded on the ref so the dashboard can
    render it inline as a collapsible 'notes' section on the reference card and
    in a project's Related links. Pure (no git, no disk writes): derived only
    from the refs list + the files already on disk. Called from both
    `build_manifest` and the fast POST path so the two manifest paths stay
    consistent (mirrors `_attach_relations`).
    """
    cap = 64 * 1024  # generous guard; display height is bounded in CSS, not here
    for r in refs:
        cat = r.get("category") or ""
        title = r.get("title") or ""
        if not title:
            continue
        md = REFS_DIR / cat / (safe_filename(title) + ".md")
        try:
            st = md.stat()
        except OSError:
            continue
        cached = _REF_NOTE_CACHE.get(str(md))
        if cached and cached[0] == st.st_mtime:
            r["note_md"] = cached[1]
            continue
        try:
            text = md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        note = text[:cap] + ("\n\n… (truncated)" if len(text) > cap else "")
        _REF_NOTE_CACHE[str(md)] = (st.st_mtime, note)
        r["note_md"] = note


def build_manifest(cfg: dict, deep: bool = False) -> dict:
    cats = known_categories(cfg)
    ignore = set(cfg.get("ignore", []))
    stale_days = cfg.get("stale_days", 120)
    login = (cfg.get("github_login") or "").strip()

    _tags_db = load_tags()
    _notes_db = cfg.get("notes", {})
    _archived_set = set(cfg.get("archived", []))
    _favorites_set = set(cfg.get("favorites", []))
    _pinned_set = set(cfg.get("pinned", []))
    _health = load_health()
    # host_root lets the dashboard's local links (vscode://, file://, terminal,
    # copy-path) point at the user's real machine path even when this script is
    # run from a different mount (e.g. a sandbox). Falls back to the live root.
    host_root = (cfg.get("host_root") or str(DEV_ROOT)).rstrip("/")
    manifest = {
        "generated": dt.datetime.now().astimezone().replace(microsecond=0).isoformat(),
        "dev_root": host_root,
        "helper_port": int(cfg.get("helper_port", 7333)),
        "categories": {},
        "strays": [],
        "references": load_refs(),
        "stats": {},
    }

    total = dirty = stale = missing_readme = unpushed = no_upstream = 0
    by_cat = {}

    # Pinned top-level folders (see _pinned_top_level): appear as cards under
    # their override category without being moved.
    pinned: dict[str, list[Path]] = {}
    pinned_tops = _pinned_top_level(cfg)
    pinned_names = set(pinned_tops)
    for nm, top in pinned_tops.items():
        pinned.setdefault(cfg["overrides"][nm], []).append(top)

    # Gather every (category, folder) pair up front so project_info — ~5 git
    # subprocesses per repo — runs across repos in parallel (same worker count
    # as fetch_repos / health_check_urls) instead of strictly sequentially.
    children_by_cat: dict[str, list[Path]] = {cat: [] for cat in cats}
    for cat, child in _iter_projects(cfg):
        children_by_cat[cat].append(child)
    for cat, tops in pinned.items():
        have = {c.name for c in children_by_cat[cat]}
        children_by_cat[cat].extend(t for t in tops if t.name not in have)
    for children in children_by_cat.values():
        children.sort(key=lambda p: p.name.lower())
    pairs = [(cat, child) for cat in cats for child in children_by_cat[cat]]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        infos = ex.map(lambda cc: project_info(cc[1], cc[0], login), pairs)
        info_by_pair = {(c, ch.name): i for (c, ch), i in zip(pairs, infos)}

    for cat in cats:
        meta = cfg["categories"][cat]
        projects = []
        for child in children_by_cat[cat]:
            info = info_by_pair[(cat, child.name)]
            ov = cfg.get("links", {}).get(child.name, {})
            # Manual link entries (no `auto` flag) pin the deployed value and
            # freeze detection. `auto` entries are a durable cache that `build`
            # refreshes, so we keep the freshly-detected value here instead.
            if not ov.get("auto"):
                if ov.get("deployed") is not None:
                    info["deployed"] = ov["deployed"]
            # The dev URL always flows through the resolver so an assigned
            # `dev_port` (+ `dev_path`) — or a manual `dev` override — is what
            # the dashboard's Local dev button uses, matching the helper.
            info["dev"] = _resolved_dev_url(child, cfg, fallback=info["dev"])
            dep = (info.get("deployed") or "").strip()
            if dep and dep in _health:
                info["health"] = _health[dep]
            if deep:
                subs = discover_subprojects(child)
                if subs:
                    info["subprojects"] = subs
            info["tags"] = sorted(_tags_db.get(child.name, []))
            info["note"] = _notes_db.get(child.name, "")
            info["archived"] = child.name in _archived_set
            info["favorite"] = child.name in _favorites_set
            info["pinned"] = child.name in _pinned_set
            projects.append(info)
            total += 1
            if info["dirty"]:
                dirty += 1
            if info.get("ahead"):
                unpushed += 1
            if info.get("no_upstream"):
                no_upstream += 1
            if not info["has_readme"]:
                missing_readme += 1
            if info["stale_days"] is not None and info["stale_days"] > stale_days:
                stale += 1
        manifest["categories"][cat] = {
            "label": meta.get("label", cat),
            "blurb": meta.get("blurb", ""),
            "projects": projects,
        }
        by_cat[cat] = len(projects)

    for child in sorted(DEV_ROOT.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or child.name in cats or child.name in ignore:
            continue
        if child.name.startswith("."):
            continue
        if child.name in pinned_names:
            continue
        suggested, scores = classify(child, cfg)
        manifest["strays"].append({
            "name": child.name,
            "path": str(child.relative_to(DEV_ROOT)),
            "suggested_category": suggested,
            "scores": scores,
        })

    # Enrich references: auto-detect topic clusters + project attachments.
    refs = manifest["references"]
    project_names = []
    # build a map: deployed-domain -> project name (for domain-based attachment)
    deployed_by_domain = {}
    for blk in manifest["categories"].values():
        for p in blk["projects"]:
            project_names.append(p["name"])
            dep = (p.get("deployed") or "").strip()
            if dep:
                try:
                    host = (urlparse(dep).hostname or "").lower().removeprefix("www.")
                    if host:
                        deployed_by_domain[host] = p["name"]
                except Exception:
                    pass
    changed = False
    ref_tokens: dict = {}   # id(ref) -> token set, shared across find_topic calls
    for ref in refs:
        if not ref.get("project"):
            # 1) name match (full or sub-words)
            pm = detect_project_match(ref.get("title", ""), ref.get("url", ""),
                                       project_names)
            if not pm:
                # 2) deployed-domain match
                try:
                    rh = (urlparse(ref.get("url", "")).hostname or "").lower().removeprefix("www.")
                    if rh and rh in deployed_by_domain:
                        pm = deployed_by_domain[rh]
                except Exception:
                    pass
            if pm:
                ref["project"] = pm
                changed = True
        if not ref.get("topic"):
            key, other = find_topic(ref.get("title", ""), ref.get("url", ""),
                                     refs, exclude=ref, token_cache=ref_tokens)
            if key:
                ref["topic"] = key
                if other is not None and not other.get("topic"):
                    other["topic"] = key
                changed = True
    if changed:
        save_refs(refs)

    # Attach `related` arrays to every project and ref from relations.json,
    # then fold in any sidecar `.md` digests sitting beside a ref's `.webloc`.
    _attach_relations(manifest, refs)
    _attach_ref_notes(refs)

    archived_count = 0
    for blk in manifest["categories"].values():
        for p in blk["projects"]:
            if p.get("archived"):
                archived_count += 1
    manifest["stats"] = {
        "total": total,
        "by_category": by_cat,
        "dirty": dirty,
        "unpushed": unpushed,
        "no_upstream": no_upstream,
        "stale": stale,
        "missing_readme": missing_readme,
        "strays": len(manifest["strays"]),
        "references": len(manifest["references"]),
        "archived": archived_count,
        "stale_days_threshold": stale_days,
    }
    return manifest


def write_manifest(manifest: dict) -> None:
    with open(MANIFEST_PATH, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #
def cmd_scan(args):
    cfg = load_config()
    manifest = build_manifest(cfg)
    write_manifest(manifest)
    s = manifest["stats"]
    print(f"Scanned {s['total']} projects across "
          f"{len(manifest['categories'])} categories.")
    print(f"  dirty={s['dirty']}  unpushed={s.get('unpushed', 0)}  "
          f"no-upstream={s.get('no_upstream', 0)}  "
          f"stale(>{s['stale_days_threshold']}d)={s['stale']}  "
          f"missing-readme={s['missing_readme']}  strays={s['strays']}  "
          f"links={s['references']}")
    print(f"Manifest written to {MANIFEST_PATH}")
    return manifest


def _git_autostage_index() -> None:
    """Stage the regenerated index.html so it's ready to commit + push — the
    deploy workflow publishes the committed snapshot to devhub.beric.ca.

    Only stages when git ALREADY tracks index.html: never force-adds an
    ignored/untracked file, and stays a silent no-op if git is missing or this
    isn't a repo (keeps the tool portable). Opt out with `devhub index
    --no-stage`.
    """
    try:
        tracked = subprocess.run(
            ["git", "-C", str(HERE), "ls-files", "--error-unmatch", INDEX_PATH.name],
            capture_output=True, text=True,
        )
        if tracked.returncode != 0:
            return
        staged = subprocess.run(
            ["git", "-C", str(HERE), "add", "--", INDEX_PATH.name],
            capture_output=True, text=True,
        )
        if staged.returncode == 0:
            print(f"Staged {INDEX_PATH.name} — commit + push to deploy to devhub.beric.ca.")
    except Exception:
        pass  # auto-staging is a convenience; never let it break `index`


def cmd_index(args):
    manifest = cmd_scan(args)
    INDEX_PATH.write_text(render_dashboard(manifest), encoding="utf-8")
    print(f"Dashboard written to {INDEX_PATH}")
    print(f"Open it: file://{INDEX_PATH}")
    if not getattr(args, "no_stage", False):
        _git_autostage_index()


def cmd_build(args):
    """Deep refresh — the data half of the `/devhub build` skill workflow.

    Mines deploy configs + CI for deployment URLs, persists discovered URLs
    into `categories.json` as `auto` links (never clobbering manual ones),
    health-checks every live URL, discovers nested subprojects, regenerates
    the dashboard, then prints a JSON report telling the skill layer which
    projects are yours so it can author READMEs.
    """
    cfg = load_config()
    scope = getattr(args, "scope", None)
    do_check = not getattr(args, "no_check", False)
    include_vendored = getattr(args, "include_vendored", False)
    login = (cfg.get("github_login") or "").strip()
    cats = known_categories(cfg)
    links = cfg.setdefault("links", {})

    scope_kind = scope_val = None
    if scope:
        if scope in cats:
            scope_kind, scope_val = "category", scope
        elif any((DEV_ROOT / c / scope).is_dir() for c in cats):
            scope_kind, scope_val = "project", scope
        else:
            print(f"Scope '{scope}' is neither a known category nor a project.")
            return

    def in_scope(cat, name):
        if scope_kind is None:
            return True
        return cat == scope_val if scope_kind == "category" else name == scope_val

    targets: list = []   # effective deployed URLs to probe
    report: list = []    # per-project handoff for README authoring
    fetch_paths: list = []  # in-scope git repos to fetch (fresh ahead/behind)
    persisted = 0
    for cat in cats:
        cat_dir = DEV_ROOT / cat
        if not cat_dir.is_dir():
            continue
        for child in sorted(cat_dir.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            name = child.name
            if not in_scope(cat, name):
                continue
            pkg = _read_pkg(child)
            dtgt = detect_deploy_targets(child, pkg)
            dev = detect_dev_url(child, pkg)
            existing = links.get(name, {})
            manual = bool(existing) and not existing.get("auto")
            if not manual:
                # Auto-detection owns only deployed/dev/auto. Preserve keys set by
                # other commands (dev_port via `ports`, dev_path, dev_cmd) by
                # merging into the existing entry instead of replacing it — a plain
                # rebuild here used to silently drop assigned dev ports on every run.
                preserved = {k: v for k, v in existing.items()
                             if k not in ("deployed", "dev", "auto")}
                ne = dict(preserved)
                if dtgt["url"]:
                    ne["deployed"] = dtgt["url"]
                if dev:
                    ne["dev"] = dev
                # Keep the auto flag when detection contributed, or when this was
                # already an auto entry we're keeping alive for its preserved keys
                # (otherwise it would flip to a frozen manual entry next run).
                if dtgt["url"] or dev or (existing.get("auto") and preserved):
                    ne["auto"] = True
                if ne:
                    if links.get(name) != ne:
                        links[name] = ne
                        persisted += 1
                elif existing.get("auto"):
                    links.pop(name, None)
                    persisted += 1
            eff = existing.get("deployed") if manual else dtgt["url"]
            if eff:
                targets.append(eff)
            remote = (git(["remote", "get-url", "origin"], child)
                      if is_git_repo(child) else "")
            if remote:
                fetch_paths.append(child)
            report.append({
                "name": name, "category": cat,
                "path": str(child.relative_to(DEV_ROOT)),
                "remote": remote, "mine": _is_mine(remote, login),
                "has_readme": any((child / n).exists() for n in README_NAMES),
                "deployed": eff, "deploy_method": dtgt["method"],
            })
    save_config(cfg)

    # Pre-scan fetch so the deep build_manifest below computes live ahead/behind
    # (the only path that auto-fetches; scan/index stay offline by design).
    fetched = fetch_fail = 0
    if not getattr(args, "no_fetch", False) and fetch_paths:
        print(f"Fetching {len(fetch_paths)} repo(s) for ahead/behind…")
        fres = fetch_repos(fetch_paths)
        fetched = sum(1 for ok, _ in fres.values() if ok)
        fetch_fail = len(fres) - fetched

    health: dict = {}
    if do_check and targets:
        print(f"Health-checking {len(set(targets))} deployed URL(s)…")
        health = health_check_urls(targets)
        prior = load_health()
        prior.update(health)
        save_health(prior)

    manifest = build_manifest(cfg, deep=True)
    write_manifest(manifest)
    INDEX_PATH.write_text(render_dashboard(manifest, cfg), encoding="utf-8")

    sub_total = sum(len(p.get("subprojects", []))
                    for blk in manifest["categories"].values()
                    for p in blk["projects"])
    down = [u for u, h in health.items() if not h.get("ok")]
    mine = [r for r in report if r["mine"]]
    vendored = [r for r in report if not r["mine"]]
    readme_targets = report if include_vendored else mine

    print()
    print("devhub build\n============")
    print(f"projects scanned: {len(report)}"
          + (f"  (scope: {scope_val})" if scope_val else ""))
    print(f"nested subprojects discovered: {sub_total}")
    print(f"auto-links persisted/updated: {persisted}")
    if do_check:
        print(f"health: {len(health)} checked, {len(down)} down")
        for u in down:
            print(f"  ✗ {u}  ({health[u].get('status') or 'no response'})")
    else:
        print("health: skipped (--no-check)")
    if getattr(args, "no_fetch", False):
        print("fetch: skipped (--no-fetch)")
    elif fetch_paths:
        print(f"fetch: {fetched} ok"
              + (f", {fetch_fail} offline/auth-skipped" if fetch_fail else ""))
    print(f"yours: {len(mine)}   upstream/vendored: {len(vendored)}"
          + ("" if include_vendored else "  (vendored skipped for READMEs)"))
    print(f"Dashboard: file://{INDEX_PATH}")
    print()
    print("=== BUILD REPORT (JSON) ===")
    print(json.dumps({
        "readme_policy": "all-with-backup",
        "include_vendored": include_vendored,
        "skip_readmes": bool(getattr(args, "no_readmes", False)),
        "projects": readme_targets,
    }, indent=2))
    print("=== END BUILD REPORT ===")
    return manifest


# --- git monitoring + batch management -------------------------------------

def _git_repos_in_scope(manifest, kind, val):
    """Collect (category, project_dict, abs_path) for every git-backed project
    the scope selects, sorted by category then name."""
    repos = []
    for cat, blk in manifest["categories"].items():
        if kind == "category" and cat != val:
            continue
        for p in blk["projects"]:
            if not p.get("git"):
                continue
            if kind == "project" and p["name"] != val:
                continue
            repos.append((cat, p, DEV_ROOT / p["path"]))
    repos.sort(key=lambda r: (r[0], r[1]["name"].lower()))
    return repos


def _refresh_git(repos):
    """Recompute the cheap (local, no-network) git fields in place — used after
    a fetch so the printed ahead/behind reflects the just-updated remote refs."""
    for _cat, p, path in repos:
        fields = _git_state_fields(git_status_summary(path), p.get("remote") or "")
        fields["branch"] = fields["branch"] or p.get("branch", "")
        p.update(fields)


def _needs_attention(p):
    return bool(p.get("dirty") or p.get("ahead") or p.get("behind")
                or p.get("no_upstream") or p.get("detached") or p.get("stash_count"))


def _git_status_table(repos, only_dirty):
    rows = []
    for _cat, p, _path in repos:
        if only_dirty and not _needs_attention(p):
            continue
        ab = []
        if p.get("ahead"):
            ab.append(f"↑{p['ahead']}")
        if p.get("behind"):
            ab.append(f"↓{p['behind']}")
        flags = []
        if p.get("detached"):
            flags.append("detached")
        elif p.get("no_upstream"):
            flags.append("no-upstream")
        rows.append((
            p["name"],
            (p.get("branch") or "—")[:24],
            " ".join(ab) or "·",
            f"●{p['dirty_count']}" if p.get("dirty") else "·",
            f"⚑{p['stash_count']}" if p.get("stash_count") else "·",
            ", ".join(flags),
        ))
    headers = ("REPO", "BRANCH", "AHEAD/BEHIND", "DIRTY", "STASH", "FLAGS")
    if not rows:
        print("All clean — nothing needs attention." if only_dirty
              else "No git repos in scope.")
    else:
        cols = list(zip(*([headers] + rows)))
        w = [max(len(str(c)) for c in col) for col in cols]
        line = lambda r: "  ".join(str(c).ljust(w[i]) for i, c in enumerate(r))
        print(line(headers))
        print("  ".join("-" * x for x in w))
        for r in rows:
            print(line(r))
        print()
    dirty = sum(1 for _, p, _ in repos if p.get("dirty"))
    unpushed = sum(1 for _, p, _ in repos if p.get("ahead"))
    behind = sum(1 for _, p, _ in repos if p.get("behind"))
    noup = sum(1 for _, p, _ in repos if p.get("no_upstream"))
    print(f"{len(repos)} repo(s): {dirty} dirty, {unpushed} unpushed, "
          f"{behind} behind, {noup} no-upstream.")


def _git_batch_fetch(repos):
    print(f"Fetching {len(repos)} repo(s)…")
    res = fetch_repos([str(path) for _, _, path in repos])
    ok = 0
    for _cat, p, path in repos:
        r = res.get(str(path))
        if r and r[0]:
            ok += 1
        elif r:
            print(f"  ✗ {p['name']}: {_last_err(r[1]) or 'fetch failed'}")
    print(f"Fetched {ok}/{len(repos)}.\n")
    _refresh_git(repos)
    _git_status_table(repos, only_dirty=True)


def _git_apply(repos, action):
    """Run `action` on each repo through the shared `git_action` and print one
    line per repo keyed off its status. Returns the list of result dicts so the
    caller can tally / summarize."""
    out = []
    for _cat, p, path in repos:
        r = git_action(path, action)
        r["name"] = p["name"]
        st = r["status"]
        if st == "noop":
            pass  # nothing to do — stay quiet
        elif st == "done" and r["ok"]:
            print(f"  ✓ {p['name']}" + (f" ({r['message']})" if action == "push" else ""))
        elif st in ("skipped", "guidance"):
            print(f"  ⏭ {p['name']}: {r['message']}")
        else:
            print(f"  ✗ {p['name']}: {r['message']}")
        out.append(r)
    return out


def _git_tally(res, verb):
    done = sum(1 for r in res if r["status"] == "done" and r["ok"])
    skipped = sum(1 for r in res if r["status"] in ("skipped", "guidance"))
    failed = sum(1 for r in res if r["status"] == "failed")
    print(f"\n{verb} {done}, skipped {skipped}, failed {failed}.")


def _git_batch_sync(repos):
    print(f"Fetching {len(repos)} repo(s)…")
    fetch_repos([str(path) for _, _, path in repos])
    print("Fast-forwarding clean repos…")
    res = _git_apply(repos, "pull")   # post-fetch ff-only
    _git_tally(res, "Pulled")
    unpushed = [(r["name"], r["git"].get("ahead", 0))
                for r in res if r["git"].get("ahead")]
    if unpushed:
        print(f"\n{len(unpushed)} repo(s) have unpushed commits:")
        for nm, a in unpushed:
            print(f"  ↑{a} {nm}")
        print("Push them with: devhub git push")


def cmd_git(args):
    """Monitor + batch-manage every tracked repo in the workspace.

      devhub git [status] [SCOPE]   read-only state table (default)
      devhub git fetch   [SCOPE]    parallel non-interactive fetch, then re-show
      devhub git pull    [SCOPE]    fast-forward-only pull (skips dirty repos)
      devhub git push    [SCOPE]    push repos with unpushed commits + an upstream
      devhub git sync    [SCOPE]    fetch, then ff-only pull the clean ones

    SCOPE limits to a category or a single project (default: all repos).
    """
    cfg = load_config()
    manifest = build_manifest(cfg)
    write_manifest(manifest)
    # Scope against the manifest's real project set so pinned top-level repos
    # (e.g. _devhub itself) that don't live under a category folder still resolve.
    scope = getattr(args, "scope", None)
    kind = val = None
    if scope:
        names = {p["name"] for blk in manifest["categories"].values()
                 for p in blk["projects"]}
        if scope in known_categories(cfg):
            kind, val = "category", scope
        elif scope in names:
            kind, val = "project", scope
        else:
            print(f"Scope '{scope}' is neither a known category nor a project.")
            return
    repos = _git_repos_in_scope(manifest, kind, val)
    if not repos:
        print("No git repos in scope.")
        return
    action = getattr(args, "action", None) or "status"
    if action == "status":
        _git_status_table(repos, only_dirty=getattr(args, "dirty", False))
    elif action == "fetch":
        _git_batch_fetch(repos)
    elif action == "pull":
        _git_tally(_git_apply(repos, "pull"), "Pulled")
    elif action == "push":
        _git_tally(_git_apply(repos, "push"), "Pushed")
    elif action == "sync":
        _git_batch_sync(repos)


def cmd_doctor(args):
    cfg = load_config()
    manifest = build_manifest(cfg)
    write_manifest(manifest)
    thr = manifest["stats"]["stale_days_threshold"]
    print("devhub doctor\n=============")
    print(f"dev root: {DEV_ROOT}")
    s = manifest["stats"]
    print(f"projects: {s['total']}  |  categories: {len(manifest['categories'])}  "
          f"|  links: {s['references']}")
    print()

    def collect(pred):
        out = []
        for blk in manifest["categories"].values():
            for p in blk["projects"]:
                if pred(p):
                    out.append(p)
        return out

    def section(title, items, fmt):
        print(f"{title} ({len(items)})")
        print("  none" if not items else "", end="" if items else "\n")
        for p in items:
            print("  - " + fmt(p))
        print()

    section("Uncommitted changes", collect(lambda p: p["dirty"]),
            lambda p: f"{p['path']}  [{p['branch']}]")
    section("Unpushed commits", collect(lambda p: p.get("ahead")),
            lambda p: f"{p['path']}  [{p['branch']}]  ↑{p['ahead']}"
                      + (f" ↓{p['behind']}" if p.get("behind") else ""))
    section("No upstream (never pushed / no push target)",
            collect(lambda p: p.get("no_upstream")),
            lambda p: f"{p['path']}  [{p['branch']}]")
    section(f"Stale (no commit in >{thr}d)",
            collect(lambda p: p["stale_days"] is not None and p["stale_days"] > thr),
            lambda p: f"{p['path']}  ({p['stale_days']}d)")
    section("Missing README", collect(lambda p: not p["has_readme"]),
            lambda p: p["path"])

    dupes = duplicate_project_names(manifest)
    print(f"Duplicate project names ({len(dupes)})")
    if not dupes:
        print("  none")
    for name, paths in sorted(dupes.items()):
        print(f"  - {name}  ->  " + ", ".join(paths))
    print()
    if dupes:
        print("Tip: links, overrides, tags, notes and dev_port are all keyed by\n"
              "     project NAME, so these directories share one entry — including\n"
              "     one dev port. `devhub rename <name> <new>` separates them.")
    print()

    print(f"Strays / uncategorized ({len(manifest['strays'])})")
    if not manifest["strays"]:
        print("  none")
    for st in manifest["strays"]:
        print(f"  - {st['name']}  ->  suggested: "
              f"{st['suggested_category'] or '??? (no confident match)'}")
    print()
    if manifest["strays"]:
        print("Tip: `devhub import <stray>` files it, or `devhub move <stray> <cat>`.")


def cmd_classify(args):
    cfg = load_config()
    if args.path:
        target = (DEV_ROOT / args.path) if not os.path.isabs(args.path) else Path(args.path)
        target = target.resolve()
        if not target.is_dir():
            print(f"Not a directory: {target}")
            sys.exit(1)
        cat, scores = classify(target, cfg)
        print(f"{target.name}: suggested -> {cat or '??? (no confident match)'}")
        if scores:
            print("  scores: " + ", ".join(f"{k}={v}" for k, v in
                                            sorted(scores.items(), key=lambda kv: -kv[1])))
        return
    manifest = build_manifest(cfg)
    if not manifest["strays"]:
        print("No strays to classify. Everything is filed.")
        return
    for st in manifest["strays"]:
        scores = ", ".join(f"{k}={v}" for k, v in
                           sorted(st["scores"].items(), key=lambda kv: -kv[1])) or "—"
        print(f"{st['name']:<28} -> "
              f"{st['suggested_category'] or '??? (no confident match)':<14} ({scores})")


def _safe_dest(category: str, name: str) -> Path:
    dest = DEV_ROOT / category / name
    if dest.exists():
        print(f"Refusing to overwrite existing path: {dest.relative_to(DEV_ROOT)}")
        sys.exit(1)
    return dest


def cmd_import(args):
    cfg = load_config()
    src = args.source
    kind = url_kind(src)

    if kind in ("youtube", "link"):
        category, fallback, title, webloc = add_reference(
            src, kind, cfg, title=args.title, category=args.category)
        note = "  (no keyword match -> notes)" if fallback else ""
        print(f"Saved {kind} reference -> {category}/{note}")
        print(f"  {title}")
        print(f"  {webloc.relative_to(DEV_ROOT)}")
        cmd_index(args)
        return

    if kind == "repo":
        # Same core as the dashboard's create endpoint (_h_card_create), so the
        # clone hardening ("--" + leading-dash reject) covers both entry points.
        print(f"Cloning {src} ...")
        try:
            res = _h_card_create({"source": src, "name": args.name,
                                  "category": args.category})
        except ValueError as e:
            print(str(e))
            sys.exit(1)
        name, category = res["name"], res["category"]
    else:  # local folder path
        srcp = (DEV_ROOT / src) if not os.path.isabs(src) else Path(src)
        srcp = srcp.resolve()
        if not srcp.is_dir():
            print(f"Not a directory / unrecognized source: {srcp}")
            sys.exit(1)
        name = args.name or srcp.name
        category = args.category or classify(srcp, cfg)[0]
        if not category:
            print(f"Could not auto-classify '{name}'. Re-run with --category CAT.")
            sys.exit(1)
        dest = _safe_dest(category, name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(srcp), str(dest))
        cfg.setdefault("overrides", {})[name] = category
        save_config(cfg)

    print(f"Imported '{name}' -> {category}/  (override recorded)")
    cmd_index(args)


def cmd_move(args):
    cfg = load_config()
    name, category = args.project, args.category
    if category not in cfg["categories"]:
        print(f"Unknown category '{category}'. Known: {', '.join(cfg['categories'])}")
        sys.exit(1)
    src, _cat = _find_project_path(name, cfg)
    if src is None:
        print(f"Could not find project '{name}'.")
        sys.exit(1)
    if src.parent.name == category:
        print(f"'{name}' is already in {category}/.")
    else:
        dest = _safe_dest(category, name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        print(f"Moved '{name}' -> {category}/")
    cfg.setdefault("overrides", {})[name] = category
    save_config(cfg)
    print(f"Override recorded: {name} -> {category}")
    cmd_index(args)


def _category_cli(payload: dict) -> dict:
    """Run a category op through `_h_category_op` — the same core the
    dashboard's endpoint uses, so CLI and UI can't drift — translating
    ValueError to print + exit(1)."""
    try:
        return _h_category_op(payload)
    except ValueError as e:
        print(str(e))
        sys.exit(1)


def cmd_add_category(args):
    _category_cli({"op": "add", "name": args.name, "label": args.label,
                   "keywords": list(args.keywords)})
    print(f"Added category '{args.name}' ({args.label}) with "
          f"{len(args.keywords)} keyword(s). Folder created.")


def cmd_rename_category(args):
    _category_cli({"op": "rename", "old": args.old, "new": args.new})
    print(f"Renamed category '{args.old}' -> '{args.new}'.")
    cmd_index(args)


def cmd_delete_category(args):
    res = _category_cli({"op": "delete", "name": args.name,
                         "into": args.into or ""})
    for pname in res.get("moved", []):
        print(f"  moved {pname} -> {args.into}/")
    msg = f"Deleted category '{args.name}'"
    if args.into:
        msg += f" (contents migrated to {args.into}/)"
    print(msg)
    cmd_index(args)


def cmd_edit_category(args):
    payload = {"op": "edit", "name": args.name,
               "add_keyword": list(args.add_keyword or []),
               "rm_keyword": list(args.rm_keyword or [])}
    if args.label is not None:
        payload["label"] = args.label
    if args.blurb is not None:
        payload["blurb"] = args.blurb
    res = _category_cli(payload)
    if not res.get("changes"):
        print("No changes. Pass --label/--blurb/--add-keyword/--rm-keyword.")
        return
    print(f"Edited category '{args.name}': " + "; ".join(res["changes"]))


def cmd_set_link(args):
    cfg = load_config()
    links = cfg.setdefault("links", {})
    name = args.project
    if args.clear:
        links.pop(name, None)
        print(f"Cleared link overrides for '{name}'.")
    else:
        entry = links.get(name, {})
        if args.deployed is not None:
            entry["deployed"] = args.deployed
        if args.dev is not None:
            entry["dev"] = args.dev
        if getattr(args, "dev_cmd", None) is not None:
            if args.dev_cmd == "":
                entry.pop("dev_cmd", None)
            else:
                entry["dev_cmd"] = args.dev_cmd
        if not entry:
            print("Nothing to set. Pass --deployed URL, --dev URL, and/or "
                  "--dev-cmd (or --clear).")
            return
        links[name] = entry
        print(f"Set links for '{name}': {entry}")
    save_config(cfg)
    cmd_index(args)


# --------------------------------------------------------------------------- #
# helper handlers used by the cmd_serve POST endpoints
# --------------------------------------------------------------------------- #

# Config keys the dashboard's settings gear is allowed to write. This is the
# ONLY HTTP surface that mutates categories.json config, so the allowlist is
# deliberately tight: it reaches these scalar keys and nothing else — never
# `categories`, `overrides`, `links`, `ignore`, `archived`, or `notes`. Same
# localhost-only / origin-checked trust model as the other POST endpoints.
TERMINAL_APP_ROSTER = ["Terminal", "iTerm2", "Kitty", "Ghostty", "Alacritty"]
_CONFIG_INT_KEYS = {  # key -> (lo, hi) inclusive
    "helper_port": (1024, 65535),
    "stale_days": (1, 3650),
    "dev_port_base": (1024, 65535),
}
_CONFIG_STR_KEYS = {"github_login": 128, "host_root": 4096}  # key -> max length


def _config_block(cfg=None) -> dict:
    """The settings the gear menu exposes, read fresh from categories.json.
    Embedded into the dashboard (to populate the form) and echoed back by the
    save endpoint so the open page can update without a reload."""
    cfg = cfg if cfg is not None else load_config()
    return {
        "terminal_app": cfg.get("terminal_app", "Terminal") or "Terminal",
        "helper_port": int(cfg.get("helper_port", 7333)),
        "stale_days": int(cfg.get("stale_days", 120)),
        "dev_port_base": int(cfg.get("dev_port_base") or DEFAULT_DEV_PORT_BASE),
        "github_login": cfg.get("github_login", "") or "",
        "host_root": cfg.get("host_root", "") or "",
        "terminal_apps": TERMINAL_APP_ROSTER,
    }


class _HTTPError(Exception):
    """Raised by _h_* handlers to signal a specific HTTP status code. Caught
    in each /api/ports/* dispatch branch and turned into self._send(code, ...).
    ValueError stays the convention for plain 400 errors elsewhere; this
    extends that pattern without touching existing handlers."""
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _h_config_set(p):
    """Persist whitelisted config keys from the settings gear. payload may carry
    any subset of {terminal_app, helper_port, stale_days, dev_port_base,
    github_login, host_root}; any other key is rejected so this stays a tight
    surface that can never reach categories/overrides/links/etc."""
    if not isinstance(p, dict):
        raise ValueError("bad payload")
    allowed = {"terminal_app", *_CONFIG_INT_KEYS, *_CONFIG_STR_KEYS}
    unknown = set(p) - allowed
    if unknown:
        raise ValueError("unknown config key: " + ", ".join(sorted(unknown)))
    cfg = load_config()
    changed = {}
    if "terminal_app" in p:
        want = str(p["terminal_app"]).strip()
        match = next((a for a in TERMINAL_APP_ROSTER if a.lower() == want.lower()), None)
        if not match:
            raise ValueError("terminal_app must be one of: " + ", ".join(TERMINAL_APP_ROSTER))
        cfg["terminal_app"] = match
        changed["terminal_app"] = match
    for key, (lo, hi) in _CONFIG_INT_KEYS.items():
        if key not in p:
            continue
        try:
            val = int(p[key])
        except (TypeError, ValueError):
            raise ValueError(f"{key} must be an integer")
        if not (lo <= val <= hi):
            raise ValueError(f"{key} must be between {lo} and {hi}")
        cfg[key] = val
        changed[key] = val
    for key, maxlen in _CONFIG_STR_KEYS.items():
        if key not in p:
            continue
        val = str(p[key]).strip()
        if len(val) > maxlen:
            raise ValueError(f"{key} is too long (max {maxlen} chars)")
        cfg[key] = val
        changed[key] = val
    save_config(cfg)
    return {"config": _config_block(cfg), "changed": changed}


def _h_helper_restart():
    """Restart this helper via its LaunchAgent so values bound at startup
    (e.g. ``helper_port``) and any code edits to devhub.py reload. macOS-only,
    and only meaningful when the helper is managed by ``com.devhub.helper`` —
    a foreground ``devhub serve`` has no supervisor to respawn it.

    Schedules ``launchctl kickstart -k gui/<uid>/<AGENT_LABEL>`` on a short
    delay so the HTTP response flushes *before* this process is killed; the
    LaunchAgent then brings the helper back up with the new code/config.
    Same trust model as the other POSTs (localhost-only, origin-checked),
    plus it can only target the fixed LaunchAgent label — never an arbitrary
    process or service name.
    """
    if sys.platform != "darwin":
        raise ValueError("restart is macOS-only")
    probe = subprocess.run(["launchctl", "list", AGENT_LABEL], capture_output=True)
    if probe.returncode != 0:
        raise ValueError(
            "helper is not running under the com.devhub.helper LaunchAgent "
            "(no supervisor to respawn it) — restart it manually."
        )
    uid = os.getuid()

    def _kick():
        time.sleep(0.25)  # let the HTTP response flush before we get SIGKILL'd
        subprocess.run(
            ["launchctl", "kickstart", "-k", f"gui/{uid}/{AGENT_LABEL}"],
            capture_output=True,
        )

    threading.Thread(target=_kick, daemon=True).start()
    return {"method": "launchctl", "label": AGENT_LABEL}


def _h_card_tag(p):
    """Add/remove tags. payload: {project, add: [], remove: []}"""
    project = (p.get("project") or "").strip()
    cfg = load_config()
    if not project or _find_project_path(project, cfg)[0] is None:
        raise ValueError(f"unknown project '{project}'")
    add = [_normalize_tag(t) for t in (p.get("add") or []) if t.strip()]
    rm = [_normalize_tag(t) for t in (p.get("remove") or []) if t.strip()]
    tdb = load_tags()
    cur = set(tdb.get(project, []))
    cur.update(add)
    cur.difference_update(rm)
    if cur:
        tdb[project] = sorted(cur)
    else:
        tdb.pop(project, None)
    save_tags(tdb)
    return {"project": project, "tags": sorted(cur)}


def _h_card_note(p):
    """Set/clear note. payload: {project, text}"""
    project = (p.get("project") or "").strip()
    cfg = load_config()
    if not project or _find_project_path(project, cfg)[0] is None:
        raise ValueError(f"unknown project '{project}'")
    text = (p.get("text") or "").strip()
    notes = cfg.setdefault("notes", {})
    if text:
        notes[project] = text
    else:
        notes.pop(project, None)
    save_config(cfg)
    return {"project": project, "note": text}


def _h_card_flag(p, cfg_key, field):
    """Shared toggle for the simple project-flag lists in categories.json
    (archived / favorites / pinned). payload: {project, <field>: bool}"""
    project = (p.get("project") or "").strip()
    cfg = load_config()
    if not project or _find_project_path(project, cfg)[0] is None:
        raise ValueError(f"unknown project '{project}'")
    # Only a real JSON boolean toggles state — guards against {"archived":"false"}.
    want = p.get(field) is True
    arr = cfg.setdefault(cfg_key, [])
    if want and project not in arr:
        arr.append(project)
    elif not want and project in arr:
        arr.remove(project)
    save_config(cfg)
    return {"project": project, field: want}


def _h_card_archive(p):
    """Toggle archived. payload: {project, archived: bool}"""
    return _h_card_flag(p, "archived", "archived")


def _h_card_favorite(p):
    """Toggle favorite (★). payload: {project, favorite: bool}"""
    return _h_card_flag(p, "favorites", "favorite")


def _h_card_pin(p):
    """Toggle pinned (sorts to the top of its category). payload: {project, pinned: bool}"""
    return _h_card_flag(p, "pinned", "pinned")


def _h_card_move(p):
    """Move to another category. payload: {project, category}"""
    project = (p.get("project") or "").strip()
    # Block path traversal: this name feeds _find_project_path + shutil.move, so
    # "/", "\", or ".." would escape DEV_ROOT from a CORS-reachable POST. Unlike
    # _h_card_rename/_create (which mint NEW names via PROJECT_NAME_RE), move acts
    # on an EXISTING folder whose name may legitimately start with "_" (e.g.
    # _devhub) — so reject only traversal, not the full naming convention.
    if not project or "/" in project or "\\" in project or "\x00" in project or project in (".", ".."):
        raise ValueError("invalid project name")
    target = (p.get("category") or "").strip()
    cfg = load_config()
    if target not in cfg["categories"]:
        raise ValueError(f"unknown category '{target}'")
    src, cat = _find_project_path(project, cfg)
    if src is None:
        raise ValueError(f"project '{project}' not found")
    if cat == target:
        return {"project": project, "category": target, "moved": False}
    dst = DEV_ROOT / target / project
    if dst.exists():
        raise ValueError(f"destination already exists: {dst.relative_to(DEV_ROOT)}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    cfg.setdefault("overrides", {})[project] = target
    save_config(cfg)
    return {"project": project, "category": target, "moved": True}


def _h_card_rename(p):
    """Rename a project folder. payload: {project, new_name}"""
    old = (p.get("project") or "").strip()
    new = (p.get("new_name") or "").strip()
    if not PROJECT_NAME_RE.match(new):
        raise ValueError("invalid new name")
    cfg = load_config()
    src, _cat = _find_project_path(old, cfg)
    if src is None:
        raise ValueError(f"project '{old}' not found")
    dst = src.parent / new
    if dst.exists():
        raise ValueError("destination already exists")
    src.rename(dst)
    _rewrite_project_name(old, new, cfg)
    return {"old_name": old, "new_name": new}


def _h_card_create(p):
    """Create a project from a URL or local folder. payload: {source, category?, name?}"""
    source = (p.get("source") or "").strip()
    if not source:
        raise ValueError("source required")
    cfg = load_config()
    kind = url_kind(source)
    name = (p.get("name") or "").strip() or None
    category = (p.get("category") or "").strip() or None
    if category and category not in cfg["categories"]:
        raise ValueError(f"unknown category '{category}'")
    if kind in ("youtube", "link"):
        cat, _fb, title, _wp = add_reference(
            source, kind, cfg, title=(p.get("title") or None), category=category)
        return {"created": "reference", "category": cat, "title": title}
    if kind == "repo":
        derived = re.sub(r"\.git$", "", source.rstrip("/").split("/")[-1])
        nm = name or derived
        if not PROJECT_NAME_RE.match(nm or ""):
            raise ValueError("invalid project name")
        TMP_DIR.mkdir(exist_ok=True)
        tmp = TMP_DIR / nm
        if tmp.exists():
            shutil.rmtree(tmp)
        # "--" stops git option parsing: without it a CORS-reachable POST could
        # pass source="--upload-pack=…x.git" (url_kind→"repo") as a git flag,
        # turning clone into argv/option-injection. Belt-and-suspenders reject "-".
        if source.startswith("-"):
            raise ValueError("invalid repo source")
        r = subprocess.run(["git", "clone", "--depth", "50", "--", source, str(tmp)],
                           capture_output=True)
        if r.returncode != 0:
            raise ValueError("git clone failed: " + (r.stderr.decode("utf-8", "ignore")[:200]))
        cat = category or classify(tmp, cfg)[0]
        if not cat:
            raise ValueError("could not auto-classify; provide a category")
        dst = DEV_ROOT / cat / nm
        if dst.exists():
            raise ValueError(f"destination already exists: {dst.relative_to(DEV_ROOT)}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp), str(dst))
        try:
            TMP_DIR.rmdir()
        except OSError:
            pass
        cfg.setdefault("overrides", {})[nm] = cat
        save_config(cfg)
        return {"created": "project", "category": cat, "name": nm}
    raise ValueError(f"unsupported source kind: {kind}")


def _h_category_op(p):
    """Category-level operations. payload: {op: 'add'|'rename'|'delete'|'edit', ...}"""
    cfg = load_config()
    op = (p.get("op") or "").strip()
    if op == "add":
        name = (p.get("name") or "").strip()
        if not CATEGORY_KEY_RE.match(name):
            raise ValueError("invalid category key")
        if name in cfg["categories"]:
            raise ValueError("category exists")
        cfg["categories"][name] = {
            "label": p.get("label") or name,
            "blurb": p.get("blurb") or "",
            "keywords": list(p.get("keywords") or []),
        }
        save_config(cfg)
        (DEV_ROOT / name).mkdir(exist_ok=True)
        return {"op": "add", "name": name}
    if op == "rename":
        old, new = (p.get("old") or "").strip(), (p.get("new") or "").strip()
        if old not in cfg["categories"]:
            raise ValueError("unknown source category")
        if new in cfg["categories"] or not CATEGORY_KEY_RE.match(new):
            raise ValueError("invalid new name")
        cfg["categories"][new] = cfg["categories"].pop(old)
        old_dir = DEV_ROOT / old
        new_dir = DEV_ROOT / new
        if old_dir.is_dir():
            if new_dir.exists():
                raise ValueError("target folder already exists")
            old_dir.rename(new_dir)
        for proj, cat in list(cfg.get("overrides", {}).items()):
            if cat == old:
                cfg["overrides"][proj] = new
        refs = load_refs()
        for r in refs:
            if r.get("category") == old:
                r["category"] = new
        save_refs(refs)
        old_refs_dir = REFS_DIR / old
        new_refs_dir = REFS_DIR / new
        if old_refs_dir.is_dir():
            if new_refs_dir.exists():
                for f in old_refs_dir.iterdir():
                    shutil.move(str(f), str(new_refs_dir / f.name))
                try:
                    old_refs_dir.rmdir()
                except OSError:
                    pass
            else:
                old_refs_dir.rename(new_refs_dir)
        save_config(cfg)
        return {"op": "rename", "old": old, "new": new}
    if op == "delete":
        name = (p.get("name") or "").strip()
        into = (p.get("into") or "").strip() or None
        if name not in cfg["categories"]:
            raise ValueError("unknown category")
        cdir = DEV_ROOT / name
        inside = [c.name for c in cdir.iterdir()
                  if c.is_dir() and not c.name.startswith(".")] if cdir.is_dir() else []
        refs_in = [r for r in load_refs() if r.get("category") == name]
        if (inside or refs_in) and not into:
            raise ValueError("category not empty; provide 'into' to migrate")
        moved, skipped = [], []
        if into:
            if into not in cfg["categories"] or into == name:
                raise ValueError("bad 'into' target")
            tgt_dir = DEV_ROOT / into
            tgt_dir.mkdir(exist_ok=True)
            for pname in inside:
                s = cdir / pname
                d = tgt_dir / pname
                if d.exists():
                    skipped.append(pname)
                    continue
                shutil.move(str(s), str(d))
                cfg.setdefault("overrides", {})[pname] = into
                moved.append(pname)
            refs = load_refs()
            for r in refs:
                if r.get("category") == name:
                    r["category"] = into
            save_refs(refs)
            old_refs_dir = REFS_DIR / name
            new_refs_dir = REFS_DIR / into
            if old_refs_dir.is_dir():
                new_refs_dir.mkdir(parents=True, exist_ok=True)
                for f in old_refs_dir.iterdir():
                    if f.is_file():
                        d = new_refs_dir / f.name
                        if not d.exists():
                            shutil.move(str(f), str(d))
                try:
                    old_refs_dir.rmdir()
                except OSError:
                    pass
        if skipped:
            # Don't delete the taxonomy entry while projects are still
            # physically inside it — that would orphan them as strays with no
            # category. Persist the moves that did succeed, then refuse.
            save_config(cfg)
            raise ValueError(
                f"category '{name}' NOT deleted: could not migrate "
                + ", ".join(skipped)
                + f" (name collision in {into}/). Resolve and re-run.")
        for proj, cat in list(cfg.get("overrides", {}).items()):
            if cat == name:
                cfg["overrides"].pop(proj, None)
        cfg["categories"].pop(name)
        save_config(cfg)
        if cdir.is_dir():
            try:
                cdir.rmdir()
            except OSError:
                pass
        return {"op": "delete", "name": name, "into": into, "moved": moved}
    if op == "edit":
        name = (p.get("name") or "").strip()
        if name not in cfg["categories"]:
            raise ValueError("unknown category")
        meta = cfg["categories"][name]
        changes = []
        if "label" in p:
            meta["label"] = p["label"]
            changes.append(f"label='{p['label']}'")
        if "blurb" in p:
            meta["blurb"] = p["blurb"]
            changes.append(f"blurb='{p['blurb']}'")
        kws = list(meta.get("keywords", []))
        for k in (p.get("add_keyword") or []):
            k = (k or "").strip().lower()
            if k and k not in kws:
                kws.append(k)
                changes.append(f"+kw '{k}'")
        for k in (p.get("rm_keyword") or []):
            k = (k or "").strip().lower()
            if k in kws:
                kws.remove(k)
                changes.append(f"-kw '{k}'")
        meta["keywords"] = kws
        save_config(cfg)
        return {"op": "edit", "name": name, "changes": changes}
    raise ValueError(f"unknown category op '{op}'")


def _h_ports_state(cfg: dict) -> dict:
    """Per-project static row data for the /ports page. Live state comes from
    /api/dev/state separately. Returns every managed project (categorized +
    pinned top-level; archived included — the page filters them client-side).

    A port is "pinned" when it sits BELOW dev_port_base: assign_dev_ports
    starts at the base and increments upward, so anything below the base must
    have been hand-set (e.g. clms 5173 against base 6100).
    """
    base = int(cfg.get("dev_port_base") or DEFAULT_DEV_PORT_BASE)
    rows = [_ports_row(cfg, name, path, base)
            for name, path in _ports_projects(cfg)]
    rows.sort(key=lambda r: (r["dev_port"] is None, r["dev_port"] or 0, r["project"]))
    return {"ok": True, "dev_port_base": base, "rows": rows}


def _ports_projects(cfg: dict) -> list:
    """(name, path) for every project the ports page manages: categorized
    projects plus pinned top-level ones — the same set the manifest shows,
    derived without rebuilding the manifest."""
    out = [(child.name, child) for _, child in _iter_projects(cfg)]
    have = {n for n, _ in out}
    out.extend((nm, p) for nm, p in _pinned_top_level(cfg).items()
               if nm not in have)
    return out


def _ports_row(cfg: dict, name: str, path, base: int) -> dict:
    """The /ports `rows[]` entry shape — shared by the state endpoint and the
    single-row responses so they can't drift."""
    link = (cfg.get("links") or {}).get(name) or {}
    dev_port = link.get("dev_port")
    return {
        "project": name,
        "path": str(path) if path is not None else "",
        "dev_port": dev_port,
        "dev_path": link.get("dev_path") or "",
        "dev_cmd": link.get("dev_cmd") or "",
        "url": _resolved_dev_url(path, cfg) if path is not None else "",
        "pinned": isinstance(dev_port, int) and dev_port < base,
    }


def _row_for(cfg: dict, name: str) -> dict:
    """Single-row shape matching _h_ports_state's `rows[]` entries."""
    base = int(cfg.get("dev_port_base") or DEFAULT_DEV_PORT_BASE)
    path, _cat = _find_project_path(name, cfg)
    return _ports_row(cfg, name, path if path is not None else DEV_ROOT, base)


def _h_ports_set(p: dict, *, registry=None, stop_fn=None, restart_fn=None) -> dict:
    """Apply whitelisted edits to links.<project>: dev_port / dev_path / dev_cmd.
    Cross-project port uniqueness is enforced server-side; binding conflicts
    with non-managed processes on the machine surface naturally at launch via
    Vite's --strictPort.

    Atomicity contract — when called with `registry`/`stop_fn`/`restart_fn`
    from the helper (`cmd_serve` passes them so this handler can access the
    closure-scoped DevRegistry and launch helpers): if the project is
    currently running on its old `dev_port` and the request changes that
    port, stop the running server BEFORE persisting the new port. If stop
    raises, propagate the error and DO NOT mutate the config — the project
    keeps running on its old port. After config is saved, attempt a
    relaunch via `restart_fn`. The `restarted` flag in the response
    reflects intent ("we decided to restart"), not the relaunch subprocess
    outcome — that way the contract is observable in tests that don't
    actually spawn a Terminal. Path/cmd-only edits never trigger restart.
    """
    name = (p or {}).get("project") or ""
    if not isinstance(name, str) or not PROJECT_NAME_RE.match(name):
        raise _HTTPError(400, "invalid project name")
    cfg = load_config()
    # Same resolver the card handlers use to validate a managed project name.
    if _find_project_path(name, cfg)[0] is None:
        raise _HTTPError(404, f"unknown project {name!r}")

    links = cfg.setdefault("links", {})
    link = links.setdefault(name, {})
    old_port = link.get("dev_port")

    # --- Validation phase: raise BEFORE any mutation so failed validation
    # leaves cfg untouched (atomicity).
    new_port_requested = "dev_port" in p
    new_port = p.get("dev_port") if new_port_requested else old_port
    if new_port_requested and new_port is not None:
        if not isinstance(new_port, int) or not (1024 <= new_port <= 65535):
            raise _HTTPError(400, "dev_port must be int in [1024, 65535]")
        for other, ol in links.items():
            if other != name and ol.get("dev_port") == new_port:
                raise _HTTPError(409, f"port {new_port} is already used by {other}")

    new_path = p.get("dev_path")
    if "dev_path" in p and new_path:
        if not isinstance(new_path, str) or not new_path.startswith("/"):
            raise _HTTPError(400, "dev_path must start with /")
        if "://" in new_path or new_path.startswith("//"):
            raise _HTTPError(400, "dev_path must be a path, not a URL")
        if len(new_path) > 200:
            raise _HTTPError(400, "dev_path too long (max 200 chars)")

    new_cmd = p.get("dev_cmd")
    if "dev_cmd" in p and new_cmd:
        if not isinstance(new_cmd, str) or len(new_cmd) > 500:
            raise _HTTPError(400, "dev_cmd too long (max 500 chars)")

    # --- Decide whether to auto-restart. Only a dev_port change on a
    # currently-running project triggers it; dev_path/dev_cmd don't affect
    # port binding.
    port_change = new_port_requested and new_port != old_port
    running_before = bool(registry and registry.get(name)) if registry else False
    will_restart = bool(running_before and port_change and stop_fn and restart_fn)

    # Stop FIRST so a failure aborts before the config is written.
    if will_restart:
        stop_fn(name)  # propagates _HTTPError / ValueError; cfg untouched.

    # --- Apply edits.
    if new_port_requested:
        if new_port is not None:
            link["dev_port"] = new_port
        else:
            link.pop("dev_port", None)

    if "dev_path" in p:
        if new_path:
            link["dev_path"] = new_path
        else:
            link.pop("dev_path", None)

    if "dev_cmd" in p:
        if new_cmd:
            link["dev_cmd"] = new_cmd
        else:
            link.pop("dev_cmd", None)

    save_config(cfg)

    # --- Relaunch on the new port. The relaunch is best-effort: if the
    # subprocess fails we still return restarted=True because the *intent*
    # was honored — config now reflects the new port and the user can hit
    # Start manually if needed.
    if will_restart:
        try:
            restart_fn(name)
        except Exception as e:
            print(f"devhub helper ports/set restart error: {e}", file=sys.stderr)

    # Re-derive the row from the just-saved cfg so the response reflects
    # canonical state (mirrors the post-write pattern in /api/config:2788).
    out = {"ok": True, "row": _row_for(cfg, name)}
    if will_restart:
        out["restarted"] = True
    return out


def _h_ports_assign_missing() -> dict:
    """Run assign_dev_ports on every managed project missing dev_port.
    Returns the list of (project, port) pairs newly assigned. Idempotent."""
    cfg = load_config()
    names = [n for n, _ in _ports_projects(cfg)]
    before = {n: ((cfg.get("links") or {}).get(n) or {}).get("dev_port") for n in names}
    changed = assign_dev_ports(cfg, names)  # mutates cfg in place, returns list of names
    if changed:
        save_config(cfg)
    assigned = []
    for n in changed:
        new_port = ((cfg.get("links") or {}).get(n) or {}).get("dev_port")
        if new_port is not None and before.get(n) != new_port:
            assigned.append({"project": n, "port": new_port})
    return {"ok": True, "assigned": assigned}


def _h_ports_detect_cmd(p: dict) -> dict:
    """Suggest a dev_cmd for `project` by running the existing
    detect_dev_command. Read-only; never mutates config."""
    name = (p or {}).get("project") or ""
    if not isinstance(name, str) or not PROJECT_NAME_RE.match(name):
        raise _HTTPError(400, "invalid project name")
    cfg = load_config()
    target, _cat = _find_project_path(name, cfg)
    if target is None:
        raise _HTTPError(404, f"unknown project {name!r}")
    # detect_dev_command's signature is (path: Path, cfg=None) -> str (devhub.py:549).
    # It returns a plain string; synthesize the source field by inspecting why.
    cmd = detect_dev_command(target, cfg) or ""
    link = (cfg.get("links") or {}).get(name) or {}
    if (link.get("dev_cmd") or "").strip() == cmd.strip() and cmd:
        source = "override"
    elif cmd and any(token in cmd for token in ("npm run", "bun run", "yarn ", "pnpm ")):
        source = "package_json"
    else:
        source = "fallback"
    return {"ok": True, "cmd": cmd, "source": source}


def _h_ports_clear(p: dict) -> dict:
    """Drop dev_port/dev_path/dev_cmd for a project. Leaves dev/deployed
    untouched (those are URL overrides, not port assignments)."""
    name = (p or {}).get("project") or ""
    if not isinstance(name, str) or not PROJECT_NAME_RE.match(name):
        raise _HTTPError(400, "invalid project name")
    cfg = load_config()
    if _find_project_path(name, cfg)[0] is None:
        raise _HTTPError(404, f"unknown project {name!r}")
    link = (cfg.get("links") or {}).get(name)
    if link:
        for k in ("dev_port", "dev_path", "dev_cmd"):
            link.pop(k, None)
        # If the link entry now has no useful keys, drop the entry entirely so
        # categories.json stays tidy. (`auto` alone is not useful.)
        if not link or set(link.keys()) <= {"auto"}:
            cfg["links"].pop(name, None)
        save_config(cfg)
    return {"ok": True, "row": _row_for(cfg, name)}


def _shq(s) -> str:
    """POSIX single-quote a string for safe embedding in a shell command."""
    return "'" + str(s).replace("'", "'\\''") + "'"


def _terminal_run_script(term_app: str, workdir: Path, command: str):
    """argv that opens `term_app` and runs `command` in `workdir`.

    Terminal.app and iTerm are driven via AppleScript ``do script``. The GPU
    terminals (Kitty, Ghostty, Alacritty) have no AppleScript surface, so they
    are launched via ``open -na <app> --args …`` running an *interactive*
    *login* shell so the dev script inherits the user's PATH. ``-i`` is
    essential -- bun/nvm/etc. typically add themselves in ``.zshrc``, which
    a login non-interactive shell (``-lc``) skips; the terminal emulator
    allocates a pty for the shell, so interactive mode is fine. Returns None
    for any unrecognised app so the caller can fall back to just opening the
    folder.
    """
    shell_text = "cd {} && {}".format(_shq(workdir), command)
    low = term_app.lower()
    if low in ("iterm", "iterm2", "iterm.app", "terminal", "terminal.app"):
        # AppleScript string literal: escape backslashes then double-quotes.
        asc = shell_text.replace("\\", "\\\\").replace('"', '\\"')
        if low.startswith("iterm"):
            script = ('tell application "iTerm"\n'
                      ' activate\n'
                      ' set w to (create window with default profile)\n'
                      ' tell current session of w to write text "%s"\n'
                      'end tell' % asc)
        else:
            script = ('tell application "Terminal"\n'
                      ' activate\n'
                      ' do script "%s"\n'
                      'end tell' % asc)
        return ["osascript", "-e", script]
    shell = os.environ.get("SHELL") or "/bin/zsh"
    if low in ("kitty", "kitty.app"):
        # --hold keeps the window open if the dev command exits.
        return ["open", "-na", "kitty", "--args", "--hold", shell, "-ilc", shell_text]
    if low in ("ghostty", "ghostty.app"):
        return ["open", "-na", "Ghostty", "--args", "-e", shell, "-ilc", shell_text]
    if low in ("alacritty", "alacritty.app"):
        return ["open", "-na", "Alacritty", "--args", "-e", shell, "-ilc", shell_text]
    return None


def _project_relpath(name: str, cfg: dict) -> str:
    """category/name for a known project, or just name if top-level."""
    path, _cat = _find_project_path(name, cfg)
    return str(path.relative_to(DEV_ROOT)) if path is not None else name


def _all_git_projects(cfg: dict) -> list:
    """Folder names of every categorized git repo — the candidate set for the
    dashboard's bulk 'Fetch all' / 'Sync all'. The endpoint re-validates each
    name (known_project + owner + path-in-root) before touching it."""
    return sorted((child.name for _, child in _iter_projects(cfg)
                   if is_git_repo(child)), key=str.lower)


def _list_dir(d: Path) -> list:
    """Read-only, filtered directory listing for the dashboard file explorer.

    Returns ``{name, dir, path}`` dicts (path relative to DEV_ROOT, like the
    manifest), folders first then files, each alphabetical. Skips dot-entries
    and the same heavy build/vendor dirs the deep scan ignores. Used only by
    the localhost helper's read-only ``/api/files`` endpoint.
    """
    dirs: list = []
    files: list = []
    try:
        children = list(d.iterdir())
    except Exception:
        return []
    for c in children:
        name = c.name
        if name.startswith("."):
            continue
        try:
            is_dir = c.is_dir()
        except OSError:
            continue
        if is_dir:
            if name in DEEP_SCAN_IGNORE:
                continue
            dirs.append(name)
        else:
            files.append(name)
    dirs.sort(key=str.lower)
    files.sort(key=str.lower)
    out = [{"name": n, "dir": True, "path": str((d / n).relative_to(DEV_ROOT))}
           for n in dirs]
    out += [{"name": n, "dir": False, "path": str((d / n).relative_to(DEV_ROOT))}
            for n in files]
    return out


class DevRegistry:
    """Thread-safe store of running dev servers, persisted to running.json.

    Shape: {project: {port, pid, url, started_at, source}}. A single lock
    guards both the in-memory dict and the read-modify-write of the JSON file
    so the ThreadingHTTPServer can't race or TOCTOU.
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict:
        try:
            return json.loads(RUNNING_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _flush(self):
        try:
            RUNNING_PATH.write_text(json.dumps(self._data, indent=2) + "\n",
                                    encoding="utf-8")
        except Exception as e:
            print(f"devhub registry flush error: {e}", file=sys.stderr)

    def set(self, project, *, port, pid=None, url="", source="devhub"):
        with self._lock:
            self._data[project] = {
                "port": int(port), "pid": pid, "url": url,
                "started_at": dt.datetime.now().astimezone()
                    .replace(microsecond=0).isoformat(),
                "source": source,
            }
            self._flush()

    def remove(self, project):
        with self._lock:
            if self._data.pop(project, None) is not None:
                self._flush()

    def get(self, project):
        with self._lock:
            return dict(self._data[project]) if project in self._data else None

    def snapshot(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._data))

    def reconcile(self, is_alive, grace: float = 20.0) -> None:
        """Drop entries whose port is no longer listening, so the dashboard
        never shows a phantom 'running' server. `is_alive(port) -> bool` probes
        liveness. Entries started within `grace` seconds are kept even if not
        yet listening, so a cold-starting server isn't pruned before it binds.
        """
        now = dt.datetime.now().astimezone()
        with self._lock:
            dead = []
            for name, e in self._data.items():
                if is_alive(int(e.get("port") or 0)):
                    continue
                try:
                    age = (now - dt.datetime.fromisoformat(e["started_at"])).total_seconds()
                except Exception:
                    age = grace + 1  # unparseable timestamp -> treat as old
                if age > grace:
                    dead.append(name)
            for name in dead:
                del self._data[name]
            if dead:
                self._flush()


def cmd_serve(args):
    """Run a localhost-only helper so dashboard buttons can launch apps.

    Endpoints (GET):
      /open?action=terminal|finder|vscode&path=<abs path>
      /open?action=dev&path=<abs path>  -> start the project's dev server
      /open?action=devstatus&path=<abs path>  -> read-only: is the dev port up?
    POST /api/cards/<verb> for inline CRUD from the dashboard.

    Only paths inside the dev root are allowed. The `dev` action runs a
    command *templated server-side* from package.json / the categories.json
    `dev_cmd` override -- the request carries no command bytes, so this keeps
    the same trust model as `terminal` (it can only run the user's own dev
    script in their own dev root, the same thing the Terminal button already
    lets them do by hand). It is idempotent: if the dev port is already
    listening it skips the launch.
    """
    import http.server
    import urllib.parse
    import subprocess as sp

    cfg = load_config()
    port = int(getattr(args, "port", None) or cfg.get("helper_port", 7333))
    # Read the terminal app fresh per use (not captured once here) so the
    # settings gear's "terminal app" change takes effect without restarting
    # the helper.
    def _term_app():
        return load_config().get("terminal_app", "Terminal") or "Terminal"
    root = DEV_ROOT.resolve()
    is_mac = sys.platform == "darwin"

    registry = DevRegistry()
    registry.reconcile(_port_listening)  # prune servers that died since last run

    def _trusted_origins():
        """Extra origins the user opted into via categories.json
        `trusted_origins` (e.g. `https://devhub.beric.ca` for a self-hosted
        copy of the dashboard). Hand-edited only — never exposed through the
        /api/config write endpoint, so a remote dashboard can't grant trust
        to other origins. Reloaded per request so edits take effect without
        restarting the helper. Each entry is matched against the Origin
        header byte-for-byte (scheme+host+optional-port, no trailing slash)."""
        raw = load_config().get("trusted_origins") or []
        if not isinstance(raw, list):
            return frozenset()
        return frozenset(s for s in raw
                         if isinstance(s, str)
                         and s.startswith(("http://", "https://"))
                         and "/" not in s.split("://", 1)[1])

    def known_project(name: str) -> bool:
        if not PROJECT_NAME_RE.match(name or ""):
            return False
        return _find_project_path(name, cfg)[0] is not None

    def _spawn_dev(name, target, devcmd, port, dev_url, fallback_open=True):
        """Single home of the dev-server launch contract: port env prefix +
        build_launch_command + Terminal spawn + registry record. Returns True
        when the command was scripted into a terminal; False when the terminal
        app isn't AppleScript-scriptable (optionally opening it at the folder
        so the client can surface the command instead)."""
        launch_cmd = (build_launch_command(devcmd, port, Path(target))
                      if port else devcmd)
        run_cmd = (f"{dev_env_prefix(name, port)} {launch_cmd}"
                   if port else launch_cmd)
        argv = _terminal_run_script(_term_app(), target, run_cmd)
        scripted = argv is not None
        if scripted:
            sp.Popen(argv)
        elif fallback_open:
            sp.Popen(["open", "-a", _term_app(), str(target)])
        else:
            return False   # nothing spawned — don't record a phantom server
        if port:
            registry.set(name, port=port, pid=None, url=dev_url, source="devhub")
        return scripted

    def cmd_for(action, target):
        return {
            "terminal": ["open", "-a", _term_app(), str(target)],
            "finder": ["open", str(target)],
            "vscode": ["open", "-a", "Visual Studio Code", str(target)],
        }.get(action)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _allow_origin(self):
            # The dashboard is loaded from file:// (Origin "null"); also permit
            # the helper's own localhost origins, plus any origin the user
            # opted into via categories.json `trusted_origins` (e.g. their own
            # self-hosted dashboard). Never reflect an unrecognized origin.
            origin = self.headers.get("Origin", "")
            if origin == "null" or origin.startswith(("http://127.0.0.1",
                                                       "http://localhost")):
                return origin
            if origin and origin in _trusted_origins():
                return origin
            return "null"

        def _origin_ok(self):
            # Reject requests carrying a real foreign web origin so a page the
            # user happens to be visiting can't drive the helper. Absent/null
            # origins (the file:// dashboard, plain navigations) and the
            # helper's own localhost origins are allowed, as are explicitly
            # user-trusted origins from categories.json `trusted_origins`.
            origin = self.headers.get("Origin", "")
            if not origin or origin == "null":
                return True
            if origin.startswith(("http://127.0.0.1", "http://localhost")):
                return True
            return origin in _trusted_origins()

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", self._allow_origin())
            self.send_header("Vary", "Origin")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self):
            """Read+parse the JSON request body once. On bad JSON, send 400 and
            return None (caller must return immediately)."""
            length = int(self.headers.get("Content-Length", "0") or 0)
            try:
                return json.loads(self.rfile.read(length)) if length else {}
            except Exception:
                self._send(400, {"ok": False, "error": "bad json"})
                return None

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path in ("/", "/index.html"):
                # Serve the dashboard itself so it loads same-origin with the
                # helper — a file:// (or hosted https) page is blocked from
                # fetch()-ing this localhost helper, which breaks the file
                # browser. Opening http://127.0.0.1:<port>/ avoids that.
                try:
                    body = INDEX_PATH.read_bytes()
                except Exception:
                    self._send(404, {"ok": False,
                                     "error": "dashboard not generated — run: devhub index"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if u.path == "/ports":
                # Standalone port-assignment management page. Like the dashboard
                # it embeds its data inline at render time (works at file:// too)
                # but is served same-origin here so the helper's live-state and
                # mutation endpoints are reachable via fetch().
                cfg2 = load_config()
                body = render_ports_page(cfg2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if u.path == "/ping":
                self._send(200, {"ok": True, "service": "devhub", "root": str(root)})
                return
            if u.path == "/api/dev/state":
                registry.reconcile(_port_listening)  # drop servers no longer up
                self._send(200, {"ok": True, "running": registry.snapshot()})
                return
            if u.path == "/api/ports/state":
                self._send(200, _h_ports_state(load_config()))
                return
            if u.path == "/api/files":
                # Read-only filtered directory listing for the Explorer tree.
                # Same trust model as /open: localhost-only, origin-checked, and
                # the resolved path must stay inside DEV_ROOT. Launches/mutates
                # nothing, so it is strictly weaker than the action endpoints.
                if not self._origin_ok():
                    self._send(403, {"ok": False, "error": "forbidden origin"})
                    return
                q = urllib.parse.parse_qs(u.query)
                raw = q.get("path", [""])[0]
                try:
                    target = Path(raw).resolve()
                except Exception:
                    self._send(400, {"ok": False, "error": "bad path"})
                    return
                if not (target == root or root in target.parents):
                    self._send(403, {"ok": False, "error": "path outside dev root"})
                    return
                if not target.is_dir():
                    self._send(404, {"ok": False, "error": "not a directory"})
                    return
                self._send(200, {"ok": True, "path": str(target),
                                 "entries": _list_dir(target)})
                return
            if u.path != "/open":
                self._send(404, {"ok": False, "error": "not found"})
                return
            if not self._origin_ok():
                self._send(403, {"ok": False, "error": "forbidden origin"})
                return
            q = urllib.parse.parse_qs(u.query)
            action = q.get("action", [""])[0]
            raw = q.get("path", [""])[0]
            try:
                target = Path(raw).resolve()
            except Exception:
                self._send(400, {"ok": False, "error": "bad path"})
                return
            if not (target == root or root in target.parents):
                self._send(403, {"ok": False, "error": "path outside dev root"})
                return
            if not target.exists():
                self._send(404, {"ok": False, "error": "path does not exist"})
                return
            if action == "dev":
                # Start the project's local dev server (idempotent). Command is
                # templated server-side; the request supplies only the path.
                dev_url = _resolved_dev_url(target, load_config())
                devcmd = detect_dev_command(target, load_config())
                if not devcmd:
                    self._send(200, {"ok": False, "action": "dev",
                                     "path": str(target), "url": dev_url,
                                     "error": "no dev script found"})
                    return
                port = _dev_port(dev_url)
                already = bool(port) and _port_listening(port)
                scripted = True
                try:
                    if is_mac and not already:
                        scripted = _spawn_dev(target.name, target, devcmd,
                                              port, dev_url)
                    self._send(200, {"ok": True, "action": "dev",
                                     "path": str(target), "url": dev_url,
                                     "cmd": devcmd, "port": port,
                                     "already_running": already,
                                     "scripted": scripted,
                                     "launched": is_mac and not already})
                except Exception as e:
                    print(f"devhub helper dev error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                return
            if action == "devstatus":
                # Read-only probe: is the project's dev port accepting yet?
                # The dashboard polls this after a cold start so it can wait
                # for the server to come up before navigating to it. Launches
                # nothing, so it stays well inside the path-allowlist trust
                # model and is cheap enough for the single-threaded server.
                dev_url = _resolved_dev_url(target, load_config())
                port = _dev_port(dev_url)
                listening = bool(port) and _port_listening(port)
                self._send(200, {"ok": True, "action": "devstatus",
                                 "path": str(target), "url": dev_url,
                                 "port": port, "listening": listening})
                return
            cmd = cmd_for(action, target)
            if not cmd:
                self._send(400, {"ok": False, "error": "unknown action"})
                return
            try:
                if is_mac:
                    sp.Popen(cmd)
                self._send(200, {"ok": True, "action": action,
                                 "path": str(target), "cmd": cmd,
                                 "launched": is_mac})
            except Exception as e:
                print(f"devhub helper /open error: {e}", file=sys.stderr)
                self._send(500, {"ok": False, "error": "internal error"})

        # ---- CORS preflight (browsers may send OPTIONS before POST) ----
        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self._allow_origin())
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        # ---- Mutation endpoints (POST /api/dev/* and /api/cards/<verb>) ----
        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
            if not self._origin_ok():
                self._send(403, {"ok": False, "error": "forbidden origin"})
                return
            if u.path == "/api/dev/register":
                p = self._read_json_body()
                if p is None:
                    return
                name = p.get("project", "")
                if not known_project(name):
                    self._send(400, {"ok": False, "error": "unknown project"})
                    return
                registry.set(name, port=int(p.get("port") or 0),
                             pid=p.get("pid"), url=p.get("url", ""), source="self")
                self._send(200, {"ok": True})
                return
            if u.path == "/api/dev/unregister":
                p = self._read_json_body()
                if p is None:
                    return
                name = p.get("project", "")
                if not PROJECT_NAME_RE.match(name or ""):
                    self._send(400, {"ok": False, "error": "bad project name"})
                    return
                registry.remove(name)
                self._send(200, {"ok": True})
                return
            if u.path in ("/api/dev/stop", "/api/dev/restart"):
                p = self._read_json_body()
                if p is None:
                    return
                name = p.get("project", "")
                if not known_project(name):
                    self._send(400, {"ok": False, "error": "unknown project"})
                    return
                target = (root / _project_relpath(name, cfg)).resolve()
                dev_url = _resolved_dev_url(target, cfg)
                assigned = _dev_port(dev_url)
                entry = registry.get(name)
                pid = (entry or {}).get("pid") or (_pid_on_port(assigned) if assigned else None)
                if not pid or not is_mac:
                    registry.remove(name)
                    self._send(200, {"ok": True, "stopped": False,
                                     "note": "not running" if is_mac else "noop (non-mac)"})
                    return
                if not _safe_to_kill(pid=pid, assigned_port=assigned):
                    self._send(403, {"ok": False, "error": "refused: process failed safety check"})
                    return
                _kill_proc_group(pid)
                registry.remove(name)
                if u.path == "/api/dev/restart":
                    devcmd = detect_dev_command(target, cfg)
                    if devcmd and assigned:
                        _spawn_dev(name, target, devcmd, assigned, dev_url,
                                   fallback_open=False)
                    self._send(200, {"ok": True, "restarted": True, "url": dev_url})
                    return
                self._send(200, {"ok": True, "stopped": True})
                return
            if u.path == "/api/git":
                # Git monitor's management verbs, dashboard-side. Same trust model
                # as /api/dev/stop: the browser sends only an action + project
                # NAME (no command bytes); the verb is templated server-side and
                # run via git_run (non-interactive — can't hang on auth). Each
                # repo is re-validated: known project, path resolved INSIDE
                # DEV_ROOT, a git repo, and owned by the current user.
                p = self._read_json_body()
                if p is None:
                    return
                action = (p.get("action") or "").strip()
                if action not in ("fetch", "pull", "push", "sync"):
                    self._send(400, {"ok": False, "error": "bad action"})
                    return

                def _resolve_repo(nm):
                    if not known_project(nm):
                        return None
                    tgt = (root / _project_relpath(nm, cfg)).resolve()
                    if root not in tgt.parents:        # never escape the dev root
                        return None
                    if not is_git_repo(tgt):
                        return None
                    try:
                        if os.stat(tgt).st_uid != os.getuid():
                            return None                 # same owner rule as kill-safety
                    except OSError:
                        return None
                    return tgt

                if p.get("all"):
                    # A single click must never mass-mutate working trees, so bulk
                    # is restricted to the inward verbs (fetch is read-only on the
                    # tree; sync only fast-forwards already-clean repos).
                    if action not in ("fetch", "sync"):
                        self._send(400, {"ok": False,
                                         "error": "bulk allows fetch/sync only"})
                        return
                    repos = [(nm, _resolve_repo(nm)) for nm in _all_git_projects(cfg)]
                    repos = [(nm, t) for nm, t in repos if t]
                    fetched = fetch_repos([str(t) for _, t in repos])   # always parallel-fetch first

                    def failed_fetch(nm, t):
                        ok, msg = fetched.get(str(t), (False, ""))
                        if ok:
                            return None
                        return {"project": nm, "ok": False, "status": "failed",
                                "message": _last_err(msg) or "fetch failed",
                                "git": _git_fields(t)}

                    def bulk_one(it):
                        nm, t = it
                        bad = failed_fetch(nm, t)
                        if bad is not None:
                            return bad
                        if action == "fetch":
                            return {"project": nm, "ok": True, "status": "done",
                                    "message": "fetched", "git": _git_fields(t)}
                        # sync: ff-only pull each (already fetched above)
                        return {**git_action(t, "pull"), "project": nm}

                    # Post-fetch per-repo work is independent — run it with the
                    # same worker count as fetch_repos instead of serially.
                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=8) as ex:
                        results = list(ex.map(bulk_one, repos))
                    self._send(200, {"ok": True, "action": action,
                                     "all": True, "results": results})
                    return

                target = _resolve_repo(p.get("project", ""))
                if target is None:
                    self._send(400, {"ok": False,
                                     "error": "unknown / unowned / non-git project"})
                    return
                res = git_action(target, action)
                res["project"] = p.get("project", "")
                self._send(200, res)
                return
            if u.path == "/api/ports/set":
                p = self._read_json_body()
                if p is None:
                    return
                # stop_fn / restart_fn capture the same closure variables as
                # /api/dev/stop and /api/dev/restart above so the existing
                # security boundary (path-allowlist, _safe_to_kill, kill the
                # group not the helper, etc.) applies unchanged. The registry
                # is the closure-scoped DevRegistry — there is intentionally
                # no module-global, so this is the only way `_h_ports_set`
                # can see the running registry.
                def _stop_for(name):
                    target = (root / _project_relpath(name, cfg)).resolve()
                    dev_url = _resolved_dev_url(target, cfg)
                    assigned = _dev_port(dev_url)
                    entry = registry.get(name)
                    # Prefer the live pid actually listening on the port
                    # (the only thing _safe_to_kill will accept). If nothing
                    # is listening, the registry entry is stale (self-
                    # registered without a real process, or the server died
                    # outside devhub) — just drop it so the relaunch is
                    # clean.
                    live_pid = _pid_on_port(assigned) if assigned else None
                    if not live_pid or not is_mac:
                        registry.remove(name)
                        return
                    if not _safe_to_kill(pid=live_pid, assigned_port=assigned):
                        raise _HTTPError(403, "refused: process failed safety check")
                    _kill_proc_group(live_pid)
                    registry.remove(name)

                def _restart_for(name):
                    fresh = load_config()  # cfg now has the new dev_port
                    target = (root / _project_relpath(name, fresh)).resolve()
                    dev_url = _resolved_dev_url(target, fresh)
                    assigned = _dev_port(dev_url)
                    devcmd = detect_dev_command(target, fresh)
                    if not (devcmd and assigned and is_mac):
                        return
                    _spawn_dev(name, target, devcmd, assigned, dev_url,
                               fallback_open=False)

                try:
                    result = _h_ports_set(
                        p, registry=registry,
                        stop_fn=_stop_for, restart_fn=_restart_for)
                except _HTTPError as e:
                    self._send(e.code, {"ok": False, "error": e.message})
                    return
                except Exception as e:
                    print(f"devhub helper ports/set error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                    return
                self._send(200, result)
                return
            if u.path == "/api/ports/clear":
                p = self._read_json_body()
                if p is None:
                    return
                try:
                    result = _h_ports_clear(p)
                except _HTTPError as e:
                    self._send(e.code, {"ok": False, "error": e.message})
                    return
                except Exception as e:
                    print(f"devhub helper ports/clear error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                    return
                self._send(200, result)
                return
            if u.path == "/api/ports/assign-missing":
                try:
                    result = _h_ports_assign_missing()
                except _HTTPError as e:
                    self._send(e.code, {"ok": False, "error": e.message})
                    return
                except Exception as e:
                    print(f"devhub helper ports/assign-missing error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                    return
                self._send(200, result)
                return
            if u.path == "/api/ports/detect-cmd":
                p = self._read_json_body()
                if p is None:
                    return
                try:
                    result = _h_ports_detect_cmd(p)
                except _HTTPError as e:
                    self._send(e.code, {"ok": False, "error": e.message})
                    return
                except Exception as e:
                    print(f"devhub helper detect-cmd error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                    return
                self._send(200, result)
                return
            if u.path == "/api/config":
                # Settings gear save. Tight whitelist (see _h_config_set); writes
                # categories.json then regenerates index.html so the change shows.
                p = self._read_json_body()
                if p is None:
                    return
                try:
                    result = _h_config_set(p)
                except ValueError as ve:
                    self._send(400, {"ok": False, "error": str(ve)})
                    return
                except Exception as e:
                    print(f"devhub helper config error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                    return
                manifest = _quick_manifest_and_write()
                self._send(200, {"ok": True, "manifest": manifest, **result})
                _kick_background_regen()
                return
            if u.path == "/api/helper/restart":
                # Settings gear "Restart helper": only the fixed LaunchAgent
                # label is ever targeted — see _h_helper_restart.
                if self._read_json_body() is None:
                    return
                try:
                    result = _h_helper_restart()
                except ValueError as ve:
                    self._send(400, {"ok": False, "error": str(ve)})
                    return
                except Exception as e:
                    print(f"devhub helper restart error: {e}", file=sys.stderr)
                    self._send(500, {"ok": False, "error": "internal error"})
                    return
                self._send(200, {"ok": True, **result})
                return
            if not u.path.startswith("/api/cards/"):
                self._send(404, {"ok": False, "error": "not found"})
                return
            payload = self._read_json_body()
            if payload is None:
                return
            verb = u.path[len("/api/cards/"):]
            try:
                result = self._dispatch_card(verb, payload)
                # Quick manifest+index write from current state files (no git
                # scan). Heavy git work runs on a background thread.
                manifest = _quick_manifest_and_write()
                result["manifest"] = manifest
                self._send(200, {"ok": True, **result})
                _kick_background_regen()
            except ValueError as ve:
                self._send(400, {"ok": False, "error": str(ve)})
            except Exception as e:
                print(f"devhub helper POST error: {e}", file=sys.stderr)
                self._send(500, {"ok": False, "error": "internal error"})

        _CARD_VERBS = {
            "tag": _h_card_tag, "note": _h_card_note, "archive": _h_card_archive,
            "favorite": _h_card_favorite, "pin": _h_card_pin,
            "move": _h_card_move, "rename": _h_card_rename, "create": _h_card_create,
            "category": _h_category_op,
        }

        def _dispatch_card(self, verb, p):
            handler = self._CARD_VERBS.get(verb)
            if handler is None:
                raise ValueError(f"unknown verb '{verb}'")
            return handler(p)

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"devhub helper listening on http://127.0.0.1:{port}")
    print(f"open the dashboard: http://127.0.0.1:{port}/  (file browsing needs this, not file://)")
    print(f"dev root: {root}")
    if not is_mac:
        print("(non-macOS: requests are validated but apps won't actually launch)")
    print("Dashboard Terminal/Files/VS Code buttons will now launch directly. "
          "Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


AGENT_LABEL = "com.devhub.helper"


def cmd_install_agent(args):
    """Install a macOS LaunchAgent so `devhub serve` auto-starts at login."""
    import plistlib
    import subprocess as sp
    if sys.platform != "darwin":
        print("install-agent is macOS-only (uses launchctl).")
        return
    la_dir = Path.home() / "Library" / "LaunchAgents"
    la_dir.mkdir(parents=True, exist_ok=True)
    plist_path = la_dir / (AGENT_LABEL + ".plist")
    py = sys.executable or "/usr/bin/python3"
    script = str(Path(__file__).resolve())
    log = str(HERE / "helper.log")
    plist = {
        "Label": AGENT_LABEL,
        "ProgramArguments": [py, script, "serve"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": log,
        "StandardErrorPath": log,
        "ProcessType": "Background",
    }
    with open(plist_path, "wb") as fh:
        plistlib.dump(plist, fh)
    print(f"Wrote {plist_path}")
    uid = os.getuid()
    sp.run(["launchctl", "bootout", f"gui/{uid}", str(plist_path)],
           capture_output=True)
    r = sp.run(["launchctl", "bootstrap", f"gui/{uid}", str(plist_path)],
               capture_output=True, text=True)
    if r.returncode == 0:
        print("Loaded via launchctl bootstrap.")
    else:
        sp.run(["launchctl", "unload", str(plist_path)], capture_output=True)
        r2 = sp.run(["launchctl", "load", "-w", str(plist_path)],
                    capture_output=True, text=True)
        print("Loaded via launchctl load." if r2.returncode == 0
              else f"launchctl error: {(r.stderr or r2.stderr).strip()}")
    port = load_config().get("helper_port", 7333)
    print(f"devhub helper will now auto-start at login (port {port}).")
    print(f"Logs: {log}")


def cmd_uninstall_agent(args):
    import subprocess as sp
    if sys.platform != "darwin":
        print("uninstall-agent is macOS-only.")
        return
    uid = os.getuid()
    plist_path = Path.home() / "Library" / "LaunchAgents" / (AGENT_LABEL + ".plist")
    sp.run(["launchctl", "bootout", f"gui/{uid}", str(plist_path)],
           capture_output=True)
    sp.run(["launchctl", "unload", str(plist_path)], capture_output=True)
    if plist_path.exists():
        plist_path.unlink()
        print(f"Removed {plist_path}")
    else:
        print("No agent plist found.")
    print("devhub helper auto-start removed.")


def _find_project_anywhere(target: str, cfg: dict):
    """(name, category_or_None) via the shared `_find_project_path` resolver —
    so pinned top-level projects (e.g. _devhub) resolve here too."""
    path, cat = _find_project_path(target, cfg)
    return (path.name, cat) if path is not None else (None, None)


def _find_ref_by_query(refs: list, target: str):
    q = target.lower()
    for r in refs:
        if r.get("id") == target:
            return r
    for r in refs:
        if q in r.get("title", "").lower() or q in r.get("url", "").lower():
            return r
    return None


def cmd_tag(args):
    cfg = load_config()
    new_tags = sorted({_normalize_tag(t) for t in args.tags if t.strip()})
    if not new_tags:
        print("No valid tags provided."); return
    # try project first — same core as the dashboard's tag endpoint
    name, cat = _find_project_anywhere(args.target, cfg)
    if name:
        res = _h_card_tag({"project": name, "add": list(args.tags)})
        print(f"Tagged project '{name}' ({cat or '<root>'}): {res['tags']}")
        cmd_index(args); return
    # else reference
    refs = load_refs()
    ref = _find_ref_by_query(refs, args.target)
    if not ref:
        print(f"No project or reference matching '{args.target}'.")
        sys.exit(1)
    cur = set(ref.get("tags", []))
    cur.update(new_tags)
    ref["tags"] = sorted(cur)
    save_refs(refs)
    print(f"Tagged ref {ref['id']} '{ref.get('title','')[:60]}': {ref['tags']}")
    cmd_index(args)


def cmd_untag(args):
    cfg = load_config()
    drop = {_normalize_tag(t) for t in args.tags}
    name, cat = _find_project_anywhere(args.target, cfg)
    if name:
        res = _h_card_tag({"project": name, "remove": list(args.tags)})
        print(f"Untagged project '{name}': remaining {res['tags']}")
        cmd_index(args); return
    refs = load_refs()
    ref = _find_ref_by_query(refs, args.target)
    if not ref:
        print(f"No project or reference matching '{args.target}'.")
        sys.exit(1)
    cur = set(ref.get("tags", []))
    cur.difference_update(drop)
    if cur:
        ref["tags"] = sorted(cur)
    else:
        ref.pop("tags", None)
    save_refs(refs)
    print(f"Untagged ref {ref['id']}: remaining {ref.get('tags', [])}")
    cmd_index(args)


def cmd_tags(args):
    counts = {}
    proj_tags = load_tags()
    for tags in proj_tags.values():
        for t in tags:
            counts[t] = counts.get(t, 0) + 1
    for r in load_refs():
        for t in r.get("tags", []):
            counts[t] = counts.get(t, 0) + 1
    if not counts:
        print("No tags yet. Add one: devhub tag <project_or_ref_id> <tag> [tag...]")
        return
    print(f"{'tag':<24} count")
    print("-" * 30)
    for tag, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {tag:<24} {n}")


def cmd_rename_tag(args):
    old = _normalize_tag(args.old)
    new = _normalize_tag(args.new)
    if not old or not new:
        print("Bad tag name.")
        sys.exit(1)
    if old == new:
        print("Old and new tag are the same.")
        return
    tdb = load_tags()
    touched_p = 0
    for proj, tags in list(tdb.items()):
        if old in tags:
            updated = sorted({new if t == old else t for t in tags})
            tdb[proj] = updated
            touched_p += 1
    save_tags(tdb)
    refs = load_refs()
    touched_r = 0
    for r in refs:
        if old in r.get("tags", []):
            r["tags"] = sorted({new if t == old else t for t in r["tags"]})
            touched_r += 1
    if touched_r:
        save_refs(refs)
    print(f"Renamed tag '{old}' -> '{new}': "
          f"{touched_p} project(s), {touched_r} ref(s).")
    cmd_index(args)


def cmd_delete_tag(args):
    tag = _normalize_tag(args.tag)
    if not tag:
        print("Bad tag name.")
        sys.exit(1)
    tdb = load_tags()
    touched_p = 0
    for proj, tags in list(tdb.items()):
        if tag in tags:
            remaining = [t for t in tags if t != tag]
            if remaining:
                tdb[proj] = remaining
            else:
                tdb.pop(proj)
            touched_p += 1
    save_tags(tdb)
    refs = load_refs()
    touched_r = 0
    for r in refs:
        if tag in r.get("tags", []):
            r["tags"] = [t for t in r["tags"] if t != tag]
            if not r["tags"]:
                r.pop("tags", None)
            touched_r += 1
    if touched_r:
        save_refs(refs)
    print(f"Deleted tag '{tag}': removed from "
          f"{touched_p} project(s), {touched_r} ref(s).")
    cmd_index(args)


def cmd_tag_many(args):
    """Tag many projects by category name or fnmatch glob over project names."""
    import fnmatch
    cfg = load_config()
    selector = args.selector
    new_tags = sorted({_normalize_tag(t) for t in args.tags if t.strip()})
    if not new_tags:
        print("No valid tags provided.")
        return
    targets = []
    if selector in cfg["categories"]:
        cdir = DEV_ROOT / selector
        if cdir.is_dir():
            for c in cdir.iterdir():
                if c.is_dir() and not c.name.startswith("."):
                    targets.append(c.name)
    else:
        for n in _all_project_names(cfg):
            if fnmatch.fnmatch(n, selector):
                targets.append(n)
    if not targets:
        print(f"No projects matched selector '{selector}'. "
              "Use a category name or a glob like 'mcp-*'.")
        return
    tdb = load_tags()
    for n in targets:
        cur = set(tdb.get(n, []))
        cur.update(new_tags)
        tdb[n] = sorted(cur)
    save_tags(tdb)
    print(f"Tagged {len(targets)} project(s) with {new_tags}:")
    for n in targets:
        print(f"  - {n}")
    cmd_index(args)


def _resolve_item(target: str, cfg: dict, refs: list):
    """Resolve a string to a canonical item id: 'project:<name>' or 'ref:<id>'."""
    name, _ = _find_project_anywhere(target, cfg)
    if name:
        return f"project:{name}", "project", name
    ref = _find_ref_by_query(refs, target)
    if ref:
        return f"ref:{ref['id']}", "ref", ref
    return None, None, None


def cmd_relate(args):
    cfg = load_config()
    refs = load_refs()
    a, ta, _ = _resolve_item(args.a, cfg, refs)
    b, tb, _ = _resolve_item(args.b, cfg, refs)
    if not a or not b:
        print(f"Could not resolve "
              f"{'a' if not a else 'b'}={args.a if not a else args.b}.")
        sys.exit(1)
    if a == b:
        print("Cannot relate an item to itself."); sys.exit(1)
    pairs = load_relations()
    pairs.append([a, b])
    save_relations(pairs)
    print(f"Related: {a}  ↔  {b}")
    cmd_index(args)


def cmd_unrelate(args):
    cfg = load_config()
    refs = load_refs()
    a, _, _ = _resolve_item(args.a, cfg, refs)
    b, _, _ = _resolve_item(args.b, cfg, refs)
    if not a or not b:
        print("Could not resolve both items."); sys.exit(1)
    key = tuple(sorted([a, b]))
    pairs = [p for p in load_relations() if tuple(sorted(p)) != key]
    save_relations(pairs)
    print(f"Unrelated: {a}  ⨯  {b}")
    cmd_index(args)


def cmd_relations(args):
    pairs = load_relations()
    if not pairs:
        print("No relations yet. Add one: devhub relate <a> <b>")
        return
    for a, b in pairs:
        print(f"  {a}  ↔  {b}")
    print(f"\n{len(pairs)} relation(s).")


def cmd_attach(args):
    """Manually attach a reference to a project (sets ref.project)."""
    cfg = load_config()
    name, _ = _find_project_anywhere(args.project, cfg)
    if not name:
        print(f"No project named '{args.project}' under any category.")
        sys.exit(1)
    refs = load_refs()
    ref = _find_ref_by_query(refs, args.ref)
    if not ref:
        print(f"No reference matching '{args.ref}'.")
        sys.exit(1)
    ref["project"] = name
    save_refs(refs)
    print(f"Attached ref {ref['id']} '{ref.get('title','')[:60]}' -> project '{name}'")
    cmd_index(args)


def cmd_detach(args):
    refs = load_refs()
    ref = _find_ref_by_query(refs, args.ref)
    if not ref:
        print(f"No reference matching '{args.ref}'.")
        sys.exit(1)
    was = ref.pop("project", None)
    save_refs(refs)
    print(f"Detached ref {ref['id']}"
          + (f" (was attached to '{was}')" if was else " (was not attached)"))
    cmd_index(args)


def cmd_refs(args):
    refs = load_refs()
    if not refs:
        print("No references yet. Add one: devhub import <url>")
        return
    by = {}
    for r in refs:
        by.setdefault(r["category"], []).append(r)
    for cat in sorted(by):
        print(f"[{cat}]")
        for r in by[cat]:
            print(f"  {r['id']}  {r['type']:<7} {r['title'][:72]}")
            print(f"            {r['url']}")
    print(f"\n{len(refs)} reference(s).")


def cmd_unref(args):
    refs = load_refs()
    q = args.query.lower()
    keep, removed = [], []
    for r in refs:
        if q == r["id"] or q in r["title"].lower() or q in r["url"].lower():
            removed.append(r)
        else:
            keep.append(r)
    if not removed:
        print(f"No reference matched '{args.query}'.")
        return
    save_refs(keep)
    for r in removed:
        wp = REFS_DIR / r["category"] / (safe_filename(r["title"]) + ".webloc")
        try:
            wp.unlink()
        except OSError:
            pass
        print(f"Removed {r['id']}  {r['title'][:60]}")
    cmd_index(args)


def cmd_ref_edit(args):
    cfg = load_config()
    refs = load_refs()
    ref = _find_ref_by_query(refs, args.query)
    if not ref:
        print(f"No reference matching '{args.query}'.")
        sys.exit(1)
    if not (args.title or args.category):
        print("Nothing to change. Pass --title and/or --category.")
        return
    old_path = REFS_DIR / ref["category"] / (safe_filename(ref["title"]) + ".webloc")
    changes = []
    if args.title:
        ref["title"] = args.title.strip()
        changes.append(f"title='{ref['title']}'")
    if args.category:
        if args.category not in cfg["categories"]:
            print(f"Unknown category '{args.category}'.")
            sys.exit(1)
        ref["category"] = args.category
        changes.append(f"category='{args.category}'")
    save_refs(refs)
    new_path = REFS_DIR / ref["category"] / (safe_filename(ref["title"]) + ".webloc")
    new_path.parent.mkdir(parents=True, exist_ok=True)
    if old_path.exists() and old_path != new_path:
        if new_path.exists():
            try:
                new_path.unlink()
            except OSError:
                pass
        shutil.move(str(old_path), str(new_path))
    elif not new_path.exists():
        new_path.write_text(WEBLOC_TEMPLATE.format(url=html.escape(ref["url"])),
                            encoding="utf-8")
    print(f"Edited ref {ref['id']}: " + "; ".join(changes))
    cmd_index(args)


def duplicate_project_names(manifest: dict) -> dict:
    """Project names claimed by more than one directory -> their paths.

    Everything user-scoped in categories.json — links (and so dev_port),
    overrides, tags, notes — is keyed by project *name*, not path. Two
    directories sharing a name therefore share one entry and one dev port,
    silently. ai-agents/skills and homelab/skills are the live example.
    """
    seen: dict[str, list] = {}
    for blk in (manifest.get("categories") or {}).values():
        for p in blk.get("projects", []):
            seen.setdefault(p["name"], []).append(p["path"])
    return {n: paths for n, paths in seen.items() if len(paths) > 1}


def _find_project_path(name: str, cfg: dict):
    """Return (Path, category_or_None). Looks under known categories first."""
    for cat in known_categories(cfg):
        cand = DEV_ROOT / cat / name
        if cand.is_dir():
            return cand, cat
    cand = DEV_ROOT / name
    if cand.is_dir():
        return cand, None
    return None, None


def _rewrite_project_name(old: str, new: str, cfg: dict) -> None:
    """Propagate a project rename across links, overrides, tags, notes,
    archived, favorites, pinned, refs (ref.project) and relations.json."""
    # links carries dev_port, dev_path, dev_cmd and the deployed/dev URLs.
    # Leaving it behind orphans the port assignment under a name no directory
    # answers to any more, and hands it to whatever project later takes the
    # old name — which is exactly how two directories came to share one port.
    links = cfg.get("links", {})
    if old in links and new not in links:
        links[new] = links.pop(old)
    ov = cfg.get("overrides", {})
    if old in ov:
        ov[new] = ov.pop(old)
    notes = cfg.get("notes", {})
    if old in notes:
        notes[new] = notes.pop(old)
    for key in ("archived", "favorites", "pinned"):
        vals = cfg.get(key, [])
        if old in vals:
            cfg[key] = [new if x == old else x for x in vals]
    save_config(cfg)
    tdb = load_tags()
    if old in tdb:
        tdb[new] = tdb.pop(old)
        save_tags(tdb)
    refs = load_refs()
    changed = False
    for r in refs:
        if r.get("project") == old:
            r["project"] = new
            changed = True
    if changed:
        save_refs(refs)
    old_id, new_id = f"project:{old}", f"project:{new}"
    pairs = load_relations()
    rewritten = []
    rewrite = False
    for a, b in pairs:
        na = new_id if a == old_id else a
        nb = new_id if b == old_id else b
        if (na, nb) != (a, b):
            rewrite = True
        rewritten.append([na, nb])
    if rewrite:
        save_relations(rewritten)


def cmd_rename_project(args):
    cfg = load_config()
    old, new = args.project, args.new_name
    if not PROJECT_NAME_RE.match(new):
        print("New name must start with alphanumeric and contain only A-Z a-z 0-9 . _ -")
        sys.exit(1)
    src, cat = _find_project_path(old, cfg)
    if src is None:
        print(f"Project '{old}' not found.")
        sys.exit(1)
    dst = src.parent / new
    if dst.exists():
        print(f"Destination already exists: {dst.relative_to(DEV_ROOT)}")
        sys.exit(1)
    src.rename(dst)
    _rewrite_project_name(old, new, cfg)
    print(f"Renamed project '{old}' -> '{new}' (in {cat or '<root>'}/).")
    cmd_index(args)


def cmd_archive(args):
    cfg = load_config()
    name = args.project
    src, _ = _find_project_path(name, cfg)
    if src is None:
        print(f"Project '{name}' not found.")
        sys.exit(1)
    arr = cfg.setdefault("archived", [])
    if name in arr:
        print(f"'{name}' is already archived.")
        return
    arr.append(name)
    save_config(cfg)
    print(f"Archived '{name}' (still on disk at {src.relative_to(DEV_ROOT)}; "
          "hidden by default on the dashboard).")
    cmd_index(args)


def cmd_unarchive(args):
    cfg = load_config()
    name = args.project
    arr = cfg.get("archived", [])
    if name not in arr:
        print(f"'{name}' is not in the archived list.")
        return
    arr.remove(name)
    save_config(cfg)
    print(f"Unarchived '{name}'.")
    cmd_index(args)


def cmd_note(args):
    cfg = load_config()
    name = args.project
    src, _ = _find_project_path(name, cfg)
    if src is None:
        print(f"Project '{name}' not found.")
        sys.exit(1)
    text = (args.text or "").strip()
    notes = cfg.setdefault("notes", {})
    if text:
        notes[name] = text
        print(f"Note set on '{name}': {text}")
    else:
        if name in notes:
            notes.pop(name)
            print(f"Note cleared on '{name}'.")
        else:
            print(f"No note on '{name}' to clear.")
            return
    save_config(cfg)
    cmd_index(args)


def cmd_unnote(args):
    cfg = load_config()
    name = args.project
    notes = cfg.setdefault("notes", {})
    if name not in notes:
        print(f"No note on '{name}'.")
        return
    notes.pop(name)
    save_config(cfg)
    print(f"Note cleared on '{name}'.")
    cmd_index(args)


def cmd_move_many(args):
    cfg = load_config()
    src_cat, dst_cat = args.from_category, args.to_category
    if src_cat not in cfg["categories"]:
        print(f"Unknown source category '{src_cat}'.")
        sys.exit(1)
    if dst_cat not in cfg["categories"]:
        print(f"Unknown target category '{dst_cat}'.")
        sys.exit(1)
    if src_cat == dst_cat:
        print("Source and target are the same.")
        return
    src_dir = DEV_ROOT / src_cat
    dst_dir = DEV_ROOT / dst_cat
    dst_dir.mkdir(exist_ok=True)
    moved, skipped = [], []
    if src_dir.is_dir():
        for child in list(src_dir.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            target = dst_dir / child.name
            if target.exists():
                skipped.append(child.name)
                continue
            shutil.move(str(child), str(target))
            cfg.setdefault("overrides", {})[child.name] = dst_cat
            moved.append(child.name)
    save_config(cfg)
    print(f"Moved {len(moved)} project(s) from {src_cat} -> {dst_cat}:")
    for n in moved:
        print(f"  - {n}")
    if skipped:
        print(f"Skipped {len(skipped)} (destination exists):")
        for n in skipped:
            print(f"  - {n}")
    cmd_index(args)


# --------------------------------------------------------------------------- #
# regenerate helpers (used by POST endpoints below)
# --------------------------------------------------------------------------- #
def regenerate_dashboard() -> dict:
    """Full rescan + rewrite manifest.json and index.html. Slow (git per project)."""
    cfg = load_config()
    manifest = build_manifest(cfg)
    write_manifest(manifest)
    INDEX_PATH.write_text(render_dashboard(manifest, cfg), encoding="utf-8")
    return manifest


# Serializes the manifest.json read-modify-write + index.html write below.
# ThreadingHTTPServer means concurrent POSTs can otherwise race this.
_MANIFEST_WRITE_LOCK = threading.Lock()


def _quick_manifest_and_write() -> dict:
    """Patch the existing manifest from current state files (no git scan).
    Updates each project's tags/note/archived, applies moves and category set
    changes, then rewrites manifest.json and index.html. Fast — used inside
    POST handlers so they respond quickly. A background full rescan catches
    up the git-derived fields shortly after.
    """
    with _MANIFEST_WRITE_LOCK:
        cfg = load_config()
        tdb = load_tags()
        notes = cfg.get("notes", {})
        archived = set(cfg.get("archived", []))
        favorites = set(cfg.get("favorites", []))
        pinned = set(cfg.get("pinned", []))
        overrides = cfg.get("overrides", {})
        login = (cfg.get("github_login") or "").strip()
        try:
            m = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        except Exception:
            # no manifest yet — fall back to a full scan
            return regenerate_dashboard()

        # Make sure every known category exists in the manifest
        for cat, meta in cfg["categories"].items():
            if cat not in m["categories"]:
                m["categories"][cat] = {
                    "label": meta.get("label", cat),
                    "blurb": meta.get("blurb", ""),
                    "projects": [],
                }
            else:
                # refresh label/blurb in case they were edited
                m["categories"][cat]["label"] = meta.get("label", cat)
                m["categories"][cat]["blurb"] = meta.get("blurb", "")
        # Drop categories that no longer exist
        for cat in list(m["categories"].keys()):
            if cat not in cfg["categories"]:
                # projects there are orphaned for now; the background regen will
                # rebuild from disk authoritatively
                del m["categories"][cat]

        # Walk projects, patch their state and reassign category if it moved
        moves = []  # list of (project_dict, old_cat, new_cat)
        seen_names = set()
        for cat in list(m["categories"].keys()):
            blk = m["categories"][cat]
            keep = []
            for p in blk["projects"]:
                name = p["name"]
                seen_names.add(name)
                new_cat = overrides.get(name, cat)
                p["tags"] = sorted(tdb.get(name, []))
                p["note"] = notes.get(name, "")
                p["archived"] = name in archived
                p["favorite"] = name in favorites
                p["pinned"] = name in pinned
                # Re-derive mine/owner cheaply from the cached remote. Without
                # this, changing github_login via the settings gear (or having
                # an upgrade-time manifest that predates these fields) leaves
                # the dashboard's source filter operating on stale data until
                # the next full rescan lands.
                p["mine"] = _is_mine(p.get("remote", ""), login)
                p["owner"] = _parse_owner(p.get("remote", ""))
                if p.get("path"):
                    # Keep the dev URL in sync with links overrides / dev_port
                    # on this fast path too (matches build_manifest). The prior
                    # manifest's value rides as the fallback so projects with no
                    # links entry don't re-run disk detection on every POST.
                    p["dev"] = _resolved_dev_url(DEV_ROOT / p["path"], cfg,
                                                 fallback=p.get("dev") or "")
                if new_cat != cat:
                    moves.append((p, cat, new_cat))
                else:
                    keep.append(p)
            blk["projects"] = keep
        for p, _old, new_cat in moves:
            if new_cat not in m["categories"]:
                m["categories"][new_cat] = {"label": new_cat, "blurb": "", "projects": []}
            p["category"] = new_cat
            m["categories"][new_cat]["projects"].append(p)

        # Re-sort projects within each category by name
        for cat in m["categories"].values():
            cat["projects"].sort(key=lambda p: p["name"].lower())

        # Recompute the archived stat
        arch = sum(1 for blk in m["categories"].values()
                   for p in blk["projects"] if p.get("archived"))
        m["stats"]["archived"] = arch
        m["stats"]["total"] = sum(len(blk["projects"]) for blk in m["categories"].values())
        m["stats"]["by_category"] = {c: len(blk["projects"]) for c, blk in m["categories"].items()}

        # Refresh references list (cheap) — they may have moved categories etc.
        m["references"] = load_refs()
        m["stats"]["references"] = len(m["references"])

        # Recompute relation chips so a relate/unrelate done via the dashboard
        # shows immediately (build_manifest does this too; keep them in sync).
        _attach_relations(m, m["references"])
        _attach_ref_notes(m["references"])

        write_manifest(m)
        INDEX_PATH.write_text(render_dashboard(m, cfg), encoding="utf-8")
        return m


# Background regeneration — coalesce many POSTs into one full git scan.
_regen_event = threading.Event()
_regen_thread = None
_regen_lock = threading.Lock()


def _regen_worker():
    while True:
        _regen_event.wait()
        _regen_event.clear()
        try:
            with _regen_lock:
                regenerate_dashboard()
        except Exception as e:
            # Don't die silently — a failed regen would otherwise leave the
            # dashboard's git-derived fields stale with no clue why.
            print(f"devhub background regen failed: {e}", file=sys.stderr)


def _kick_background_regen():
    """Schedule a full git-scan regen on the background thread. Idempotent."""
    global _regen_thread
    if _regen_thread is None:
        _regen_thread = threading.Thread(target=_regen_worker, daemon=True)
        _regen_thread.start()
    _regen_event.set()


# --------------------------------------------------------------------------- #
# dashboard rendering (static, data embedded inline)
# --------------------------------------------------------------------------- #
# Shared JS inlined by both render_dashboard (index.html) and render_ports_page
# (/ports). Owns the helper-polling loop, the dev-action click router, the
# fetch wrapper for /api/dev/*, and the loading-page HTML for cold-start tabs.
# Each page wires its OWN render function (renderRunning vs renderPortsTable)
# by assigning `window.onDevState = <renderer>` BEFORE starting the poll loop;
# pollDevState calls that hook after every successful /api/dev/state fetch.
_DASHBOARD_DEV_JS = r"""
// --- Live dev-server state: poll the helper, render the Running panel ---
let DEV_STATE = {};
let _devPolling = false;
function pollDevState(){
  if(_devPolling) return;
  _devPolling = true;
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort(), 2500);
  fetch(`http://127.0.0.1:${DATA.helper_port}/api/dev/state`, {signal: ac.signal})
    .then(r=>r.json()).then(j=>{ DEV_STATE = (j&&j.running)||{}; if(window.onDevState) window.onDevState(); if(window.setHelperStatus) setHelperStatus(true); })
    .catch(()=>{ /* helper off or timed out: leave panel as-is */ if(window.setHelperStatus) setHelperStatus(false); })
    .finally(()=>{ clearTimeout(t); _devPolling = false; });
}
// Shared click router for live-dev buttons (.devopen/.devstop/.devrestart/.devstopall).
// Used by both the Running panel and the modal's Open section. Returns true if it
// consumed the click. Place its checks before the modal's .devbtn branch.
function handleDevClick(e){
  const dop = e.target.closest('.devopen');
  if(dop){ window.open(dop.dataset.url,'_blank'); return true; }
  const dstop = e.target.closest('.devstop');
  if(dstop){ devAction('stop', dstop.dataset.name, dstop); return true; }
  const drest = e.target.closest('.devrestart');
  if(drest){ devAction('restart', drest.dataset.name, drest); return true; }
  const dall = e.target.closest('.devstopall');
  if(dall){ Object.keys(DEV_STATE).forEach(n=>devAction('stop', n)); return true; }
  return false;
}
function devAction(action, name, btn){
  if(btn) flash(btn, action==='stop'?'Stopping…':'Restarting…');
  fetch(`http://127.0.0.1:${DATA.helper_port}/api/dev/${action}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({project:name})
  }).then(r=>r.json()).then(()=>pollDevState())
    .catch(()=>{ if(btn) flash(btn,'helper off'); });
}
// Self-contained loading page shown in the freshly-opened tab while a cold dev
// server boots, so a click never lands on "this site can't be reached". </ is
// written as <\/ so these tags can't close the dashboard's own <script> block.
function devLoadingDoc(url){
  return '<!doctype html><html><head><meta charset="utf-8"><title>Starting dev server…<\/title>'
    + '<style>html,body{height:100%;margin:0;background:#0d1117;color:#c9d1d9;'
    + 'font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'display:flex;align-items:center;justify-content:center}'
    + '.b{text-align:center}'
    + '.s{width:46px;height:46px;margin:0 auto 20px;border:3px solid #21262d;'
    + 'border-top-color:#2f81f7;border-radius:50%;animation:spin 1s linear infinite}'
    + '@keyframes spin{to{transform:rotate(360deg)}}'
    + '.d::after{display:inline-block;width:1.2em;text-align:left;content:"";'
    + 'animation:dots 1.4s steps(1,end) infinite}'
    + '@keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}'
    + '.u{color:#8b949e;font-size:13px;margin-top:12px;word-break:break-all}<\/style><\/head>'
    + '<body><div class="b"><div class="s"><\/div>'
    + '<div>Starting dev server<span class="d"><\/span><\/div>'
    + '<div class="u">'+esc(url)+'<\/div><\/div><\/body><\/html>';
}
"""


def render_dashboard(manifest: dict, cfg: dict | None = None) -> str:
    # Callers that already hold the config pass it through to skip re-reading
    # categories.json twice per render (this runs on every mutation POST).
    cfg = load_config() if cfg is None else cfg
    s = manifest["stats"]
    tpl = DASHBOARD_TEMPLATE
    repl = {
        # Escape "</" so a value containing "</script>" can't close the inline
        # <script> block and break out into HTML. "<\/" is valid inside JS/JSON.
        "__DATA__": json.dumps(manifest).replace("</", "<\\/"),
        # Config for the settings gear form, read fresh from categories.json so
        # it is never stale after a quick (non-git) regen.
        "__CONFIG__": json.dumps(_config_block(cfg)).replace("</", "<\\/"),
        "__GENERATED__": html.escape(manifest["generated"]),
        "__TOTAL__": str(s["total"]),
        "__NCATS__": str(len(manifest["categories"])),
        "__DIRTY__": str(s["dirty"]),
        "__UNPUSHED__": str(s.get("unpushed", 0)),
        "__STALE__": str(s["stale"]),
        "__STRAYS__": str(s["strays"]),
        "__LINKS__": str(s.get("references", 0)),
        "__THR__": str(s["stale_days_threshold"]),
        # Shared helper-polling / dev-action JS — same body as on /ports.
        "__DASHBOARD_DEV_JS__": _DASHBOARD_DEV_JS,
        # Embed the helper port into static <a href="…/ports"> targets (header
        # button) so the link works before any JS runs. The helper-pill text
        # also uses this token; JS overwrites it at runtime either way.
        "__HELPER_PORT__": str(int(cfg.get("helper_port", 7333))),
    }
    for k, v in repl.items():
        tpl = tpl.replace(k, v)
    return tpl


def render_ports_page(cfg: dict) -> str:
    """Self-contained /ports page. See docs/specs/2026-05-27-ports-page-design.md."""
    base = int(cfg.get("dev_port_base") or DEFAULT_DEV_PORT_BASE)
    helper_port = int(cfg.get("helper_port") or 7333)
    rows = _h_ports_state(cfg)["rows"]  # reuse the endpoint's row builder
    data_json = json.dumps({
        "rows": rows,
        "dev_port_base": base,
        "helper_port": helper_port,
        "host_root": cfg.get("host_root") or "",
    }).replace("</", "<\\/")
    return PORTS_TEMPLATE \
        .replace("__PORTS_DATA__", data_json) \
        .replace("__DASHBOARD_DEV_JS__", _DASHBOARD_DEV_JS) \
        .replace("__HELPER_PORT__", str(helper_port)) \
        .replace("__DEV_PORT_BASE__", str(base))


PORTS_TEMPLATE = r"""<!doctype html>
<meta charset="utf-8">
<title>devhub · Ports</title>
<style>
  body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:#0d1117;color:#c9d1d9;margin:0;padding:0}
  header{padding:14px 22px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:18px}
  header h1{margin:0;font-size:18px;font-weight:600}
  header .hpath{color:#8b949e;font-weight:400;font-size:13px;margin-left:8px}
  main{padding:18px 22px}
  table.ports{width:100%;border-collapse:collapse;font-size:13px}
  table.ports th{position:sticky;top:0;background:#161b22;text-align:left;
                  padding:8px 10px;border-bottom:1px solid #30363d;color:#8b949e;font-weight:500}
  table.ports td{padding:8px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot.run{background:#3fb950}
  .dot.idle{background:#484f58}
  .dot.conf{background:#d29922}
  .dot.un{background:transparent;border:1px dashed #484f58}
  .badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:3px;
          background:#1f2937;color:#8b949e;margin-left:6px}
  .badge.pinned{background:#3d1f1f;color:#f0b08c}
  .src{font-size:11px;color:#8b949e}
  a{color:#58a6ff}
  .helper-pill{font-size:12px;color:#8b949e;margin-left:auto}
  input.cell-port,input.cell-path{background:#0d1117;color:#c9d1d9;
       border:1px solid #30363d;border-radius:3px;padding:3px 6px;font:inherit;width:90px}
  input.cell-path{width:160px}
  input.dirty{border-color:#58a6ff}
  input.conflict{border-color:#f85149}
  .toast{position:fixed;right:20px;bottom:20px;padding:10px 14px;border-radius:6px;
         font-size:13px;z-index:99}
  .toast.ok{background:#1f3a1f;color:#aaf0a0;border:1px solid #2d5a2d}
  .toast.err{background:#3a1f1f;color:#f0a0a0;border:1px solid #5a2d2d}
  .btn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:3px;
       padding:3px 8px;font:inherit;font-size:12px;cursor:pointer;margin-right:4px}
  .btn:hover{background:#30363d}
  .toolbar{padding:10px 22px;border-bottom:1px solid #21262d;display:flex;gap:14px;align-items:center;background:#0f141a}
  .toolbar label{display:inline-flex;align-items:center;gap:6px}
  .toolbar input[type=number]{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:3px;padding:3px 6px;font:inherit;width:80px}
  .run-summary{color:#8b949e;font-size:13px}
  .row-expand{cursor:pointer;color:#8b949e;display:inline-block;width:14px}
  .row-expand.open{transform:rotate(90deg)}
  .drawer-body{padding:10px 14px;background:#0f141a}
  .drawer-body textarea{width:100%;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;
                         border-radius:3px;padding:6px;font:inherit;font-family:ui-monospace,monospace}
  .drawer-actions{margin-top:8px;display:flex;gap:8px;align-items:center}
  .dcmd-suggest{color:#8b949e;font-size:12px}
</style>
<header>
  <h1>dev<b>hub</b> <span class="hpath">· Ports &amp; dev servers</span></h1>
  <span class="helper-pill" id="helperPill">Helper: 127.0.0.1:__HELPER_PORT__ · ●</span>
</header>
<div class="toolbar">
  <label>dev_port_base
    <input id="dpb" type="number" min="1024" max="65535" value="__DEV_PORT_BASE__">
    <button id="dpbSave" class="btn">Save</button>
  </label>
  <span id="runSummary" class="run-summary">Running 0</span>
  <button id="assignMissing" class="btn">Assign missing (0)</button>
  <button id="stopAll" class="btn">Stop all</button>
  <button id="reload" class="btn">Reload</button>
</div>
<main>
  <table class="ports" id="portsTable">
    <thead>
      <tr>
        <th></th>
        <th>State</th>
        <th>Project</th>
        <th>Port</th>
        <th>Path</th>
        <th>URL</th>
        <th>PID · uptime</th>
        <th>Source</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="portsBody"></tbody>
  </table>
</main>
<script>
const DATA = __PORTS_DATA__;
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function setHelperStatus(up){
  const el = document.getElementById('helperPill');
  if(!el) return;
  el.innerHTML = `Helper: 127.0.0.1:${DATA.helper_port} · ` + (up ? '<span style="color:#3fb950">●</span> up' : '<span style="color:#f85149">✕</span> down');
}
__DASHBOARD_DEV_JS__
function fmtUptime(iso){
  if(!iso) return '';
  const t = (Date.now() - new Date(iso).getTime()) / 1000;
  if(t < 60) return Math.floor(t)+'s';
  if(t < 3600) return Math.floor(t/60)+'m';
  return Math.floor(t/3600)+'h';
}
function renderTable(force=false){
  const tbody = document.getElementById('portsBody');
  // Live-state polling must not replace a focused field or an open command editor.
  if(!force && ((tbody.contains(document.activeElement) && document.activeElement.matches('input,textarea'))
      || tbody.querySelector('input.dirty')
      || [...tbody.querySelectorAll('.drawer')].some(row => row.style.display !== 'none'))) return;
  const liveByName = DEV_STATE || {};
  if(!DATA.rows.length){
    tbody.innerHTML = `<tr><td colspan="9" style="padding:24px;color:#8b949e">
      No managed projects yet — run <code>devhub scan</code> from the dev root.
    </td></tr>`;
    return;
  }
  const html = DATA.rows.map(r => {
    const live = liveByName[r.project];
    const state = live ? 'run' : (r.dev_port==null ? 'un' : 'idle');
    const label = live ? '● running' : (r.dev_port==null ? '— unassigned' : '○ idle');
    const pinned = r.pinned ? '<span class="badge pinned">pinned</span>' : '';
    const url = r.url ? `<a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>` : '';
    const pid = live ? `pid ${esc(live.pid||'?')} · ${fmtUptime(live.started_at)}` : '';
    const src = live ? `<span class="src">${esc(live.source||'')}</span>` : '';
    const acts = (() => {
      if(live){
        return `<button class="btn devopen" data-name="${esc(r.project)}" data-url="${esc(r.url||('http://localhost:'+r.dev_port))}">Open ↗</button>
                <button class="btn devstop" data-name="${esc(r.project)}">Stop ■</button>
                <button class="btn devrestart" data-name="${esc(r.project)}">Restart ↻</button>`;
      }
      if(r.dev_port == null){
        return `<button class="btn act-assign-next" data-name="${esc(r.project)}">Assign next ➜</button>`;
      }
      return `<button class="btn act-start" data-name="${esc(r.project)}">Start ▶</button>
              <button class="btn act-clear" data-name="${esc(r.project)}">Clear</button>`;
    })();
    const rowHtml = `<tr data-name="${esc(r.project)}">
      <td><span class="row-expand" data-name="${esc(r.project)}">▸</span></td>
      <td><span class="dot ${state}"></span>${esc(label)}</td>
      <td>${esc(r.project)}</td>
      <td><input class="cell-port" type="number" min="1024" max="65535" value="${r.dev_port==null?'':esc(r.dev_port)}" data-orig="${r.dev_port==null?'':esc(r.dev_port)}">${pinned}</td>
      <td><input class="cell-path" type="text" placeholder="/" value="${esc(r.dev_path||'')}" data-orig="${esc(r.dev_path||'')}"></td>
      <td>${url}</td>
      <td>${pid}</td>
      <td>${src}</td>
      <td>${acts}</td>
    </tr>`;
    const drawer = `<tr class="drawer" data-name="${esc(r.project)}" style="display:none">
      <td colspan="9">
        <div class="drawer-body">
          <label>dev_cmd<br>
            <textarea class="dcmd" rows="2" data-name="${esc(r.project)}">${esc(r.dev_cmd||'')}</textarea>
          </label>
          <div class="drawer-actions">
            <button class="btn dcmd-detect" data-name="${esc(r.project)}">Detect…</button>
            <button class="btn dcmd-save" data-name="${esc(r.project)}">Save</button>
            <button class="btn dcmd-cancel" data-name="${esc(r.project)}">Cancel</button>
            <span class="dcmd-suggest" data-name="${esc(r.project)}"></span>
          </div>
        </div>
      </td>
    </tr>`;
    return rowHtml + drawer;
  }).join('');
  tbody.innerHTML = html;
  markConflicts();
}
function markConflicts(){
  const inputs = document.querySelectorAll('input.cell-port');
  const by = new Map();
  inputs.forEach(i=>{
    const v = i.value;
    if(!v) return;
    if(!by.has(v)) by.set(v, []);
    by.get(v).push(i);
  });
  inputs.forEach(i=>i.classList.remove('conflict'));
  by.forEach((arr) => {
    if(arr.length > 1){
      arr.forEach(i=>{
        i.classList.add('conflict');
        const tr = i.closest('tr');
        const dot = tr.querySelector('.dot');
        if(dot){ dot.className = 'dot conf'; }
      });
    }
  });
}
function flash(el, msg){
  el.classList.add('flash'); el.title = msg;
  setTimeout(()=>el.classList.remove('flash'), 1200);
}
function toast(msg, kind){  // same (msg, kind) argument order as the dashboard's toast
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  if(kind === 'ok') setTimeout(()=>t.remove(), 2000);
  else t.onclick = ()=>t.remove();
}
async function refreshRows(force=false){
  try{
    const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/state`);
    const j = await r.json();
    if(j && j.rows){ DATA.rows = j.rows; renderTable(force === true); updateToolbar(); }
  }catch(e){ /* helper off — leave rows */ }
}
async function saveCell(input, field){
  const tr = input.closest('tr');
  const name = tr.dataset.name;
  let value = input.value.trim();
  if(field === 'dev_port'){
    if(value === '') value = null;
    else { value = parseInt(value, 10); if(Number.isNaN(value)){ toast('Port must be a number','err'); return; } }
  }
  const body = {project: name}; body[field] = value;
  try{
    const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/set`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    if(!r.ok){
      const e = await r.json().catch(()=>({error:'save failed'}));
      toast(e.error || 'save failed', 'err');
      input.classList.add('conflict');
      return;
    }
    const j = await r.json();
    input.classList.remove('dirty','conflict');
    input.dataset.orig = input.value;
    toast(j.restarted ? `Restarted on :${j.row.dev_port}` : 'Saved', 'ok');
    refreshRows();
  }catch(e){ toast('helper off','err'); }
}
document.getElementById('portsBody').addEventListener('input', e=>{
  const t = e.target;
  if(t.classList.contains('cell-port') || t.classList.contains('cell-path')){
    t.classList.toggle('dirty', t.value !== (t.dataset.orig||''));
  }
  if(t.classList.contains('cell-port')) markConflicts();
});
document.getElementById('portsBody').addEventListener('change', e=>{
  const t = e.target;
  if(t.classList.contains('cell-port')) saveCell(t, 'dev_port');
  else if(t.classList.contains('cell-path')) saveCell(t, 'dev_path');
});
document.getElementById('portsBody').addEventListener('click', async e=>{
  // Shared dev-state buttons first (Open/Stop/Restart from _DASHBOARD_DEV_JS).
  if(handleDevClick(e)) return;
  const start = e.target.closest('.act-start');
  if(start){
    const name = start.dataset.name;
    const tab = window.open('', '_blank');
    if(tab) { tab.opener = null; tab.document.write(devLoadingDoc('Starting ' + name)); }
    fetch(`/library/open?action=dev&path=${encodeURIComponent(start.dataset.path)}`)
      .then(r=>r.json()).then(async j=>{
        if(!j.ok || !j.url || (!j.launched && !j.already_running)) throw new Error(j.error || 'Could not launch dev server');
        for(let attempt=0; attempt<40; attempt++) {
          const status = await fetch(`/library/open?action=devstatus&path=${encodeURIComponent(start.dataset.path)}`).then(r=>r.json());
          if(status.listening) { if(tab) tab.location = j.url; refreshRows(); return; }
          await new Promise(resolve=>setTimeout(resolve, 500));
        }
        throw new Error('Server did not start within 20 seconds');
      }).catch(e=>{ if(tab) tab.close(); toast(e.message, 'err'); });
    return;
  }
  const clear = e.target.closest('.act-clear');
  if(clear){
    const name = clear.dataset.name;
    if(!confirm(`Clear port assignment for ${name}?`)) return;
    const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/clear`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({project:name}),
    });
    if(r.ok){ toast('Cleared','ok'); refreshRows(); }
    else { const j = await r.json().catch(()=>({})); toast(j.error||'clear failed','err'); }
    return;
  }
  const an = e.target.closest('.act-assign-next');
  if(an){
    // Server-side: post assign-missing. It assigns the next free port for any
    // project with no dev_port; we filter to find the one we clicked.
    const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/assign-missing`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
    });
    if(r.ok){
      const j = await r.json();
      const my = (j.assigned || []).find(a => a.project === an.dataset.name);
      toast(my ? `Assigned :${my.port}` : 'No change', 'ok');
      refreshRows();
    } else { toast('assign failed','err'); }
    return;
  }
});
document.getElementById('portsBody').addEventListener('click', async e=>{
  const ex = e.target.closest('.row-expand');
  if(ex){
    ex.classList.toggle('open');
    ex.textContent = ex.classList.contains('open') ? '▾' : '▸';
    const tr = ex.closest('tr');
    const drawer = tr.nextElementSibling;
    if(drawer && drawer.classList.contains('drawer')){
      drawer.style.display = drawer.style.display === 'none' ? '' : 'none';
    }
    return;
  }
  const save = e.target.closest('.dcmd-save');
  if(save){
    const name = save.dataset.name;
    const ta = document.querySelector(`textarea.dcmd[data-name="${name}"]`);
    const cmd = ta.value;
    const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/set`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({project:name, dev_cmd:cmd}),
    });
    if(r.ok){ toast('dev_cmd saved','ok'); refreshRows(true); }
    else { const j = await r.json().catch(()=>({})); toast(j.error||'save failed','err'); }
    return;
  }
  const cancel = e.target.closest('.dcmd-cancel');
  if(cancel){
    refreshRows(true);
    return;
  }
  const det = e.target.closest('.dcmd-detect');
  if(det){
    const name = det.dataset.name;
    const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/detect-cmd`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({project:name}),
    });
    const j = await r.json().catch(()=>({}));
    const sug = document.querySelector(`.dcmd-suggest[data-name="${name}"]`);
    if(r.ok && j.cmd){
      sug.innerHTML = `Suggested (<i>${esc(j.source||'')}</i>): <code>${esc(j.cmd)}</code>
        <button class="btn dcmd-use" data-name="${esc(name)}" data-cmd="${esc(j.cmd)}">Use this</button>`;
    } else {
      sug.textContent = 'No suggestion';
    }
    return;
  }
  const use = e.target.closest('.dcmd-use');
  if(use){
    const ta = document.querySelector(`textarea.dcmd[data-name="${use.dataset.name}"]`);
    ta.value = use.dataset.cmd;
  }
});
window.onDevState = renderTable;
renderTable();

function updateToolbar(){
  const liveNames = Object.keys(DEV_STATE || {});
  const el = document.getElementById('runSummary');
  if(liveNames.length === 0){
    el.textContent = 'Nothing running. Start one from the table below.';
    el.style.color = '#8b949e';
  } else {
    el.textContent = `Running ${liveNames.length} / ${DATA.rows.length}`;
    el.style.color = '';
  }
  const missing = DATA.rows.filter(r => r.dev_port == null).length;
  const btn = document.getElementById('assignMissing');
  btn.textContent = `Assign missing (${missing})`;
  btn.disabled = missing === 0;
}
const prevOnDev = window.onDevState;
window.onDevState = ()=>{ if(prevOnDev) prevOnDev(); updateToolbar(); };
updateToolbar();

document.getElementById('dpbSave').addEventListener('click', async ()=>{
  const v = parseInt(document.getElementById('dpb').value, 10);
  if(!(v >= 1024 && v <= 65535)){ toast('dev_port_base out of range','err'); return; }
  const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/config`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({dev_port_base: v}),
  });
  if(r.ok){ toast('dev_port_base saved','ok'); DATA.dev_port_base = v; refreshRows(); }
  else { toast('save failed','err'); }
});

document.getElementById('assignMissing').addEventListener('click', async ()=>{
  const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/ports/assign-missing`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
  });
  if(!r.ok){ toast('assign failed','err'); return; }
  const j = await r.json();
  const n = (j.assigned||[]).length;
  if(n === 0){ toast('Nothing to assign','ok'); }
  else {
    const ports = j.assigned.map(a=>a.port).sort((a,b)=>a-b);
    const range = ports.length>1 ? `${ports[0]}–${ports[ports.length-1]}` : ports[0];
    toast(`Assigned ${n} ports (${range})`,'ok');
  }
  refreshRows();
});

document.getElementById('stopAll').addEventListener('click', ()=>{
  Object.keys(DEV_STATE).forEach(n=>devAction('stop', n));
});

document.getElementById('reload').addEventListener('click', ()=>{
  refreshRows(); pollDevState();
});

setInterval(pollDevState, 3000);
pollDevState();
</script>
"""


DASHBOARD_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devhub — ~/Arik/dev</title>
<!-- Inline SVG favicon (data URI) so the self-contained dashboard never 404s
     on /favicon.ico — works offline, on file://, and when hosted. -->
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%230a1623'/%3E%3Crect%20x='2.6'%20y='2.6'%20width='26.8'%20height='26.8'%20rx='5'%20fill='none'%20stroke='%235fd2e6'%20stroke-width='1.4'%20opacity='.45'/%3E%3Cpath%20d='M9%2011l6%205-6%205'%20fill='none'%20stroke='%235fd2e6'%20stroke-width='2.6'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3Cpath%20d='M17%2021h6'%20stroke='%235fd2e6'%20stroke-width='2.6'%20stroke-linecap='round'/%3E%3C/svg%3E">
<style>
  :root{
    --bg:#0a1623; --panel:#0d1d2c; --panel2:#102536; --border:#1d3a52;
    --line:#2a5573; --text:#dcebf3; --muted:#82a8bf; --faint:#587d94;
    --accent:#5fd2e6; --accent-dim:#3fb6cc; --accent-bg:#103040; --accent-bg2:#164253;
    --green:#5fd6a0; --amber:#e7c061; --red:#e8786a; --chip:#102536;
    --violet:#c8a8ff; --teal:#6fd6c0; --orange:#ffb454;
    --mono:ui-monospace,"SF Mono","SFMono-Regular",Menlo,Consolas,monospace;
    --sans:"Avenir Next","Helvetica Neue",-apple-system,Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;color:var(--text);
    font:13px/1.55 var(--mono);-webkit-font-smoothing:antialiased;
    background:
      linear-gradient(rgba(95,210,230,.045) 1px,transparent 1px) 0 0/27px 27px,
      linear-gradient(90deg,rgba(95,210,230,.045) 1px,transparent 1px) 0 0/27px 27px,
      radial-gradient(1100px 620px at 82% -12%, rgba(95,210,230,.07), transparent 60%),
      var(--bg);
    background-attachment:fixed}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .wrap{max-width:1200px;margin:0 auto;padding:34px 26px 90px}
  /* titleblock header */
  header{position:relative;display:flex;justify-content:space-between;align-items:flex-start;gap:18px;
    border:1px solid var(--line);border-radius:4px;padding:20px 24px;
    background:linear-gradient(180deg,rgba(95,210,230,.045),transparent)}
  header::before,header::after{content:"";position:absolute;width:11px;height:11px;border:1.5px solid var(--accent)}
  header::before{top:-1px;left:-1px;border-right:none;border-bottom:none}
  header::after{bottom:-1px;right:-1px;border-left:none;border-top:none}
  header h1{margin:0;font:600 32px/1 var(--sans);letter-spacing:1px;color:var(--text)}
  header h1 b{color:var(--accent);font-weight:600}
  header .hpath{color:var(--muted);font:400 14px var(--mono)}
  header .sub{color:var(--muted);font-size:11px;margin-top:9px;letter-spacing:.3px}
  header .stamp{text-align:right;color:var(--faint);font:600 10px/1.7 var(--mono);
    letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap}
  /* settings gear + menu */
  .hdr-right{display:flex;align-items:flex-start;gap:14px}
  .settings{position:relative}
  .gear{background:var(--panel);border:1px solid var(--line);border-radius:4px;
    color:var(--muted);font-size:17px;line-height:1;width:32px;height:32px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;transition:.12s}
  .gear:hover{color:var(--accent);border-color:var(--accent-dim)}
  .gear[aria-expanded="true"]{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}
  .gear-menu{position:absolute;right:0;top:38px;z-index:60;display:none;min-width:208px;
    background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:6px;
    box-shadow:0 14px 34px rgba(2,8,14,.55)}
  .gear-menu.open{display:block}
  .gm-label{color:var(--faint);font:10px/1 var(--mono);text-transform:uppercase;letter-spacing:1.2px;
    padding:7px 9px 5px}
  .gm-item{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);
    font:13px var(--mono);padding:7px 9px;border-radius:4px;cursor:pointer}
  .gm-item:hover{background:var(--accent-bg);color:var(--accent)}
  .gm-sep{height:1px;background:var(--line);margin:6px 4px;opacity:.6}
  .gm-foot{display:flex;align-items:center;gap:7px;padding:8px 9px 5px;color:var(--faint);
    font:11px var(--mono);border-top:1px solid var(--line);margin-top:6px}
  .gm-dot{width:8px;height:8px;border-radius:50%;flex:none}
  .gm-dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .gm-dot.off{background:var(--faint)}
  .cf-hint{color:var(--faint);font:10px var(--mono);text-transform:none;letter-spacing:0;font-weight:400}
  /* stats */
  .stats{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 8px}
  .stat{flex:1;min-width:118px;position:relative;background:var(--panel);
    border:1px solid var(--border);border-radius:4px;padding:14px 16px}
  .stat::after{position:absolute;top:8px;right:11px;color:var(--faint);font:10px/1 var(--mono);letter-spacing:1px}
  .stat:nth-child(1)::after{content:"01"} .stat:nth-child(2)::after{content:"02"}
  .stat:nth-child(3)::after{content:"03"} .stat:nth-child(4)::after{content:"04"}
  .stat:nth-child(5)::after{content:"05"} .stat:nth-child(6)::after{content:"06"}
  .stat .n{font:600 28px/1 var(--sans);color:var(--accent);font-variant-numeric:tabular-nums}
  .stat .l{color:var(--muted);font:10px/1.3 var(--mono);text-transform:uppercase;letter-spacing:1.3px;margin-top:7px}
  .stat.warn .n{color:var(--amber)} .stat.bad .n{color:var(--red)}
  /* toolbar */
  .toolbar{display:flex;gap:10px;align-items:center;margin:18px 0 6px;flex-wrap:wrap}
  #q{flex:1;min-width:220px;background:var(--panel);border:1px solid var(--line);
    color:var(--text);border-radius:4px;padding:11px 13px;font:13px var(--mono)}
  #q::placeholder{color:var(--faint)}
  #q:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 1px rgba(95,210,230,.25)}
  .filters{display:flex;gap:7px;flex-wrap:wrap}
  .filt{background:var(--panel);border:1px solid var(--border);color:var(--muted);
    padding:7px 12px;border-radius:3px;cursor:pointer;font:12px var(--mono);letter-spacing:.3px}
  .filt:hover{border-color:var(--line);color:var(--text)}
  .filt.active{color:var(--bg);border-color:var(--accent);background:var(--accent);font-weight:600}
  /* category */
  .cat{margin-top:30px}
  .cat h2{font:600 14px/1 var(--sans);letter-spacing:2px;text-transform:uppercase;color:var(--accent);
    margin:0 0 4px;display:flex;align-items:center;gap:10px;border-bottom:1px dashed var(--line);padding-bottom:10px}
  .cat h2 .count{color:var(--faint);font:600 12px var(--mono);letter-spacing:1px;margin-left:auto;text-transform:none}
  .cat h2 .count::before{content:"[ "} .cat h2 .count::after{content:" ]"}
  .cat .blurb{color:var(--muted);font:12px/1.5 var(--mono);margin:9px 0 14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
  /* card */
  div.card{position:relative;background:var(--panel);border:1px solid var(--border);border-radius:4px;
    padding:15px 16px;display:flex;flex-direction:column;gap:9px;transition:border-color .15s,box-shadow .15s}
  div.card::before,div.card::after{content:"";position:absolute;width:7px;height:7px;border:1px solid var(--line);opacity:.5;pointer-events:none}
  div.card::before{top:5px;left:5px;border-right:none;border-bottom:none}
  div.card::after{bottom:5px;right:5px;border-left:none;border-top:none}
  div.card:hover{border-color:var(--accent-dim);box-shadow:0 0 0 1px rgba(95,210,230,.18)}
  .card .top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
  .card .name{font:600 16px/1.15 var(--sans);letter-spacing:.4px;color:var(--text)}
  div.card:hover .name{color:var(--accent)}
  .card .desc{color:var(--muted);font-size:12px;min-height:18px;line-height:1.5}
  .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
  .badge{font:10.5px/1.4 var(--mono);padding:3px 8px;border-radius:3px;background:var(--panel2);
    color:var(--muted);border:1px solid var(--border);letter-spacing:.3px}
  .badge.lang{color:var(--accent);border-color:var(--line)}
  .badge.dirty{color:var(--amber);border-color:#4a3c1a}
  .badge.ahead{color:var(--amber);border-color:#4a3c1a;font-weight:600}
  .badge.behind{color:#7fb0e8;border-color:#26405c}
  .badge.noup{color:#d89b6a;border-color:#4a3320}
  .badge.stash{color:var(--muted);border-color:var(--line)}
  .badge.stale{color:var(--red);border-color:#4a2424}
  .badge.noreadme{color:#a99adf;border-color:#33294a}
  .gitactions .gitbtn{border-color:var(--line)}
  .gitactions .gitbtn:hover{border-color:var(--accent);color:var(--accent)}
  .gitactions .gitbtn:disabled{opacity:.5;cursor:default}
  .gittoast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(14px);
    background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;
    padding:9px 16px;font:12px var(--mono);opacity:0;pointer-events:none;z-index:9999;max-width:78vw;
    box-shadow:0 14px 40px -12px rgba(0,0,0,.7);transition:opacity .2s,transform .2s;white-space:pre-wrap}
  .gittoast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .gittoast.err{border-color:#4a2424;color:var(--red)}
  .meta{display:flex;justify-content:space-between;color:var(--faint);font:10.5px var(--mono);
    border-top:1px dashed var(--border);padding-top:9px;margin-top:2px;letter-spacing:.2px}
  .dot{display:inline-block;width:7px;height:7px;border-radius:0;transform:rotate(45deg);
    margin-right:8px;vertical-align:middle;position:relative;top:-1px}
  .dot.g{background:var(--green)} .dot.a{background:var(--amber)} .dot.r{background:var(--red)}
  /* refs */
  .refs{margin-top:14px;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:4px 2px}
  .refs-h{color:var(--faint);font:600 10px var(--mono);text-transform:uppercase;letter-spacing:1.4px;margin:8px 12px 4px}
  .ref{display:flex;align-items:center;gap:10px;padding:8px 13px;border-radius:3px;color:var(--text);border-bottom:1px dashed var(--border)}
  .ref:hover{background:var(--accent-bg);text-decoration:none}
  .ref-ic{width:18px;text-align:center;font-size:13px;color:var(--accent)}
  .ref-ic.youtube{color:var(--red)} .ref-ic.repo{color:var(--green)} .ref-ic.link{color:var(--accent)}
  .ref-t{flex:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ref-ty{font:10px var(--mono);color:var(--faint);text-transform:uppercase;border:1px solid var(--border);padding:2px 7px;border-radius:3px}
  .ref-noteic{font-size:11px;opacity:.8;flex:none}
  .ref-wrap{border-bottom:1px dashed var(--border)}
  .ref-wrap > .ref{border-bottom:none}
  .ref-notes{margin:0 13px 8px;border:1px solid var(--border);border-left:2px solid var(--accent);border-radius:3px;background:rgba(95,210,230,.03)}
  .ref-notes > summary{cursor:pointer;list-style:none;padding:6px 10px;font:600 10.5px var(--mono);color:var(--accent);text-transform:uppercase;letter-spacing:1px;user-select:none}
  .ref-notes > summary::-webkit-details-marker{display:none}
  .ref-notes[open] > summary{border-bottom:1px dashed var(--border)}
  .ref-notes-body{max-height:380px;overflow:auto;padding:10px 12px;font:12px/1.5 var(--mono);color:var(--text);white-space:pre-wrap;word-break:break-word}
  .ref-notes-body a{color:var(--accent)}
  /* strays */
  .strays{margin-top:30px;background:var(--panel);border:1px dashed var(--amber);border-radius:4px;padding:16px 18px;position:relative}
  .strays h2{margin:0 0 8px;font:600 13px var(--sans);letter-spacing:1.5px;text-transform:uppercase;color:var(--amber)}
  .stray-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed var(--border);font:12px var(--mono)}
  .stray-row:last-child{border-bottom:none}
  footer{margin-top:42px;color:var(--faint);font:10.5px var(--mono);text-align:center;letter-spacing:1px;text-transform:uppercase;
    border-top:1px dashed var(--border);padding-top:20px}
  code{background:var(--panel2);border:1px solid var(--border);padding:1px 6px;border-radius:3px;font:11.5px var(--mono);color:var(--accent)}
  .card.clickable{cursor:pointer}
  .card.clickable .name{color:var(--text)}
  /* modal */
  .modal{position:fixed;inset:0;background:rgba(4,10,18,.74);display:none;align-items:flex-start;justify-content:center;padding:48px 16px;z-index:50;overflow:auto}
  .modal.open{display:flex}
  .modal-card{background:var(--panel);border:1px solid var(--line);border-radius:5px;max-width:660px;width:100%;padding:24px 26px;position:relative}
  .modal-card::before,.modal-card::after{content:"";position:absolute;width:12px;height:12px;border:1.5px solid var(--accent);pointer-events:none}
  .modal-card::before{top:-1px;left:-1px;border-right:none;border-bottom:none}
  .modal-card::after{bottom:-1px;right:-1px;border-left:none;border-top:none}
  .modal-x{position:absolute;top:10px;right:14px;background:none;border:none;color:var(--muted);font-size:26px;cursor:pointer;line-height:1}
  .modal-x:hover{color:var(--accent)}
  .dhead{display:flex;align-items:baseline;gap:12px;margin-bottom:4px;padding-right:26px}
  .dtitle{font:600 20px var(--sans);letter-spacing:.5px}
  .dcat{color:var(--accent);font:11px var(--mono);text-transform:uppercase;letter-spacing:1px;border:1px solid var(--line);padding:3px 9px;border-radius:3px;white-space:nowrap}
  .ddesc{color:var(--text);font-size:13px;margin:10px 0 12px;line-height:1.55}
  .dbadges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .dgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}
  .drow{display:flex;flex-direction:column;border-top:1px dashed var(--border);padding-top:6px;font-size:12.5px}
  .dk{color:var(--faint);font:10px var(--mono);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px}
  .dv{color:var(--text);word-break:break-word}
  .dsec{margin-top:16px;margin-bottom:4px;color:var(--accent);font:10px var(--mono);text-transform:uppercase;letter-spacing:1.4px}
  .commit{font:12px var(--mono);padding:6px 0;border-top:1px dashed var(--border);color:var(--text)}
  .cdate{color:var(--faint);margin-right:9px;font-variant-numeric:tabular-nums}
  .dactions{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
  .btn{background:var(--accent-bg);border:1px solid var(--accent-dim);color:var(--accent);
    padding:8px 13px;border-radius:3px;font:12px var(--mono);cursor:pointer;line-height:1.2;letter-spacing:.3px}
  .btn:hover{text-decoration:none;background:var(--accent-bg2);border-color:var(--accent)}
  /* collapse */
  .cat-h{cursor:pointer;user-select:none}
  .chev{display:inline-block;transition:transform .15s;color:var(--faint);font-size:11px}
  .cat.collapsed .chev{transform:rotate(-90deg)}
  .cat.collapsed .cat-body{display:none}
  .collapsectl{display:flex;gap:7px}
  .mini{background:var(--panel);border:1px solid var(--border);color:var(--muted);
    padding:8px 12px;border-radius:3px;font:12px var(--mono);cursor:pointer;letter-spacing:.3px}
  .mini:hover{color:var(--text);border-color:var(--line)}
  .ref-dom{font:10px var(--mono);color:var(--faint);opacity:.9;margin-right:6px;white-space:nowrap}
  .badge.dom{color:var(--teal);border-color:#1f4a44}
  .dom-chip{cursor:pointer}
  .badge.dom.dom-chip:hover{border-color:var(--accent);color:#a8e8da}
  .ref-dom.dom-chip:hover{color:var(--accent);text-decoration:underline}
  /* Author byline next to the project name — only emitted when p.mine===false
     (own repos stay clean; the absence is the signal). Inline with the name,
     muted by default, clickable to pin the owner filter. */
  .name .author{display:inline-flex;align-items:center;gap:2px;margin-left:8px;padding:0 5px;border-radius:3px;
                font:11px var(--mono);font-weight:400;color:var(--faint);text-transform:none;letter-spacing:0;
                border:1px solid transparent;background:transparent;cursor:pointer;vertical-align:middle}
  .name .author:hover{color:#cfcfcf;border-color:#3a3a3a;background:rgba(255,255,255,.04)}
  .name .author.active{color:#fff;border-color:var(--accent);background:rgba(111,214,192,.10)}
  .name-cell .author{font:11px var(--mono);color:var(--faint);margin-left:8px;padding:0 5px;border-radius:3px;
                     border:1px solid transparent;cursor:pointer}
  .name-cell .author:hover{color:#cfcfcf;border-color:#3a3a3a;background:rgba(255,255,255,.04)}
  .name-cell .author.active{color:#fff;border-color:var(--accent);background:rgba(111,214,192,.10)}
  /* Restore hover-accent on the project title — the inline tagHue color on
     .nametext defeats the cascade-based `.card:hover .name{color}` rule. */
  div.card:hover .name .nametext{color:var(--accent) !important}
  /* Focus ring for keyboard users on the author/owner pills. */
  .author:focus-visible{outline:2px solid var(--accent);outline-offset:1px;color:#fff;border-color:var(--accent)}
  /* Source-mode select in the toolbar */
  select.mini{background:#0f0f0f;color:var(--ink);border:1px solid #2a2a2a;border-radius:4px;padding:3px 6px;font:11px var(--mono);cursor:pointer}
  select.mini:hover{border-color:#444}
  select.mini.active{border-color:var(--accent);color:#fff}
  .topic{margin-top:8px;padding:7px 9px;background:rgba(95,210,230,.04);border:1px solid var(--border);border-left:2px solid var(--accent);border-radius:3px}
  .topic-h{font:600 10.5px var(--mono);color:var(--accent);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:3px;cursor:pointer}
  .topic-h:hover{color:#a8e8da}
  .badge.linkn{color:var(--teal);border-color:#1f4a44}
  .badge.method{color:var(--accent);border-color:var(--line);text-transform:lowercase;background:rgba(95,210,230,.06)}
  .badge.subn{color:var(--violet);border-color:#33294a;background:rgba(200,168,255,.06)}
  .badge.tag{color:var(--tc,var(--violet));border-color:var(--tbd,#33294a);background:var(--tbg,rgba(200,168,255,.06))}
  .tag-chip{cursor:pointer}
  .badge.tag.tag-chip:hover{filter:brightness(1.3) saturate(1.1)}
  .badge.rel{color:var(--orange);border-color:#4a3a1a;background:rgba(255,180,84,.06)}
  .rel-chip{cursor:pointer}
  .badge.rel.rel-chip:hover{border-color:var(--orange);color:#ffd0a0}
  #activeFilter{display:flex;gap:8px;margin:8px 0;flex-wrap:wrap}
  #activeFilter:empty{display:none}
  .afilt{background:var(--accent-bg);border:1px solid var(--accent);color:var(--accent);
    padding:6px 12px;border-radius:3px;font:12px var(--mono);display:inline-flex;align-items:center;gap:8px}
  .afilt-x{cursor:pointer;opacity:.75;font-weight:600;line-height:1}
  .afilt-x:hover{opacity:1;color:#fff}
  .viewbtns{display:flex;gap:0}
  .viewbtn{background:var(--panel);border:1px solid var(--border);color:var(--muted);
    padding:8px 13px;font:12px var(--mono);cursor:pointer;letter-spacing:.4px}
  .viewbtn:not(:last-child){border-right:none}
  .viewbtn:first-child{border-radius:3px 0 0 3px}
  .viewbtn:last-child{border-radius:0 3px 3px 0}
  .viewbtn.active{color:var(--bg);background:var(--accent);border-color:var(--accent);font-weight:600}
  /* explorer (tree) view */
  .tree{font:12.5px var(--mono);background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:6px 12px 12px;margin-bottom:14px}
  .tchildren{margin-left:9px;padding-left:10px;border-left:1px solid var(--border)}
  .tnode.collapsed > .tchildren{display:none}
  .trow{display:flex;align-items:center;gap:7px;padding:3px 5px;border-radius:3px;white-space:nowrap}
  .tprow,.tcat-row,.tfolder-row{cursor:pointer}
  .tprow:hover,.tcat-row:hover,.tref:hover,.tfolder-row:hover,.tfile:hover{background:var(--accent-bg)}
  .tfile{text-decoration:none}
  .tfile .tfico{opacity:.65}
  .tfile .tname{color:var(--text);font-weight:400}
  .tfile:hover .tname{color:var(--accent)}
  .tname code{font:11px var(--mono);color:var(--accent);background:var(--accent-bg);padding:1px 5px;border-radius:3px}
  .tchev{display:inline-block;width:12px;flex:0 0 auto;text-align:center;color:var(--faint);font-size:10px;transition:transform .15s}
  .tnode:not(.collapsed) > .trow .tchev{transform:rotate(90deg)}
  .tchev-empty{visibility:hidden}
  .tfico{flex:0 0 auto;opacity:.9}
  .tname{overflow:hidden;text-overflow:ellipsis;color:var(--text)}
  .tcatname{font-weight:600}
  .tprow .tname{color:var(--accent);font-weight:600}
  .tref .tname{font-weight:400;color:var(--text)}
  .tcount{color:var(--faint);font-size:11px;margin-left:6px;white-space:nowrap}
  .tmeta{display:flex;align-items:center;gap:6px;margin-left:8px;color:var(--faint);font:11px var(--mono);flex-wrap:wrap}
  .tdeploy{color:var(--teal);text-decoration:none}
  .tdeploy:hover{color:#a8e8da;text-decoration:underline}
  .tdom{color:var(--faint);opacity:.85}
  .troot-row{cursor:default}
  .troot-row:hover{background:none}
  .trootname{color:var(--muted);font-weight:600}
  .tref{text-decoration:none}
  .tref .tfico{color:var(--accent)}
  .tnode.archived > .trow .tname{opacity:.55}
  .tnode.archived > .trow .tname::before{content:"\01F4E6  ";opacity:.7}
  /* list view */
  .lhead{font:600 13px var(--sans);letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);margin:22px 0 6px;display:flex;align-items:baseline;gap:10px}
  .lhead .lcount{color:var(--faint);font:400 12px var(--mono);text-transform:none}
  .ltable{width:100%;border-collapse:collapse;font:12.5px var(--mono);background:var(--panel);border:1px solid var(--border);border-radius:4px;overflow:hidden;margin-bottom:14px}
  .ltable thead{background:var(--panel2)}
  .ltable th{text-align:left;padding:9px 11px;font-weight:600;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;cursor:pointer;user-select:none;border-bottom:1px solid var(--line);white-space:nowrap}
  .ltable th:hover{color:var(--text)}
  .ltable th.sorted{color:var(--accent)}
  .ltable th .arrow{font-size:9px;opacity:.8;margin-left:3px}
  .ltable td{padding:9px 11px;border-bottom:1px dashed var(--border);vertical-align:middle;color:var(--text)}
  .ltable tr:last-child td{border-bottom:none}
  .ltable tr.card{cursor:pointer}
  .ltable tr.card:hover{background:var(--accent-bg)}
  .ltable .name-cell{font-weight:600;color:var(--accent)}
  .ltable .meta-cell{color:var(--faint);white-space:nowrap}
  .ltable .tags-cell{display:flex;gap:4px;flex-wrap:wrap}
  .ltable .title-cell{max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ltable .title-cell a{color:var(--text)}
  .ltable .title-cell a:hover{color:var(--accent);text-decoration:underline}
  .note{color:#9fc1d6;font:12px var(--mono);border-left:2px solid var(--accent);padding:3px 0 3px 9px;margin-top:-2px}
  .card.archived{opacity:.5}
  .card.archived:hover{opacity:.82}
  .card.archived .name::before{content:"\01F4E6  ";opacity:.7;font-style:normal}
  .tagrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .tagrow .tagrow-label{font:10px var(--mono);color:var(--faint);text-transform:uppercase;letter-spacing:1.2px;margin-right:6px}
  .filt.tag{color:var(--tc,var(--violet));border-color:var(--tbd,#33294a)}
  .filt.tag.active{background:#2a2040;border-color:var(--tc,#a371f7);color:#fff}
  .archtoggle{margin-left:auto}
  .ltable tr.archived{opacity:.5}
  .ltable tr.archived .name-cell::before{content:"\01F4E6  ";opacity:.7}
  /* quick actions: ★ favorite / 📌 pin / 📦 archive. Off-state buttons are
     hover-revealed; an "on" button stays visible as the state indicator. */
  .qa{display:inline-flex;gap:1px;align-items:center;flex:none}
  .qa-btn{background:none;border:none;cursor:pointer;font:13px var(--mono);line-height:1;
    padding:2px 4px;border-radius:3px;color:var(--faint)}
  .qa-btn:hover{background:var(--panel2);color:var(--text)}
  .qa-btn:not(.on){visibility:hidden;opacity:.65}
  .qa-btn:not(.on):hover{opacity:1}
  div.card:hover .qa-btn, .ltable tr.card:hover .qa-btn, .trow:hover .qa-btn{visibility:visible}
  .qa-pin:not(.on),.qa-arch:not(.on){filter:grayscale(1)}
  .qa-fav.on{color:var(--amber)}
  .name-cell .qa{margin-left:6px;vertical-align:middle}
  div.card.pinned{border-left:2px solid var(--amber)}
  .ltable tr.pinned .name-cell{box-shadow:inset 2px 0 0 var(--amber)}
  .filters-block{display:flex;flex-direction:column;gap:7px}
  .mini.addbtn{color:var(--green);border-color:#1f4a36}
  .mini.addbtn:hover{color:#8ce8b8;border-color:var(--green);background:rgba(16,48,34,.55)}
  .open-btn{margin-left:4px;color:var(--accent);text-decoration:none;font:10px var(--mono);padding:2px 6px;border-radius:3px;background:rgba(95,210,230,.08);border:1px solid var(--border)}
  .open-btn:hover{background:rgba(95,210,230,.18);text-decoration:none}
  .badge.dom-link{color:var(--teal);border-color:#1f4a44;text-decoration:none;background:rgba(111,214,192,.05);cursor:pointer}
  .badge.dom-link:hover{color:#a8e8da;border-color:var(--accent);background:rgba(111,214,192,.13);text-decoration:none}
  .desc a, .note a{color:var(--accent);text-decoration:underline;text-decoration-color:rgba(95,210,230,.4)}
  .desc a:hover, .note a:hover{text-decoration-color:var(--accent)}
  .editform{margin-top:14px;background:var(--panel2);border:1px solid var(--border);border-radius:4px;padding:15px}
  .editform label{display:block;font:10px var(--mono);color:var(--faint);text-transform:uppercase;letter-spacing:1px;margin:9px 0 3px}
  .editform input[type=text],.editform input[type=number],.editform textarea,.editform select{
    width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:8px 10px;font:13px var(--mono)}
  .editform input[type=text]:focus,.editform input[type=number]:focus,.editform textarea:focus,.editform select:focus{outline:none;border-color:var(--accent)}
  .editform textarea{resize:vertical;min-height:60px}
  .editform .row{display:flex;gap:10px;align-items:flex-end}
  .editform .row > div{flex:1}
  .editform .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .editform .actions .right{margin-left:auto}
  .btn.danger{color:var(--red);border-color:#4a2020;background:#2a1414}
  .btn.danger:hover{background:#3a1818}
  .btn.success{color:var(--green);border-color:#1f4a36;background:#103022}
  .btn.success:hover{background:#164a30}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--line);color:var(--text);padding:11px 18px;border-radius:4px;font:13px var(--mono);z-index:100;box-shadow:0 8px 26px rgba(0,0,0,.5);opacity:0;transition:opacity .15s}
  .toast.show{opacity:1}
  .toast.err{border-color:var(--red);color:var(--red)}
  .toast.ok{border-color:var(--green);color:var(--green)}
  .tagedit-chip{display:inline-flex;align-items:center;gap:4px;font:11px var(--mono);padding:3px 4px 3px 10px;border-radius:3px;background:rgba(200,168,255,.08);border:1px solid #33294a;color:var(--violet)}
  .tagedit-chip .x{cursor:pointer;padding:0 5px;border-radius:3px;opacity:.7}
  .tagedit-chip .x:hover{opacity:1;background:rgba(255,255,255,.1)}
  .tagedit-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
  #running-panel{margin:0 0 14px;padding:10px 14px;border:1px solid #21262d;border-radius:8px;background:#0d1117}
  #running-panel h3{margin:0 0 8px;font-size:12px;letter-spacing:.08em;color:#8b949e;text-transform:uppercase}
  .run-item{display:inline-flex;align-items:center;gap:6px;margin:3px 10px 3px 0;font:12px ui-monospace,monospace}
  .dot-live{color:#3fb950}
  .dev-status{font:12px ui-monospace,monospace;color:#3fb950;margin:4px 0}
  .header-ports{margin-right:8px;text-decoration:none;color:inherit}
  /* list view — refined + per-list customize gear */
  .lhead{align-items:center;border-bottom:1px solid var(--line);padding-bottom:7px;margin:24px 0 9px}
  .lhead .lcount{margin-left:1px;padding:1px 9px;border:1px solid var(--border);border-radius:11px;background:var(--panel2);color:var(--muted);font-size:11px}
  .ltable{box-shadow:0 10px 26px -18px rgba(0,0,0,.85)}
  .ltable td{border-bottom:1px solid rgba(120,170,200,.07)}
  .ltable tbody tr.card{transition:background .12s ease,box-shadow .12s ease}
  .ltable tbody tr.card:hover{background:var(--accent-bg);box-shadow:inset 3px 0 0 var(--accent)}
  .ltable td.meta-cell{font-variant-numeric:tabular-nums}
  .ltable.dense th,.ltable.dense td{padding:4px 11px}
  .ltable.zebra tbody tr.card:nth-child(even){background:rgba(120,170,200,.04)}
  .ltable.zebra tbody tr.card:nth-child(even):hover{background:var(--accent-bg)}
  .ltable.hc-category [data-col="category"],
  .ltable.hc-language [data-col="language"],
  .ltable.hc-branch [data-col="branch"],
  .ltable.hc-domain [data-col="domain"],
  .ltable.hc-last_activity [data-col="last_activity"],
  .ltable.hc-created [data-col="created"],
  .ltable.hc-modified [data-col="modified"],
  .ltable.hc-tags [data-col="tags"]{display:none}
  .lwrap{position:relative;margin-left:auto}
  .lgear{background:var(--panel);border:1px solid var(--border);border-radius:4px;color:var(--muted);
    width:28px;height:26px;line-height:1;cursor:pointer;font-size:14px;display:inline-flex;
    align-items:center;justify-content:center;transition:color .12s,border-color .12s,background .12s}
  .lgear:hover{color:var(--accent);border-color:var(--accent-dim)}
  .lgear[aria-expanded="true"]{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}
  .lmenu{position:absolute;right:0;top:32px;z-index:60;display:none;min-width:212px;
    background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px;
    box-shadow:0 16px 44px -14px rgba(0,0,0,.75)}
  .lmenu.open{display:block}
  .lmenu-h{color:var(--faint);font:10px/1 var(--mono);text-transform:uppercase;letter-spacing:1.2px;padding:6px 7px 5px}
  .lmenu-sep{height:1px;background:var(--line);margin:6px 4px;opacity:.6}
  .lcol-row{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:4px;cursor:pointer;
    font:12.5px var(--mono);color:var(--text);text-transform:none;letter-spacing:0}
  .lcol-row:hover{background:var(--accent-bg)}
  .lcol-row input{accent-color:var(--accent);cursor:pointer;margin:0}
  .lreset{display:block;width:100%;text-align:left;background:none;border:none;color:var(--muted);
    font:10px var(--mono);padding:6px 8px;border-radius:4px;cursor:pointer;text-transform:uppercase;letter-spacing:1px}
  .lreset:hover{background:var(--accent-bg);color:var(--accent)}
  .lhint{font:10.5px var(--mono);color:var(--faint);padding:4px 8px 7px;text-transform:none;letter-spacing:0;line-height:1.4}
  /* list view — resizable + draggable columns */
  .ltable th{position:relative}
  .ltable th.dragging{opacity:.4}
  .ltable th.drop-target{box-shadow:inset 2px 0 0 var(--accent)}
  .ltable th.drop-target.drop-after{box-shadow:inset -2px 0 0 var(--accent)}
  .cresize{position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;user-select:none;z-index:3}
  .cresize::after{content:"";position:absolute;top:24%;right:3px;width:2px;height:52%;background:var(--border);opacity:0;transition:opacity .12s}
  .cresize:hover::after{opacity:1;background:var(--accent)}
  .ltable.resizing{cursor:col-resize;user-select:none}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>dev<b>hub</b> <span class="hpath">· ~/Arik/dev</span></h1>
      <div class="sub">Generated __GENERATED__ · static snapshot · regenerate with <code>python3 _devhub/devhub.py index</code></div>
    </div>
    <div class="hdr-right">
      <a class="btn header-ports" href="http://127.0.0.1:__HELPER_PORT__/ports" target="_blank" title="Ports & dev servers">Ports</a>
      <div class="settings" id="settingsWrap">
        <button id="gearBtn" class="gear" aria-haspopup="true" aria-expanded="false" aria-label="Settings" title="Settings">&#9881;</button>
        <div id="gearMenu" class="gear-menu" role="menu" aria-label="Settings">
          <div class="gm-label">Open workspace in</div>
          <button class="gm-item" role="menuitem" data-ws="terminal">Terminal</button>
          <button class="gm-item" role="menuitem" data-ws="finder">Finder</button>
          <button class="gm-item" role="menuitem" data-ws="vscode">VS Code</button>
          <div class="gm-sep"></div>
          <button class="gm-item" role="menuitem" id="gmConfig">Config&hellip;</button>
          <button class="gm-item" role="menuitem" id="gmPorts">Ports &amp; dev servers&hellip;</button>
          <button class="gm-item" role="menuitem" id="gmRestart" title="Restart the local helper so code &amp; helper_port changes take effect">Restart helper</button>
          <button class="gm-item" role="menuitem" id="gmLogout" style="display:none">Sign out</button>
          <div class="gm-foot"><span id="gmDot" class="gm-dot off"></span><span id="gmDotTxt">helper offline</span></div>
        </div>
      </div>
      <div class="stamp">Workspace<br>Schematic<br>Sheet 1 / 1</div>
    </div>
  </header>

  <div id="running-panel" style="display:none"></div>

  <div class="stats">
    <div class="stat"><div class="n">__TOTAL__</div><div class="l">Projects</div></div>
    <div class="stat"><div class="n">__NCATS__</div><div class="l">Categories</div></div>
    <div class="stat"><div class="n">__LINKS__</div><div class="l">Links</div></div>
    <div class="stat warn"><div class="n">__DIRTY__</div><div class="l">Uncommitted</div></div>
    <div class="stat warn"><div class="n">__UNPUSHED__</div><div class="l">Unpushed</div></div>
    <div class="stat bad"><div class="n">__STALE__</div><div class="l">Stale &gt;__THR__d</div></div>
    <div class="stat warn"><div class="n">__STRAYS__</div><div class="l">Strays</div></div>
  </div>

  <div class="toolbar">
    <input id="q" type="search" placeholder="Search projects, links, languages, descriptions…">
    <div class="viewbtns">
      <button id="viewCards" class="viewbtn">Cards</button>
      <button id="viewList" class="viewbtn">List</button>
      <button id="viewTree" class="viewbtn">Explorer</button>
    </div>
    <div class="collapsectl">
      <button id="collapseAll" class="mini">Collapse all</button>
      <button id="expandAll" class="mini">Expand all</button>
    </div>
  </div>
  <div class="toolbar">
    <button id="filtersToggle" class="mini" title="Show or hide category and tag filters">Filters &#9656;</button>
    <button id="addCardBtn" class="mini addbtn" title="Add a new project or reference">+ Add card</button>
    <button id="favToggle" class="mini archtoggle" title="Show only favorite projects">&#9733; Favorites</button>
    <button id="archToggle" class="mini" title="Show or hide archived projects">Show archived</button>
    <select id="sourceMode" class="mini" title="Filter by repo source — Mine = your GitHub, External = clones of others' repos">
      <option value="all">Source: All</option>
      <option value="mine">Source: Mine</option>
      <option value="external">Source: External</option>
    </select>
    <button id="gitFetchAll" class="mini" title="git fetch every repo — refresh ahead/behind (needs the helper: devhub serve)">&#8635; Fetch all</button>
    <button id="gitSyncAll" class="mini" title="git fetch, then fast-forward every clean repo (needs the helper: devhub serve)">Sync all</button>
  </div>
  <div id="filtersBlock" class="filters-block" style="display:none">
    <div class="toolbar">
      <div class="filters" id="filters"></div>
    </div>
    <div class="toolbar tagrow" id="tagrow"></div>
  </div>

  <div id="activeFilter"></div>
  <div id="content"></div>
  <div id="strays"></div>

  <footer>devhub — self-evolving workspace manager · data embedded in this file (works offline) · click any card for detail</footer>
</div>

<div id="modal" class="modal">
  <div class="modal-card">
    <button class="modal-x" aria-label="Close">&times;</button>
    <div id="modal-body"></div>
    <div id="editform-mount"></div>
  </div>
</div>

<script>
let DATA = __DATA__;
let DATA_CONFIG = __CONFIG__;   // settings gear form values (fresh per render)
const THR = DATA.stats.stale_days_threshold;
const content = document.getElementById('content');
const filtersEl = document.getElementById('filters');
const q = document.getElementById('q');
let activeCat = new Set();  // empty Set means "all"
function catSelected(cat){ return activeCat.size===0 || activeCat.has(cat); }
let activeTags = new Set();  // empty Set = no tag filter
let activeDomain = null;
let activeTopic = null;
// Source filter: 'all' (default), 'mine' (only repos owned by github_login),
// 'external' (only repos cloned from someone else). activeOwner is an exact-
// owner pin (e.g. 'vercel') set by clicking an owner pill on a card.
let sourceMode = (function(){ try{ return localStorage.getItem('devhub_source')||'all'; }catch(e){ return 'all'; } })();
let activeOwner = null;
let showArchived = (function(){ try{ return localStorage.getItem('devhub_archived')==='1'; }catch(e){ return false; } })();
let showFavOnly = (function(){ try{ return localStorage.getItem('devhub_favonly')==='1'; }catch(e){ return false; } })();
const activeFilterEl = document.getElementById('activeFilter');
function renderActiveChip(){
  let html = '';
  for(const t of activeTags){
    html += `<span class="afilt">tag: #${esc(t)} <span class="afilt-x" data-clear="tag" data-tag="${esc(t)}" title="clear this tag">✕</span></span>`;
  }
  if(activeDomain) html += `<span class="afilt">domain: ${esc(activeDomain)} <span class="afilt-x" data-clear="domain" title="clear">✕</span></span>`;
  if(activeTopic) html += `<span class="afilt">topic: ⊕ ${esc(activeTopic)} <span class="afilt-x" data-clear="topic" title="clear">✕</span></span>`;
  if(activeOwner) html += `<span class="afilt">owner: ↗ ${esc(activeOwner)} <span class="afilt-x" data-clear="owner" title="clear">✕</span></span>`;
  if(sourceMode!=='all') html += `<span class="afilt">source: ${esc(sourceMode)} <span class="afilt-x" data-clear="source" title="clear">✕</span></span>`;
  if(showFavOnly) html += `<span class="afilt">★ favorites only <span class="afilt-x" data-clear="fav" title="clear">✕</span></span>`;
  activeFilterEl.innerHTML = html;
}
// Persist + sync the toolbar select + restyle. Single helper called from the
// .author-me click handler, the toolbar select's change event, and the active-
// filter chip clear-X — keeps the three places in lock-step.
function setSourceMode(next){
  sourceMode = next;
  try{ localStorage.setItem('devhub_source', sourceMode); }catch(e){}
  const sel = document.getElementById('sourceMode');
  if(sel){ sel.value = sourceMode; sel.classList.toggle('active', sourceMode!=='all'); }
}
activeFilterEl.addEventListener('click', e=>{
  const x = e.target.closest('.afilt-x'); if(!x) return;
  if(x.dataset.clear==='tag'){
    if(x.dataset.tag) activeTags.delete(x.dataset.tag);
    else activeTags.clear();
  }
  if(x.dataset.clear==='domain') activeDomain = null;
  if(x.dataset.clear==='topic') activeTopic = null;
  if(x.dataset.clear==='owner') activeOwner = null;
  if(x.dataset.clear==='source') setSourceMode('all');
  if(x.dataset.clear==='fav') setFavOnly(false);
  renderActiveChip();
  if(typeof buildTagRow==='function') buildTagRow();
  render();
});

let viewMode = (function(){ try{ return localStorage.getItem('devhub_view')||'cards'; }catch(e){ return 'cards'; } })();
let projSort = { key: 'name', dir: 1 };
let refSort  = { key: 'title', dir: 1 };
// ---- Unified UI-state persistence ----------------------------------------
// view/source/archived/collapse/tree/list-prefs persist via their own keys
// above; this blob covers the rest so EVERY setting survives a reload: the
// search text, category + tag filters, domain/topic/owner pins, and the list
// sort. saveUIState() runs at the top of render() so all mutation paths are
// captured automatically; hydrateUIState() restores at boot before first paint.
function saveUIState(){
  try{
    localStorage.setItem('devhub_ui', JSON.stringify({
      q: q.value, cats:[...activeCat], tags:[...activeTags],
      domain: activeDomain, topic: activeTopic, owner: activeOwner,
      projSort, refSort,
    }));
  }catch(e){}
}
function hydrateUIState(){
  let s; try{ s = JSON.parse(localStorage.getItem('devhub_ui')||'null'); }catch(e){ return; }
  if(!s || typeof s!=='object') return;
  // Validate cats/tags against the current snapshot so a stale entry from an
  // older regen can't silently filter everything to empty (cats especially —
  // a non-matching activeCat hides every card with no visible cause).
  const validCats = new Set(Object.keys(DATA.categories));
  const validTags = new Set(Object.keys(allTagCounts()));
  if(typeof s.q==='string') q.value = s.q;
  if(Array.isArray(s.cats)) activeCat = new Set(s.cats.filter(c=>validCats.has(c)));
  if(Array.isArray(s.tags)) activeTags = new Set(s.tags.filter(t=>validTags.has(t)));
  activeDomain = s.domain || null;
  activeTopic  = s.topic  || null;
  activeOwner  = s.owner  || null;
  if(s.projSort && s.projSort.key) projSort = { key:String(s.projSort.key), dir: s.projSort.dir===-1?-1:1 };
  if(s.refSort  && s.refSort.key)  refSort  = { key:String(s.refSort.key),  dir: s.refSort.dir===-1?-1:1 };
}
function setViewMode(m){ viewMode = m; try{ localStorage.setItem('devhub_view', m); }catch(e){} updateViewBtns(); render(); }
function updateViewBtns(){
  document.getElementById('viewCards').classList.toggle('active', viewMode==='cards');
  document.getElementById('viewList' ).classList.toggle('active', viewMode==='list');
  document.getElementById('viewTree' ).classList.toggle('active', viewMode==='tree');
}

const refsByCat = {};
const attachedByProject = {};
const topicsByProject = {};
(DATA.references||[]).forEach(r=>{
  (refsByCat[r.category]=refsByCat[r.category]||[]).push(r);
  if(r.project){
    (attachedByProject[r.project]=attachedByProject[r.project]||[]).push(r);
    if(r.topic){ (topicsByProject[r.project]=topicsByProject[r.project]||new Set()).add(r.topic); }
  }
});

function domainOf(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch(e){ return ''; } }
function loadCollapsed(){ try{ return new Set(JSON.parse(localStorage.getItem('devhub_collapsed')||'[]')); }catch(e){ return new Set(); } }
function saveCollapsed(s){ try{ localStorage.setItem('devhub_collapsed', JSON.stringify([...s])); }catch(e){} }
let collapsedSet = loadCollapsed();
function isCollapsed(c){ return collapsedSet.has(c); }

function esc(s){return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
// Deterministic per-tag color: hash the tag name to a stable hue, emit CSS custom
// properties the .badge.tag / .filt.tag rules read via var() (so hover/active still work).
function tagHue(t){let h=0;t=String(t);for(let i=0;i<t.length;i++){h=(h*31+t.charCodeAt(i))>>>0;}return h%360;}
function tagStyle(t){const h=tagHue(t);return `--tc:hsl(${h},70%,72%);--tbd:hsla(${h},45%,55%,.55);--tbg:hsla(${h},55%,55%,.12)`;}
function repoUrl(remote){
  if(!remote) return '';
  let u = remote.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
  return u.startsWith('http') ? u : '';
}
function healthDot(p){
  if(p.stale_days!=null && p.stale_days>THR) return '<span class="dot r" title="stale"></span>';
  if(p.dirty) return '<span class="dot a" title="uncommitted changes"></span>';
  if(p.ahead) return `<span class="dot a" title="${p.ahead} commit(s) not pushed"></span>`;
  if(p.no_upstream) return '<span class="dot a" title="no upstream — never pushed"></span>';
  return '<span class="dot g" title="healthy"></span>';
}
function deployDot(p){
  if(!p.health) return '';
  if(p.health.ok) return `<span class="dot g" title="deploy up · checked ${esc(p.health.checked||'')}"></span>`;
  return `<span class="dot r" title="deploy down (${esc(String(p.health.status||'no response'))}) · checked ${esc(p.health.checked||'')}"></span>`;
}
function matches(text, term){ return !term || text.toLowerCase().includes(term); }
// Author/owner pill next to the project name. Single source of truth shared
// by card() and projRow() — keeps tooltip text, ARIA attrs, and click hooks in
// lock-step across views. Three states:
//   external + parsed owner   → "↗ owner"  (clickable, pins activeOwner)
//   external + no owner       → "↗ ext"    (badge only, nothing to pin)
//   yours / unknown           → "Me"       (clickable, toggles Source: Mine)
function authorChip(p){
  if(p.mine===false && p.owner){
    const active = (activeOwner===p.owner) ? ' active' : '';
    const pressed = active ? 'true' : 'false';
    return ` <span class="author owner-chip${active}" role="button" tabindex="0" aria-pressed="${pressed}" data-owner="${esc(p.owner)}" title="External — owned by ${esc(p.owner)}. Click to filter to this owner.">↗ ${esc(p.owner)}</span>`;
  }
  if(p.mine===false){
    // External by `mine` but `owner` couldn't be parsed (gist, local remote,
    // or a tooling quirk). Render a neutral badge — no owner to filter on.
    return ` <span class="author" title="External repo — owner not parseable from origin">↗ ext</span>`;
  }
  const pressed = (sourceMode==='mine') ? 'true' : 'false';
  const active  = (sourceMode==='mine') ? ' active' : '';
  return ` <span class="author author-me${active}" role="button" tabindex="0" aria-pressed="${pressed}" title="Yours. Click to filter to your repos.">Me</span>`;
}

function syncLabel(p){
  if(p.detached) return 'detached HEAD';
  if(p.no_upstream) return 'no upstream (never pushed)';
  const bits=[];
  if(p.ahead) bits.push(`⇡${p.ahead} ahead`);
  if(p.behind) bits.push(`⇣${p.behind} behind`);
  return bits.length ? bits.join(' · ') : 'up to date';
}

// Quick actions rendered on cards, list rows and tree rows. The click
// delegation intercepts .qa-btn before the card-detail handler fires.
function qaButtons(p){
  const id = esc(p.category+'::'+p.name);
  return `<span class="qa">`
    +`<button class="qa-btn qa-fav${p.favorite?' on':''}" data-qa="favorite" data-qa-id="${id}" title="${p.favorite?'Remove from favorites':'Add to favorites'}">${p.favorite?'★':'☆'}</button>`
    +`<button class="qa-btn qa-pin${p.pinned?' on':''}" data-qa="pin" data-qa-id="${id}" title="${p.pinned?'Unpin':'Pin to top of category'}">📌</button>`
    +`<button class="qa-btn qa-arch${p.archived?' on':''}" data-qa="archive" data-qa-id="${id}" title="${p.archived?'Unarchive':'Archive'}">📦</button>`
    +`</span>`;
}

function card(p){
  const badges = [];
  if(p.deployed){
    const dom = domainOf(p.deployed);
    badges.push(`<a class="badge dom dom-link" href="${esc(p.deployed)}" target="_blank" rel="noopener" title="Open ${esc(p.deployed)}">${deployDot(p)}${esc(dom)} ↗</a>`);
  }
  if(p.deploy_method) badges.push(`<span class="badge method">${esc(p.deploy_method)}</span>`);
  if(p.language && p.language!=='—') badges.push(`<span class="badge lang">${esc(p.language)}</span>`);
  if(p.git) badges.push(`<span class="badge">${esc(p.branch||'git')}</span>`);
  if(p.dirty) badges.push(`<span class="badge dirty">uncommitted</span>`);
  if(p.ahead) badges.push(`<span class="badge ahead" title="${p.ahead} commit(s) not pushed">⇡${p.ahead}</span>`);
  if(p.behind) badges.push(`<span class="badge behind" title="${p.behind} commit(s) behind remote">⇣${p.behind}</span>`);
  if(p.no_upstream) badges.push(`<span class="badge noup" title="branch has no upstream — never pushed">no upstream</span>`);
  if(p.stash_count) badges.push(`<span class="badge stash" title="${p.stash_count} stash entry(ies)">⚑${p.stash_count}</span>`);
  if(p.stale_days!=null && p.stale_days>THR) badges.push(`<span class="badge stale">stale ${p.stale_days}d</span>`);
  if(!p.has_readme) badges.push(`<span class="badge noreadme">no readme</span>`);
  if(p.subprojects && p.subprojects.length) badges.push(`<span class="badge subn">⊞ ${p.subprojects.length} sub</span>`);
  const linkCount = (attachedByProject[p.name]||[]).length;
  if(linkCount) badges.push(`<span class="badge linkn">🔗 ${linkCount}</span>`);
  (p.tags||[]).forEach(t=>badges.push(`<span class="badge tag tag-chip" data-tag="${esc(t)}" style="${tagStyle(t)}">#${esc(t)}</span>`));
  if((p.related||[]).length) badges.push(relChipsHTML(p));
  const cls = 'card clickable' + (p.archived ? ' archived' : '') + (p.pinned ? ' pinned' : '');
  return `<div class="${cls}" data-id="${esc(p.category+'::'+p.name)}" role="button" tabindex="0" title="Click for details">
    <div class="top"><div class="name">${healthDot(p)}<span class="nametext" style="color:hsl(${tagHue(p.name)},65%,72%)">${esc(p.name)}</span>${authorChip(p)}</div>${qaButtons(p)}</div>
    <div class="desc">${linkify(p.description||'')}</div>
    ${p.note?`<div class="note">${linkify(p.note)}</div>`:''}
    <div class="badges">${badges.join('')}</div>
    <div class="meta"><span>${esc(p.path)}</span><span>${esc(p.last_activity||'—')}</span></div>
  </div>`;
}

function relChipsHTML(item){
  return (item.related||[]).map(r=>{
    if(r.type==='project') return `<span class="badge rel rel-chip" data-rel-id="${esc(r.category+'::'+r.name)}" title="Related project">↔ ${esc(r.name)}</span>`;
    if(r.type==='ref')     return `<span class="badge rel rel-chip" data-rel-url="${esc(r.url)}" title="${esc(r.title||'')}">↔ ${esc((r.title||r.url||'').slice(0,32))}</span>`;
    return '';
  }).join('');
}
function refIcon(type){ return type==='youtube'?'▶':(type==='repo'?'⎇':'🔗'); }
function refRow(r){
  const icon = refIcon(r.type);
  const tagSpans = (r.tags||[]).map(t=>`<span class="badge tag tag-chip" data-tag="${esc(t)}" style="${tagStyle(t)}">#${esc(t)}</span>`).join('');
  const noteFlag = r.note_md ? `<span class="ref-noteic" title="Has a notes digest — expand below">📄</span>` : '';
  const row = `<a class="ref" href="${esc(safeHref(r.url))}" target="_blank" rel="noopener">
    <span class="ref-ic ${esc(r.type)}">${icon}</span>
    <span class="ref-t">${esc(r.title||r.url)}</span>
    ${tagSpans}${relChipsHTML(r)}${noteFlag}
    <span class="ref-dom dom-chip" data-domain="${esc(domainOf(r.url))}" title="Filter by domain">${esc(domainOf(r.url))}</span>
    <span class="ref-ty">${esc(r.type)}</span></a>`;
  if(!r.note_md) return row;
  // Wrap link + a <details> sidecar so the whole digest reads inline without
  // navigating away. linkify() escapes before linkifying, so note_md is XSS-safe.
  return `<div class="ref-wrap">${row}<details class="ref-notes"><summary>📄 notes</summary><div class="ref-notes-body">${linkify(r.note_md)}</div></details></div>`;
}

function renderRefsBlock(refs){
  const groups = {};
  const ungrouped = [];
  refs.forEach(r=>{ if(r.topic){ (groups[r.topic]=groups[r.topic]||[]).push(r); } else ungrouped.push(r); });
  let html = `<div class="refs"><div class="refs-h">Links & references</div>`;
  for(const tk of Object.keys(groups)){
    const list = groups[tk];
    html += `<div class="topic"><div class="topic-h" data-topic="${esc(tk)}" title="Filter by topic">⊕ ${esc(tk)} <span style="opacity:.6">${list.length}</span></div>${list.map(refRow).join('')}</div>`;
  }
  html += ungrouped.map(refRow).join('');
  html += `</div>`;
  return html;
}

const projById = {};
for(const [cat, blk] of Object.entries(DATA.categories)){
  blk.projects.forEach(p=>{ projById[cat+'::'+p.name] = p; });
}
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
function drow(k,v){ return v ? `<div class="drow"><span class="dk">${esc(k)}</span><span class="dv">${v}</span></div>` : ''; }
// Only allow safe schemes in generated hrefs (blocks javascript:/data: etc.).
function safeHref(href){ return /^(https?:|mailto:|vscode:)/i.test(href||'') ? href : '#'; }
function abtn(href,label){ return `<a class="btn" href="${esc(safeHref(href))}" target="_blank" rel="noopener">${esc(label)}</a>`; }
function flash(b,msg){ const o=b.dataset.label||b.textContent; b.dataset.label=o; b.textContent=msg; setTimeout(()=>{b.textContent=b.dataset.label;},1200); }
__DASHBOARD_DEV_JS__
// Dashboard-specific renderer for the Running panel. The shared poll loop
// above calls `window.onDevState` after each /api/dev/state fetch — we wire
// it up below so this is the function that runs.
function renderRunning(){
  const names = Object.keys(DEV_STATE);
  const panel = document.getElementById('running-panel');
  if(!panel) return;
  if(!names.length){ panel.style.display='none'; panel.innerHTML=''; return; }
  const items = names.sort().map(n=>{
    const s = DEV_STATE[n];
    return `<span class="run-item"><span class="dot-live">●</span> ${esc(n)} :${esc(String(s.port))} `
      + `<button class="btn devopen" data-name="${esc(n)}" data-url="${esc(s.url||('http://localhost:'+s.port))}">Open ↗</button>`
      + `<button class="btn devstop" data-name="${esc(n)}">Stop ■</button></span>`;
  }).join('');
  panel.innerHTML = `<h3>Running (${names.length}) `
    + `<button class="btn devstopall">Stop all</button>`
    + ` · <a href="http://127.0.0.1:${DATA.helper_port}/ports" target="_blank" class="manage-ports">Manage all ports →</a>`
    + `</h3>${items}`;
  panel.style.display='block';
}
(function(){ const rp=document.getElementById('running-panel'); if(rp) rp.addEventListener('click', handleDevClick); })();
window.onDevState = renderRunning;
setInterval(pollDevState, 3000);
pollDevState();
function openDetail(p){
  const abs = DATA.dev_root + '/' + p.path;
  const repo = repoUrl(p.remote);
  const open = [];
  if(p.deployed) open.push(abtn(p.deployed,'Deployed ↗'));
  const run = DEV_STATE[p.name];  // snapshot at open; the Running panel updates live, the modal refreshes on reopen
  if(run){
    open.push(`<button class="btn devopen" data-name="${esc(p.name)}" data-url="${esc(run.url||p.dev||('http://localhost:'+run.port))}">Open ↗</button>`);
    open.push(`<button class="btn devstop" data-name="${esc(p.name)}">Stop ■</button>`);
    open.push(`<button class="btn devrestart" data-name="${esc(p.name)}">Restart ↻</button>`);
  } else if(p.dev){
    open.push(`<button class="btn devbtn" data-path="${esc(abs)}" data-url="${esc(p.dev)}">Local dev ↗</button>`);
  }
  open.push(`<a class="btn" href="vscode://file${esc(abs)}">VS Code</a>`);
  open.push(`<button class="btn actbtn" data-action="finder" data-path="${esc(abs)}">Files</button>`);
  open.push(`<button class="btn actbtn" data-action="terminal" data-path="${esc(abs)}">${esc((DATA_CONFIG&&DATA_CONFIG.terminal_app)||'Terminal')} ▸</button>`);
  open.push(`<button class="btn copybtn" data-copy="${esc(abs)}">Copy path</button>`);
  open.push(`<button class="btn editbtn" data-edit-id="${esc(p.category+'::'+p.name)}">Edit ✎</button>`);
  if(repo) open.push(abtn(repo,'Repository ↗'));
  const badges = [];
  if(p.dirty) badges.push('<span class="badge dirty">uncommitted changes</span>');
  if(p.ahead) badges.push(`<span class="badge ahead" title="not pushed">⇡${p.ahead} unpushed</span>`);
  if(p.behind) badges.push(`<span class="badge behind" title="behind remote">⇣${p.behind} behind</span>`);
  if(p.no_upstream) badges.push('<span class="badge noup">no upstream</span>');
  if(p.stash_count) badges.push(`<span class="badge stash">⚑${p.stash_count} stashed</span>`);
  if(p.stale_days!=null && p.stale_days>THR) badges.push(`<span class="badge stale">stale ${p.stale_days}d</span>`);
  if(!p.has_readme) badges.push('<span class="badge noreadme">no readme</span>');
  if(p.deploy_method) badges.push(`<span class="badge method">${esc(p.deploy_method)}</span>`);
  if(p.health) badges.push(p.health.ok
    ? `<span class="badge method">deploy up${p.health.status?` ${esc(String(p.health.status))}`:''}</span>`
    : `<span class="badge dirty">deploy down${p.health.status?` ${esc(String(p.health.status))}`:''}</span>`);
  let commits='';
  if(p.recent_commits && p.recent_commits.length){
    commits = `<div class="dsec">Recent commits</div>` +
      p.recent_commits.map(c=>`<div class="commit"><span class="cdate">${esc(c.date)}</span>${esc(c.subject)}</div>`).join('');
  }
  let subs='';
  if(p.subprojects && p.subprojects.length){
    subs = `<div class="dsec">Subprojects (${p.subprojects.length})</div>` +
      p.subprojects.map(s=>`<div class="commit"><span class="cdate">${esc(s.language||'—')}</span>${esc(s.path)}${s.deployed?` · <a href="${esc(safeHref(s.deployed))}" target="_blank" rel="noopener">${esc(domainOf(s.deployed))} ↗</a>`:''}${s.has_readme?'':' <span class="badge noreadme">no readme</span>'}</div>`).join('');
  }
  const catLabel = DATA.categories[p.category] ? DATA.categories[p.category].label : p.category;
  const statusLine = run
    ? `<div class="dev-status">● running · :${esc(String(run.port))}</div>` : '';
  modalBody.innerHTML = `
    <div class="dhead"><div class="dtitle">${healthDot(p)}${esc(p.name)}${p.favorite?' <span class="dcat" title="Favorite">★</span>':''}${p.pinned?' <span class="dcat" title="Pinned to top of category">📌</span>':''}${p.archived?' <span class="dcat">archived</span>':''}</div><div class="dcat">${esc(catLabel)}</div></div>
    ${statusLine}
    ${p.description?`<p class="ddesc">${linkify(p.description)}</p>`:''}
    ${p.note?`<div class="note" style="margin-bottom:10px">${linkify(p.note)}</div>`:''}
    ${badges.length?`<div class="dbadges">${badges.join('')}</div>`:''}
    <div class="dgrid">
      ${drow('Path', esc(p.path))}
      ${drow('Language', esc(p.language||'—'))}
      ${drow('Branch', p.git?esc(p.branch||'—'):'—')}
      ${drow('Last activity', esc(p.last_commit_date||p.last_activity||'—'))}
      ${drow('Imported', esc(p.created||''))}
      ${drow('Modified', esc(p.modified||''))}
      ${drow('Commits', p.commit_count?esc(p.commit_count):(p.git?'—':'not a git repo'))}
      ${drow('Working tree', p.git?(p.dirty?`uncommitted changes${p.dirty_count?` (${p.dirty_count})`:''}`:'clean'):'not a git repo')}
      ${drow('Sync', p.git?syncLabel(p):'not a git repo')}
      ${drow('Deploy', p.deploy_method?esc(p.deploy_method):'')}
    </div>
    ${(p.git && p.remote)?`<div class="dsec">Git actions</div>
    <div class="dactions gitactions">
      <button class="btn gitbtn" data-git="fetch" data-name="${esc(p.name)}" title="Refresh ahead/behind from the remote">Fetch &#8595;</button>
      <button class="btn gitbtn" data-git="pull" data-name="${esc(p.name)}" title="Fast-forward-only pull (skipped if the working tree is dirty)">Pull &#8623;</button>
      <button class="btn gitbtn" data-git="push" data-name="${esc(p.name)}" title="Push unpushed commits (needs an upstream)">Push &#8607;</button>
      <button class="btn gitbtn" data-git="sync" data-name="${esc(p.name)}" title="Fetch, then fast-forward if clean">Sync &#8635;</button>
    </div>`:''}
    ${repo?`<div class="dsec">Remote</div><div class="commit"><a href="${esc(repo)}" target="_blank" rel="noopener">${esc(repo)}</a></div>`:''}
    ${p.last_commit_subject?`<div class="dsec">Latest commit</div><div class="commit">${esc(p.last_commit_subject)}</div>`:''}
    ${commits}
    ${subs}
    ${(attachedByProject[p.name]||[]).length ? `<div class="dsec">Related links (${(attachedByProject[p.name]||[]).length})</div>${(attachedByProject[p.name]||[]).map(refRow).join('')}` : ''}
    <div class="dsec">Open</div>
    <div class="dactions">${open.join('')}</div>`;
  modal.classList.add('open');
}
function closeModal(){
  modal.classList.remove('open');
  const ef = document.getElementById('editform-mount');
  if(ef) ef.innerHTML = '';
}
function copyText(t){ return (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(t) : Promise.reject(); }
modalBody.addEventListener('click', e=>{
  const cb = e.target.closest('.copybtn');
  if(cb){
    copyText(cb.getAttribute('data-copy')).then(()=>flash(cb,'Copied!'), ()=>flash(cb,'Copy failed'));
    return;
  }
  const eb = e.target.closest('.editbtn');
  if(eb){
    const id = eb.getAttribute('data-edit-id');
    const proj = projById[id];
    if(proj) openEditForm(proj);
    return;
  }
  if(handleDevClick(e)) return;
  const gbtn = e.target.closest('.gitbtn');
  if(gbtn){ gitAction(gbtn.dataset.git, gbtn.dataset.name, gbtn); return; }
  const db = e.target.closest('.devbtn');
  if(db){
    const path = db.dataset.path, durl = db.dataset.url;
    // Open the tab now (in the click gesture -> never popup-blocked) and show a
    // spinner; navigate to the dev URL only once the server is actually
    // listening, so a cold start doesn't land on "this site can't be reached".
    const w = window.open('about:blank','_blank');
    if(w){ w.document.write(devLoadingDoc(durl)); w.document.close(); }
    flash(db,'Starting…');
    const go = (u)=>{ if(w) w.location.href = u || durl; };
    const helper = `http://127.0.0.1:${DATA.helper_port}/open`;
    fetch(`${helper}?action=dev&path=${encodeURIComponent(path)}`).then(r=>r.json()).then(j=>{
      if(!j.ok){
        go(durl);   // best effort: server may already be up
        flash(db, j.error==='no dev script found' ? 'No dev script — opened URL' : ('Error: '+(j.error||'')));
        return;
      }
      const target = j.url || durl;
      if(j.scripted===false && j.cmd){ copyText(j.cmd); flash(db,'Terminal opened — cmd copied'); }
      if(j.already_running){ go(target); flash(db,'Running ✓'); return; }
      // Cold start: poll the helper until the dev port answers, then navigate.
      flash(db,'Server starting…');
      const statusUrl = `${helper}?action=devstatus&path=${encodeURIComponent(path)}`;
      const deadline = Date.now() + 45000;
      (function poll(){
        fetch(statusUrl).then(r=>r.json()).then(s=>{
          if(s.listening){ go(target); flash(db,'Running ✓'); }
          else if(Date.now()<deadline){ setTimeout(poll, 600); }
          else { go(target); flash(db,'Opened — may still be starting'); }
        }).catch(()=>{ if(Date.now()<deadline){ setTimeout(poll, 700); } else { go(target); } });
      })();
    }).catch(()=>{
      go(durl);      // helper not running
      flash(db,'Run: devhub serve to auto-start');
    });
    return;
  }
  const ab = e.target.closest('.actbtn');
  if(!ab) return;
  const action = ab.dataset.action, path = ab.dataset.path;
  flash(ab,'Opening…');
  const url = `http://127.0.0.1:${DATA.helper_port}/open?action=${encodeURIComponent(action)}&path=${encodeURIComponent(path)}`;
  fetch(url).then(r=>r.json()).then(j=>{
    flash(ab, j.ok ? (j.launched ? 'Opened ✓' : 'OK ✓') : ('Error: '+(j.error||'')));
  }).catch(()=>{
    // helper not running -> graceful fallback
    if(action==='finder'){
      window.open(encodeURI('file://'+path),'_blank');
      flash(ab,'Opened in browser');
    } else {
      // POSIX-safe single-quoting so paths containing ' don't break the cd
      const shq = "cd '" + path.replace(/'/g, "'\\''") + "'";
      copyText(shq).then(()=>flash(ab,"Copied cd — run: devhub serve"),
                         ()=>flash(ab,"Run: devhub serve"));
    }
  });
});

// --- git management (dashboard → helper /api/git) -----------------------
function projByName(name){
  for(const blk of Object.values(DATA.categories)){
    const p = blk.projects.find(x=>x.name===name);
    if(p) return p;
  }
  return null;
}
// Patch a project's in-memory git fields from a helper response so cards/badges
// reflect the new state without a full page reload.
function patchProjectGit(name, git){
  const p = projByName(name);
  if(!p || !git) return;
  ['branch','detached','dirty','dirty_count','ahead','behind','no_upstream','stash_count']
    .forEach(k=>{ if(k in git) p[k] = git[k]; });
}
function gitToast(msg, ok){
  let t = document.getElementById('gittoast');
  if(!t){ t = document.createElement('div'); t.id = 'gittoast'; t.className = 'gittoast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle('err', ok===false);
  t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2800);
}
const gitEndpoint = ()=>`http://127.0.0.1:${DATA.helper_port}/api/git`;
function gitAction(action, name, btn){
  if(btn){ flash(btn, '…'); btn.disabled = true; }
  fetch(gitEndpoint(), {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({action, project:name})})
    .then(r=>r.json()).then(j=>{
      if(j && j.git) patchProjectGit(name, j.git);
      const ok = !!(j && j.ok && j.status!=='failed' && j.status!=='error');
      gitToast(name+': '+(ok ? (j.message||j.status||'done')
                             : ((j&&(j.error||j.message))||'failed')), ok);
      render();
      const pr = projByName(name);
      if(pr && modal.classList.contains('open')) openDetail(pr);  // re-render modal w/ fresh state
    }).catch(()=>{ if(btn) btn.disabled=false; gitToast('helper offline — run: devhub serve', false); });
}
function gitActionAll(action, btn){
  if(btn){ flash(btn, action==='fetch'?'Fetching…':'Syncing…'); btn.disabled = true; }
  fetch(gitEndpoint(), {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({action, all:true})})
    .then(r=>r.json()).then(j=>{
      if(btn) btn.disabled = false;
      const res = (j && j.results) || [];
      res.forEach(r=>{ if(r.git) patchProjectGit(r.project, r.git); });
      const bad = res.filter(r=>!r.ok).length;
      gitToast((action==='fetch'?'Fetched ':'Synced ')+(res.length-bad)+' repo(s)'+(bad?', '+bad+' failed':''), !!(j&&j.ok) && !bad);
      render();
    }).catch(()=>{ if(btn) btn.disabled=false; gitToast('helper offline — run: devhub serve', false); });
}
(function(){
  const f = document.getElementById('gitFetchAll'), s = document.getElementById('gitSyncAll');
  if(f) f.addEventListener('click', ()=>gitActionAll('fetch', f));
  if(s) s.addEventListener('click', ()=>gitActionAll('sync', s));
})();

function render(){
  saveUIState();   // capture search/filters/sort on every render path
  if(viewMode==='list') renderList();
  else if(viewMode==='tree') renderTree();
  else renderCards();
}

function renderCards(){
  const term = q.value.trim().toLowerCase();
  let html='';
  for(const [cat, blk] of Object.entries(DATA.categories)){
    if(!catSelected(cat)) continue;
    const visible = blk.projects.filter(p=>passesProject(p, term));
    visible.sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));   // pinned first (stable: keeps name order)
    const refs    = (refsByCat[cat]||[]).filter(r=>passesRef(r, term));
    if(!visible.length && !refs.length) continue;
    const coll = !term && activeTags.size===0 && !activeDomain && !activeTopic && activeCat.size===0 && !activeOwner && sourceMode==='all' && !showFavOnly && isCollapsed(cat);
    html += `<div class="cat${coll?' collapsed':''}" data-cat="${esc(cat)}">
      <h2 class="cat-h"><span class="chev">▾</span>${esc(blk.label)} <span class="count">${visible.length}${refs.length?(' · '+refs.length+' link'+(refs.length>1?'s':'')):''}</span></h2>
      <div class="cat-body">
        <div class="blurb">${esc(blk.blurb||'')}</div>`;
    if(visible.length) html += `<div class="grid">${visible.map(card).join('')}</div>`;
    if(refs.length) html += renderRefsBlock(refs);
    html += `</div></div>`;
  }
  content.innerHTML = html || `<p style="color:var(--muted)">No matches.</p>`;

  const sb = document.getElementById('strays');
  if(DATA.strays && DATA.strays.length && activeCat.size===0 && !term){
    sb.innerHTML = `<div class="strays"><h2>⚠ Strays / uncategorized (${DATA.strays.length})</h2>` +
      DATA.strays.map(st=>`<div class="stray-row"><span>${esc(st.name)}</span>
        <span style="color:var(--muted)">suggested: ${esc(st.suggested_category||'??? no match')}</span></div>`).join('') +
      `<div style="color:var(--muted);font-size:12px;margin-top:10px">Run <code>python3 _devhub/devhub.py import &lt;name&gt;</code> to file one automatically.</div></div>`;
  } else { sb.innerHTML=''; }
}

function passesProject(p, term){
  if(p.archived && !showArchived) return false;
  if(showFavOnly && !p.favorite) return false;
  if(activeTags.size > 0 && !(p.tags||[]).some(t => activeTags.has(t))) return false;
  if(activeDomain && domainOf(p.deployed||'') !== activeDomain) return false;
  if(activeTopic && !((topicsByProject[p.name]||new Set()).has(activeTopic))) return false;
  // Source filter: 'mine' hides external repos, 'external' hides owned repos.
  // p.mine defaults to true on the data side, so unconfigured logins still show.
  if(sourceMode==='mine' && p.mine===false) return false;
  if(sourceMode==='external' && p.mine!==false) return false;
  if(activeOwner && (p.owner||'') !== activeOwner) return false;
  const linkTitles = (attachedByProject[p.name]||[]).map(r=>r.title||'').join(' ');
  return matches(p.name+' '+(p.description||'')+' '+(p.language||'')+' '+(p.remote||'')+' '+(p.deployed||'')+' '+(p.note||'')+' '+(p.tags||[]).join(' ')+' '+linkTitles, term);
}
function passesRef(r, term){
  if(activeTags.size > 0 && !(r.tags||[]).some(t => activeTags.has(t))) return false;
  if(activeDomain && domainOf(r.url) !== activeDomain) return false;
  if(activeTopic && r.topic !== activeTopic) return false;
  return matches((r.title||'')+' '+r.url+' '+(r.tags||[]).join(' '), term);
}
function projSortVal(p, key){
  switch(key){
    case 'name': return (p.name||'').toLowerCase();
    case 'category': return p.category||'';
    case 'language': return (p.language||'').toLowerCase();
    case 'branch': return (p.branch||'').toLowerCase();
    case 'domain': return domainOf(p.deployed||'')||'~~~';
    case 'last_activity': return p.last_activity||'';
    case 'created': return p.created||'';
    case 'modified': return p.modified||'';
    case 'tags': return ((p.tags||[])[0]||'~~~').toLowerCase();
    case 'status': return p.dirty ? 1 : (p.stale_days!=null && p.stale_days>THR ? 2 : 0);
  }
  return '';
}
function refSortVal(r, key){
  switch(key){
    case 'title': return (r.title||r.url||'').toLowerCase();
    case 'type': return r.type||'';
    case 'domain': return domainOf(r.url||'');
    case 'category': return r.category||'';
    case 'topic': return (r.topic||'~~~').toLowerCase();
    case 'tags': return ((r.tags||[])[0]||'~~~').toLowerCase();
    case 'added': return r.added||'';
  }
  return '';
}
function sortFn(s, valFn){
  return (a,b)=>{ const av=valFn(a,s.key), bv=valFn(b,s.key);
    if(av<bv) return -1*s.dir; if(av>bv) return 1*s.dir; return 0; };
}
function th(label, key, sortObj){
  const sorted = sortObj.key===key;
  const arrow = sorted ? (sortObj.dir===1?' ▲':' ▼') : '';
  return `<th data-sort="${key}" data-col="${esc(key)}" class="${sorted?'sorted':''}">${esc(label)}<span class="arrow">${arrow}</span></th>`;
}
function projRow(p){
  const dom = domainOf(p.deployed||'');
  const tags = (p.tags||[]).map(t=>`<span class="badge tag tag-chip" data-tag="${esc(t)}" style="${tagStyle(t)}">#${esc(t)}</span>`).join('');
  const cls = 'card clickable' + (p.archived?' archived':'') + (p.pinned?' pinned':'');
  return `<tr class="${cls}" data-id="${esc(p.category+'::'+p.name)}">
    <td data-col="health">${healthDot(p)}</td>
    <td class="name-cell" data-col="name"><span class="nametext" style="color:hsl(${tagHue(p.name)},65%,72%)">${esc(p.name)}</span>${authorChip(p)}${qaButtons(p)}</td>
    <td class="meta-cell" data-col="category">${esc(p.category)}</td>
    <td class="meta-cell" data-col="language">${esc(p.language||'—')}</td>
    <td class="meta-cell" data-col="branch">${p.git?esc(p.branch||''):'—'}</td>
    <td data-col="domain">${dom?`<a class="badge dom dom-link" href="${esc(p.deployed)}" target="_blank" rel="noopener" title="Open ${esc(p.deployed)}">${esc(dom)} ↗</a>`:'<span class="meta-cell">—</span>'}</td>
    <td class="meta-cell" data-col="last_activity">${esc(p.last_activity||'—')}</td>
    <td class="meta-cell" data-col="created">${esc(p.created||'—')}</td>
    <td class="meta-cell" data-col="modified">${esc(p.modified||'—')}</td>
    <td class="tags-cell" data-col="tags">${tags}${relChipsHTML(p)}</td>
  </tr>`;
}
function refRowList(r){
  const icon = refIcon(r.type);
  const dom = domainOf(r.url||'');
  const tags = (r.tags||[]).map(t=>`<span class="badge tag tag-chip" data-tag="${esc(t)}" style="${tagStyle(t)}">#${esc(t)}</span>`).join('');
  return `<tr>
    <td class="meta-cell" data-col="type">${icon}</td>
    <td class="title-cell" data-col="title"><a href="${esc(safeHref(r.url))}" target="_blank" rel="noopener">${esc(r.title||r.url)}</a></td>
    <td class="meta-cell" data-col="category">${esc(r.category||'')}</td>
    <td class="meta-cell" data-col="topic">${esc(r.topic||'')}</td>
    <td data-col="domain">${dom?`<span class="badge dom dom-chip" data-domain="${esc(dom)}">${esc(dom)}</span>`:'—'}</td>
    <td class="tags-cell" data-col="tags">${tags}${relChipsHTML(r)}</td>
  </tr>`;
}
// ---- List view: per-list column / density customization (gear in .lhead) ---
// Pure client-side view prefs (no server, no config write) — persisted in
// localStorage and applied as CSS classes on the .ltable elements so toggling
// a column never triggers a full re-render (the open menu stays open).
const LIST_COLS = [
  {key:'category',      label:'Category'},
  {key:'language',      label:'Language'},
  {key:'branch',        label:'Branch'},
  {key:'domain',        label:'Domain'},
  {key:'last_activity', label:'Last activity'},
  {key:'created',       label:'Imported'},
  {key:'modified',      label:'Modified'},
  {key:'tags',          label:'Tags'},
];
let listPrefs = (function(){
  const cols = {}; LIST_COLS.forEach(c=>cols[c.key]=true);
  const def = {cols, density:'comfortable', zebra:false};
  try{
    const s = JSON.parse(localStorage.getItem('devhub_list_prefs')||'null');
    if(s && typeof s==='object'){
      return {cols:Object.assign(cols, s.cols||{}), density:s.density==='compact'?'compact':'comfortable', zebra:!!s.zebra};
    }
  }catch(e){}
  return def;
})();
function saveListPrefs(){ try{ localStorage.setItem('devhub_list_prefs', JSON.stringify(listPrefs)); }catch(e){} }
function listModClasses(){
  const c = LIST_COLS.filter(x=>!listPrefs.cols[x.key]).map(x=>'hc-'+x.key);
  if(listPrefs.density==='compact') c.push('dense');
  if(listPrefs.zebra) c.push('zebra');
  return c.join(' ');
}
function listGearHtml(){
  const cols = LIST_COLS.map(c=>
    `<label class="lcol-row"><input type="checkbox" class="lcol-cb" data-col="${c.key}" ${listPrefs.cols[c.key]?'checked':''}><span>${c.label}</span></label>`
  ).join('');
  return `<span class="lwrap">`
    + `<button class="lgear" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Customize list" title="Customize list">&#9881;</button>`
    + `<div class="lmenu" role="menu">`
    +   `<div class="lmenu-h">Columns</div>${cols}`
    +   `<div class="lmenu-sep"></div><div class="lmenu-h">Density</div>`
    +   `<label class="lcol-row"><input type="radio" name="ldensity" class="ldense-cb" value="comfortable" ${listPrefs.density!=='compact'?'checked':''}><span>Comfortable</span></label>`
    +   `<label class="lcol-row"><input type="radio" name="ldensity" class="ldense-cb" value="compact" ${listPrefs.density==='compact'?'checked':''}><span>Compact</span></label>`
    +   `<div class="lmenu-sep"></div>`
    +   `<label class="lcol-row"><input type="checkbox" class="lzebra-cb" ${listPrefs.zebra?'checked':''}><span>Zebra striping</span></label>`
    +   `<div class="lmenu-sep"></div>`
    +   `<button type="button" class="lreset" data-reset="cols">Reset columns</button>`
    +   `<button type="button" class="lreset" data-reset="layout">Reset width &amp; order</button>`
    +   `<div class="lhint">Drag a header to reorder · drag its right edge to resize.</div>`
    + `</div></span>`;
}
function listTables(){ return content.querySelectorAll('.ltable'); }
function applyColClass(key, show){ listTables().forEach(t=>t.classList.toggle('hc-'+key, !show)); }
function applyDensity(){ const d=listPrefs.density==='compact'; listTables().forEach(t=>t.classList.toggle('dense', d)); }
function applyZebra(){ listTables().forEach(t=>t.classList.toggle('zebra', listPrefs.zebra)); }
function applyAllListPrefs(){ LIST_COLS.forEach(c=>applyColClass(c.key, listPrefs.cols[c.key])); applyDensity(); applyZebra(); }
// Toggle the list-customize menu (own listener; the main content handler below
// ignores gear/menu clicks since they are neither th[data-key] nor tr.card).
content.addEventListener('click', e=>{
  const g = e.target.closest('.lgear');
  if(g){ const m=g.parentElement.querySelector('.lmenu'); const o=m.classList.toggle('open'); g.setAttribute('aria-expanded', o?'true':'false'); return; }
  const rst = e.target.closest('.lreset');
  if(rst){
    if(rst.dataset.reset==='layout'){
      // Clear stored width + order for both list tables and rebuild from scratch
      // (a clean innerHTML drops inline widths / table-layout:fixed).
      saveListLayout({}); render();
    } else {
      LIST_COLS.forEach(c=>listPrefs.cols[c.key]=true); saveListPrefs(); applyAllListPrefs();
      const mm=rst.closest('.lmenu'); if(mm) mm.querySelectorAll('.lcol-cb').forEach(cb=>cb.checked=true);
    }
  }
});
content.addEventListener('change', e=>{
  const cb=e.target.closest('.lcol-cb'); if(cb){ listPrefs.cols[cb.dataset.col]=cb.checked; saveListPrefs(); applyColClass(cb.dataset.col, cb.checked); return; }
  const dz=e.target.closest('.ldense-cb'); if(dz){ listPrefs.density=dz.value==='compact'?'compact':'comfortable'; saveListPrefs(); applyDensity(); return; }
  const zb=e.target.closest('.lzebra-cb'); if(zb){ listPrefs.zebra=zb.checked; saveListPrefs(); applyZebra(); return; }
});
document.addEventListener('click', e=>{
  if(e.target.closest('.lwrap')) return;
  content.querySelectorAll('.lmenu.open').forEach(m=>{ m.classList.remove('open'); const g=m.parentElement.querySelector('.lgear'); if(g) g.setAttribute('aria-expanded','false'); });
});

// ---- List view: resizable + draggable (reorderable) columns ---------------
// Per-table-type layout (column order + pixel widths) persisted in localStorage,
// keyed 'proj' / 'refs'. Reorder = drag a header; resize = drag its right edge.
// The leading status/icon column ('health') is excluded from both. Layout is
// re-applied after every renderList() (sort re-renders the table from scratch).
const LAYOUT_SKIP = new Set(['health']);    // columns that don't reorder/resize
let _suppressSort = false;                  // true during/just-after a drag or resize
function tableType(t){ return t.classList.contains('refs-table') ? 'refs' : 'proj'; }
function listLayout(){ try{ return JSON.parse(localStorage.getItem('devhub_list_layout')||'{}')||{}; }catch(e){ return {}; } }
function saveListLayout(o){ try{ localStorage.setItem('devhub_list_layout', JSON.stringify(o)); }catch(e){} }
function getOrder(type){ const l=listLayout(); return (l[type]&&l[type].order)?l[type].order.slice():null; }
function setOrder(type,order){ const l=listLayout(); l[type]=l[type]||{}; l[type].order=order; saveListLayout(l); }
function getWidths(type){ const l=listLayout(); return (l[type]&&l[type].widths)?Object.assign({},l[type].widths):null; }
function setWidths(type,w){ const l=listLayout(); l[type]=l[type]||{}; l[type].widths=w; saveListLayout(l); }
function currentOrder(table){ return Array.from(table.tHead.rows[0].cells).map(th=>th.getAttribute('data-col')).filter(Boolean); }
// Physically reorder <th> + every row's <td> into `order` (keyed by data-col).
// Unknown / missing keys keep their current relative position at the end.
function reorderColumns(table, order){
  const cur = currentOrder(table);
  const desired = order.filter(k=>cur.includes(k));
  cur.forEach(k=>{ if(!desired.includes(k)) desired.push(k); });
  const apply = row=>{
    const byKey = {};
    Array.from(row.cells).forEach(c=>{ byKey[c.getAttribute('data-col')] = c; });
    desired.forEach(k=>{ if(byKey[k]) row.appendChild(byKey[k]); });
  };
  apply(table.tHead.rows[0]);
  Array.from(table.tBodies[0].rows).forEach(apply);
}
function captureWidths(table){
  const w={};
  Array.from(table.tHead.rows[0].cells).forEach(th=>{
    const k=th.getAttribute('data-col'); if(!k) return;
    w[k]=Math.round(th.getBoundingClientRect().width);
  });
  return w;
}
// Lock the table to fixed layout and apply stored widths. Hidden columns
// (display:none via the column-hide feature) are skipped so they don't pad the
// scroll width; their stored width is preserved for when they're shown again.
function applyWidths(table, widths){
  table.style.tableLayout='fixed';
  let total=0;
  Array.from(table.tHead.rows[0].cells).forEach(th=>{
    const k=th.getAttribute('data-col'); if(!k) return;
    if(getComputedStyle(th).display==='none') return;
    const w=widths[k]; if(!w) return;
    th.style.width=w+'px'; total+=w;
  });
  table.style.minWidth = total ? total+'px' : '';
}
function startResize(ev, th, table, type){
  ev.preventDefault(); ev.stopPropagation();
  const key=th.getAttribute('data-col'); if(!key || LAYOUT_SKIP.has(key)) return;
  const startX=ev.clientX;
  let widths=getWidths(type) || captureWidths(table);
  applyWidths(table, widths);                 // freeze all current widths first
  // Give every visible column an explicit width (so fixed-layout can't redistribute
  // as the dragged column grows) and capture the sum of the *other* columns once.
  // The move handler is then pure arithmetic — no per-move getComputedStyle /
  // getBoundingClientRect, which would force a synchronous reflow ~60×/sec.
  let baseTotal=0;
  Array.from(table.tHead.rows[0].cells).forEach(h=>{
    const k=h.getAttribute('data-col'); if(!k || getComputedStyle(h).display==='none') return;
    if(widths[k]==null) widths[k]=Math.round(h.getBoundingClientRect().width);
    if(k!==key) baseTotal += widths[k];
  });
  const startW = widths[key];
  table.classList.add('resizing'); _suppressSort=true;
  const move=e=>{
    const nw=Math.max(48, startW + (e.clientX-startX));
    widths[key]=nw; th.style.width=nw+'px';
    table.style.minWidth=(baseTotal+nw)+'px';
  };
  const up=()=>{
    document.removeEventListener('pointermove',move);
    document.removeEventListener('pointerup',up);
    table.classList.remove('resizing'); setWidths(type,widths);
    setTimeout(()=>{ _suppressSort=false; },0);
  };
  document.addEventListener('pointermove',move);
  document.addEventListener('pointerup',up);
}
// Per-table setup: reorder to stored order, apply stored widths, attach a
// resize handle + native-drag to each (non-skipped) header. Idempotent guard
// via the .cresize child so a re-render doesn't double-wire.
function applyTableLayout(table, type){
  const order=getOrder(type); if(order) reorderColumns(table, order);
  const widths=getWidths(type); if(widths) applyWidths(table, widths);
  Array.from(table.tHead.rows[0].cells).forEach(th=>{
    const key=th.getAttribute('data-col');
    if(!key || LAYOUT_SKIP.has(key) || th.querySelector('.cresize')) return;
    const h=document.createElement('span'); h.className='cresize';
    h.addEventListener('pointerdown', e=>startResize(e, th, table, type));
    h.addEventListener('click', e=>e.stopPropagation());
    th.appendChild(h);
  });
}
// Pointer-based drag-reorder (works cross-browser and is test-driveable, unlike
// native HTML5 DnD). pointerdown on a header arms a drag; once the pointer moves
// past a small threshold we enter reorder mode, highlight the drop slot, and on
// release splice the dragged column before/after the target by pointer midpoint.
// A plain click with no movement falls through to the sort handler below.
let _reord=null;
// Snapshot visible header geometry once, when the drag actually starts. Classes
// added mid-drag (.dragging opacity, .drop-target/.drop-after box-shadow) don't
// affect layout, so header rects are stable for the duration — no per-move reflow.
function reordSnapshot(table){
  return Array.from(table.tHead.rows[0].cells).map(th=>{
    if(getComputedStyle(th).display==='none') return null;
    const r=th.getBoundingClientRect();
    return {th, key:th.getAttribute('data-col'), left:r.left, right:r.right, mid:r.left+r.width/2};
  }).filter(Boolean);
}
function reordHeaderAt(headers, x){
  for(const h of headers) if(x>=h.left && x<h.right) return h;
  return null;
}
function reordMove(e){
  if(!_reord) return;
  if(!_reord.started){
    if(Math.abs(e.clientX-_reord.startX)<5) return;
    _reord.started=true; _suppressSort=true;
    _reord.headers=reordSnapshot(_reord.table);
    _reord.th.classList.add('dragging');
    document.body.style.cursor='grabbing';
  }
  _reord.table.tHead.rows[0].querySelectorAll('th.drop-target,th.drop-after').forEach(c=>c.classList.remove('drop-target','drop-after'));
  const over=reordHeaderAt(_reord.headers, e.clientX);
  if(over && over.th!==_reord.th && over.key && !LAYOUT_SKIP.has(over.key)){
    over.th.classList.add('drop-target');
    if(e.clientX > over.mid) over.th.classList.add('drop-after');
  }
}
function reordUp(e){
  document.removeEventListener('pointermove', reordMove);
  document.removeEventListener('pointerup', reordUp);
  const r=_reord; _reord=null;
  document.body.style.cursor='';
  if(!r) return;
  r.table.tHead.rows[0].querySelectorAll('th.dragging,th.drop-target,th.drop-after')
    .forEach(c=>c.classList.remove('dragging','drop-target','drop-after'));
  if(!r.started) return;
  const over=reordHeaderAt(r.headers, e.clientX);
  if(over && over.th!==r.th && over.key && !LAYOUT_SKIP.has(over.key)){
    const after=e.clientX > over.mid;
    let order=getOrder(r.type) || currentOrder(r.table);
    order=order.filter(k=>k!==r.key);
    let idx=order.indexOf(over.key); if(idx<0) idx=order.length; if(after) idx++;
    order.splice(idx, 0, r.key);
    setOrder(r.type, order); reorderColumns(r.table, order);
  }
  setTimeout(()=>{ _suppressSort=false; },0);
}
content.addEventListener('pointerdown', e=>{
  if(e.button!==0 || e.target.closest('.cresize')) return;
  const th=e.target.closest('.ltable th'); if(!th) return;
  const key=th.getAttribute('data-col'); if(!key || LAYOUT_SKIP.has(key)) return;
  const table=th.closest('table');
  _reord={type:tableType(table), table, key, th, startX:e.clientX, started:false};
  document.addEventListener('pointermove', reordMove);
  document.addEventListener('pointerup', reordUp);
});
function renderList(){
  const term = q.value.trim().toLowerCase();
  // gather visible projects
  const projects = [];
  for(const [cat, blk] of Object.entries(DATA.categories)){
    if(!catSelected(cat)) continue;
    blk.projects.forEach(p=>{ if(passesProject(p, term)) projects.push(p); });
  }
  projects.sort(sortFn(projSort, projSortVal));
  projects.sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));   // pinned first (stable: keeps column sort within groups)
  // gather visible refs
  const refsAll = (DATA.references||[]).filter(r=>{
    if(!catSelected(r.category)) return false;
    return passesRef(r, term);
  });
  refsAll.sort(sortFn(refSort, refSortVal));

  let html = '';
  html += `<div class="lhead">Projects <span class="lcount">${projects.length}</span>${listGearHtml()}</div>`;
  if(projects.length){
    html += `<div class="ltable-wrap"><table class="ltable proj-table ${listModClasses()}"><thead><tr>
      <th data-col="health"></th>
      ${th('Name','name',projSort)}
      ${th('Category','category',projSort)}
      ${th('Lang','language',projSort)}
      ${th('Branch','branch',projSort)}
      ${th('Domain','domain',projSort)}
      ${th('Last','last_activity',projSort)}
      ${th('Imported','created',projSort)}
      ${th('Modified','modified',projSort)}
      ${th('Tags','tags',projSort)}
    </tr></thead><tbody>${projects.map(projRow).join('')}</tbody></table></div>`;
  } else { html += `<p style="color:var(--muted)">No projects match.</p>`; }

  html += `<div class="lhead">Links &amp; references <span class="lcount">${refsAll.length}</span></div>`;
  if(refsAll.length){
    html += `<div class="ltable-wrap"><table class="ltable refs-table ${listModClasses()}"><thead><tr>
      ${th('','type',refSort)}
      ${th('Title','title',refSort)}
      ${th('Category','category',refSort)}
      ${th('Topic','topic',refSort)}
      ${th('Domain','domain',refSort)}
      ${th('Tags','tags',refSort)}
    </tr></thead><tbody>${refsAll.map(refRowList).join('')}</tbody></table></div>`;
  } else { html += `<p style="color:var(--muted)">No links match.</p>`; }

  content.innerHTML = html;
  content.querySelectorAll('.ltable').forEach(t=>applyTableLayout(t, tableType(t)));
  document.getElementById('strays').innerHTML = '';
}

// --- explorer (tree) view ---
function loadTreeExpanded(){ try{ return new Set(JSON.parse(localStorage.getItem('devhub_tree')||'[]')); }catch(e){ return new Set(); } }
function saveTreeExpanded(){ try{ localStorage.setItem('devhub_tree', JSON.stringify([...treeExpanded])); }catch(e){} }
let treeExpanded = loadTreeExpanded();
let treeFiltering = false;   // set per-render; force-expands branches while a search/filter is active
function treeMeta(p){
  const bits = [healthDot(p)];
  if(p.language && p.language!=='—') bits.push(`<span class="tlang">${esc(p.language)}</span>`);
  if(p.deployed){
    bits.push(`<a class="tdeploy dom-link" href="${esc(p.deployed)}" target="_blank" rel="noopener" title="Open ${esc(p.deployed)}">↗ ${esc(domainOf(p.deployed))}</a>`);
  }
  if(p.dirty) bits.push('<span class="badge dirty">uncommitted</span>');
  if(p.ahead) bits.push(`<span class="badge ahead">⇡${p.ahead}</span>`);
  if(p.behind) bits.push(`<span class="badge behind">⇣${p.behind}</span>`);
  if(p.no_upstream) bits.push('<span class="badge noup">no upstream</span>');
  if(p.stale_days!=null && p.stale_days>THR) bits.push(`<span class="badge stale">stale ${p.stale_days}d</span>`);
  if(!p.has_readme) bits.push('<span class="badge noreadme">no readme</span>');
  return bits.join('');
}
function fileAbs(relPath){ return DATA.dev_root + '/' + relPath; }
// Render one entry from a /api/files listing. Folders are lazily-expandable
// browse nodes; files are leaves that open in VS Code.
function renderFileEntry(e){
  const abs = fileAbs(e.path);
  if(e.dir){
    return `<div class="tnode tbrowse collapsed" data-fpath="${esc(abs)}" data-loaded="0">
      <div class="trow tfolder-row" data-tnode-toggle="1"><span class="tchev">▸</span><span class="tfico">📁</span><span class="tname">${esc(e.name)}</span></div>
      <div class="tchildren"></div></div>`;
  }
  return `<a class="trow tfile" href="vscode://file${esc(abs)}" title="Open in VS Code: ${esc(e.path)}"><span class="tchev tchev-empty">▸</span><span class="tfico">📄</span><span class="tname">${esc(e.name)}</span></a>`;
}
function treeRowMsg(text, cls){ return `<div class="trow"><span class="tchev tchev-empty">▸</span><span class="tname" style="color:var(--${cls||'muted'})">${text}</span></div>`; }
// Lazily fetch a browse node's real directory contents from the localhost
// helper and render them into its own .tchildren. Ephemeral (not persisted).
function loadDir(node){
  const box = node.querySelector(':scope > .tchildren');
  const fpath = node.dataset.fpath;
  if(!box || !fpath) return;
  node.dataset.loaded = '1';
  box.innerHTML = treeRowMsg('loading…');
  fetch(`http://127.0.0.1:${DATA.helper_port}/api/files?path=${encodeURIComponent(fpath)}`)
    .then(r=>r.json()).then(j=>{
      if(!j.ok){ box.innerHTML = treeRowMsg(esc(j.error||'error'), 'red'); return; }
      if(!j.entries.length){ box.innerHTML = treeRowMsg('empty'); return; }
      box.innerHTML = j.entries.map(renderFileEntry).join('');
    }).catch(()=>{
      node.dataset.loaded = '0';   // allow a retry once the helper is up
      // file:// / hosted pages can't reach the localhost helper; opening the
      // dashboard from the helper's own origin (served by `devhub serve`) does.
      box.innerHTML = treeRowMsg(`run <code>devhub serve</code>, then open <code>http://127.0.0.1:${DATA.helper_port}/</code> to browse files`);
    });
}
function treeRef(r){
  return `<a class="trow tref" href="${esc(safeHref(r.url))}" target="_blank" rel="noopener" title="${esc(r.title||r.url)}"><span class="tchev tchev-empty">▸</span><span class="tfico">${refIcon(r.type)}</span><span class="tname">${esc(r.title||r.url)}</span><span class="tmeta"><span class="tdom">${esc(domainOf(r.url))}</span></span></a>`;
}
function treeProject(p){
  // Every project is a live-browse node: the chevron lazy-loads its real
  // folder contents (filtered) from the helper; clicking the row opens detail.
  const abs = fileAbs(p.path);
  const cls = 'trow tprow clickable' + (p.archived?' archived':'');
  return `<div class="tnode tbrowse collapsed${p.archived?' archived':''}" data-fpath="${esc(abs)}" data-loaded="0">
    <div class="${cls}" data-id="${esc(p.category+'::'+p.name)}" role="button" tabindex="0"><span class="tchev" data-tnode-toggle="1">▸</span><span class="tfico">📦</span><span class="tname">${esc(p.name)}</span>${qaButtons(p)}<span class="tmeta">${treeMeta(p)}</span></div>
    <div class="tchildren"></div></div>`;
}
function renderTree(){
  const term = q.value.trim().toLowerCase();
  treeFiltering = !!(term || activeTags.size || activeDomain || activeTopic || activeCat.size || activeOwner || sourceMode!=='all' || showFavOnly);
  let inner = '';
  for(const [cat, blk] of Object.entries(DATA.categories)){
    if(!catSelected(cat)) continue;
    const visible = blk.projects.filter(p=>passesProject(p, term));
    visible.sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));   // pinned first
    const refs    = (refsByCat[cat]||[]).filter(r=>passesRef(r, term));
    if(!visible.length && !refs.length) continue;
    const id = 'cat:'+cat;
    const coll = (treeFiltering || treeExpanded.has(id)) ? '' : ' collapsed';
    inner += `<div class="tnode tcat${coll}" data-tnode="${esc(id)}">
      <div class="trow tcat-row" data-tnode-toggle="1"><span class="tchev">▸</span><span class="tfico">📁</span><span class="tname tcatname">${esc(blk.label)}</span><span class="tcount">${visible.length}${refs.length?` · ${refs.length}🔗`:''}</span></div>
      <div class="tchildren">${visible.map(treeProject).join('')}${refs.map(treeRef).join('')}</div></div>`;
  }
  const body = inner || `<div class="trow"><span class="tchev tchev-empty">▸</span><span class="tname" style="color:var(--muted)">No matches.</span></div>`;
  const rootName = (DATA.dev_root||'dev').split('/').filter(Boolean).pop() || 'dev';
  content.innerHTML = `<div class="tree"><div class="tnode troot" data-tnode="root"><div class="trow troot-row"><span class="tchev tchev-empty">▸</span><span class="tfico">📂</span><span class="tname trootname">${esc(rootName)}</span></div><div class="tchildren">${body}</div></div></div>`;
  document.getElementById('strays').innerHTML = '';
}

function buildFilters(){
  const cats = Object.keys(DATA.categories);
  const isAll = activeCat.size === 0;
  const mk = (id,label,n) => {
    const active = id==='all' ? isAll : activeCat.has(id);
    return `<div class="filt${active?' active':''}" data-cat="${id}">${esc(label)}${n!=null?` <span style="opacity:.6">${n}</span>`:''}</div>`;
  };
  filtersEl.innerHTML = mk('all','All',DATA.stats.total) +
    cats.map(c=>{const rn=(refsByCat[c]||[]).length;const n=DATA.categories[c].projects.length;return mk(c, DATA.categories[c].label, rn?(n+' <span style="color:var(--accent)">'+rn+'🔗</span>'):n);}).join('');
  filtersEl.querySelectorAll('.filt').forEach(el=>el.addEventListener('click', (ev)=>{
    const cat = el.dataset.cat;
    if(cat==='all'){
      activeCat.clear();
    } else {
      // Cmd/Ctrl/Shift+click = additive multi-select; plain click toggles in place
      if(activeCat.has(cat)) activeCat.delete(cat); else activeCat.add(cat);
    }
    buildFilters(); render();
  }));
}

let _searchT;
q.addEventListener('input', ()=>{ clearTimeout(_searchT); _searchT = setTimeout(render, 120); });
// Single delegated click handler for the content area. Each branch returns,
// so the card-open fallback at the end never needs an exclusion list.
content.addEventListener('click', e=>{
  const qa = e.target.closest('.qa-btn');
  if(qa){
    e.preventDefault(); e.stopPropagation();
    const p = projById[qa.dataset.qaId];
    if(p) toggleQa(qa.dataset.qa, p);
    return;
  }
  const rc = e.target.closest('.rel-chip');
  if(rc){
    e.preventDefault(); e.stopPropagation();
    if(rc.dataset.relId && projById[rc.dataset.relId]) openDetail(projById[rc.dataset.relId]);
    else if(rc.dataset.relUrl) window.open(safeHref(rc.dataset.relUrl), '_blank', 'noopener');
    return;
  }
  const th = e.target.closest('.topic-h');
  if(th && th.dataset.topic){
    e.preventDefault(); e.stopPropagation();
    activeTopic = th.dataset.topic; activeTags.clear(); activeDomain = null;
    renderActiveChip(); render();
    return;
  }
  const tc = e.target.closest('.tag-chip');
  if(tc){
    e.preventDefault(); e.stopPropagation();
    const t = tc.dataset.tag;
    if(activeTags.has(t)) activeTags.delete(t); else activeTags.add(t);
    activeDomain = null;
    buildFilters(); renderActiveChip();
    if(typeof buildTagRow==='function') buildTagRow();
    render();
    return;
  }
  const dc = e.target.closest('.dom-chip');
  if(dc){
    e.preventDefault(); e.stopPropagation();
    activeDomain = dc.dataset.domain;
    activeCat.clear();
    buildFilters(); renderActiveChip(); render();
    return;
  }
  const oc = e.target.closest('.owner-chip');
  if(oc){
    e.preventDefault(); e.stopPropagation();
    // Toggle: clicking the active owner pill clears the filter.
    activeOwner = (activeOwner===oc.dataset.owner) ? null : oc.dataset.owner;
    renderActiveChip(); render();
    return;
  }
  const me = e.target.closest('.author-me');
  if(me){
    e.preventDefault(); e.stopPropagation();
    // Toggle: "Me" cycles sourceMode between 'mine' and 'all'.
    setSourceMode(sourceMode==='mine' ? 'all' : 'mine');
    renderActiveChip(); render();
    return;
  }
  const ch = e.target.closest('.cat-h');
  if(ch){
    const catEl = ch.closest('.cat'), id = catEl.dataset.cat;
    if(collapsedSet.has(id)) collapsedSet.delete(id); else collapsedSet.add(id);
    catEl.classList.toggle('collapsed');
    saveCollapsed(collapsedSet);
    return;
  }
  // Explorer tree: a toggle element collapses/expands its node (and never opens the modal).
  const tt = e.target.closest('[data-tnode-toggle]');
  if(tt){
    const node = tt.closest('.tnode');
    if(node){
      node.classList.toggle('collapsed');
      const expanded = !node.classList.contains('collapsed');
      if(node.dataset.fpath){
        // Live file-browse node: ephemeral state, lazy-load contents on first
        // expand. Not persisted (re-render rebuilds from DATA + fetches again).
        if(expanded && node.dataset.loaded==='0') loadDir(node);
      } else {
        const id = node.dataset.tnode;   // category node: persist expand state
        if(expanded) treeExpanded.add(id); else treeExpanded.delete(id);
        saveTreeExpanded();
      }
    }
    return;
  }
  // A deployed-domain link or explicit open-button opens normally, not the modal.
  if(e.target.closest('.dom-link') || e.target.closest('.open-btn')) return;
  const c = e.target.closest('.card,.tprow');
  if(c && projById[c.dataset.id]) openDetail(projById[c.dataset.id]);
});
content.addEventListener('keydown', e=>{
  if(e.key!=='Enter' && e.key!==' ') return;
  // Quick-action buttons are real <button>s — the native click fires and the
  // click delegation handles them; don't also open the card detail.
  if(e.target.closest('.qa-btn')) return;
  // Author/owner pills: keyboard-activate them like a button instead of
  // bubbling up to open the card detail.
  const chip = e.target.closest('.owner-chip,.author-me');
  if(chip){ e.preventDefault(); chip.click(); return; }
  const c = e.target.closest('.card,.tprow');
  if(c && projById[c.dataset.id]){ e.preventDefault(); openDetail(projById[c.dataset.id]); }
});
modal.addEventListener('click', e=>{
  if(e.target===modal || e.target.classList.contains('modal-x')) closeModal();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });
document.getElementById('collapseAll').addEventListener('click', ()=>{
  Object.keys(DATA.categories).forEach(c=>collapsedSet.add(c)); saveCollapsed(collapsedSet);
  treeExpanded.clear(); saveTreeExpanded();
  render();
});
document.getElementById('expandAll').addEventListener('click', ()=>{
  collapsedSet.clear(); saveCollapsed(collapsedSet);
  Object.keys(DATA.categories).forEach(c=>treeExpanded.add('cat:'+c));
  saveTreeExpanded();
  render();
});
document.getElementById('viewCards').addEventListener('click', ()=>setViewMode('cards'));
document.getElementById('viewList' ).addEventListener('click', ()=>setViewMode('list'));
document.getElementById('viewTree' ).addEventListener('click', ()=>setViewMode('tree'));
content.addEventListener('click', e=>{
  if(_suppressSort || e.target.closest('.cresize')) return;   // ignore clicks ending a resize/drag
  const h = e.target.closest('.ltable th[data-sort]'); if(!h) return;
  const key = h.dataset.sort;
  const isRefs = h.closest('.refs-table') !== null;
  const obj = isRefs ? refSort : projSort;
  if(obj.key===key){ obj.dir = -obj.dir; } else { obj.key = key; obj.dir = 1; }
  render();
});
// Tag -> occurrence count across every project + reference (the full tag universe).
function allTagCounts(){
  const counts = {};
  for(const blk of Object.values(DATA.categories))
    for(const p of blk.projects) for(const t of (p.tags||[])) counts[t] = (counts[t]||0) + 1;
  for(const r of (DATA.references||[]))
    for(const t of (r.tags||[])) counts[t] = (counts[t]||0) + 1;
  return counts;
}
function buildTagRow(){
  const counts = allTagCounts();
  const tagrow = document.getElementById('tagrow');
  const tags = Object.keys(counts).sort((a,b)=> counts[b]-counts[a] || a.localeCompare(b));
  if(!tags.length){ tagrow.innerHTML = ''; return; }
  let html = `<span class="tagrow-label">Tags</span>` +
    `<div class="filt tag${activeTags.size===0?' active':''}" data-tag="">all</div>`;
  for(const t of tags){
    html += `<div class="filt tag${activeTags.has(t)?' active':''}" data-tag="${esc(t)}" style="${tagStyle(t)}">#${esc(t)} <span style="opacity:.6">${counts[t]}</span></div>`;
  }
  tagrow.innerHTML = html;
  tagrow.querySelectorAll('.filt.tag').forEach(el => el.addEventListener('click', ()=>{
    const t = el.dataset.tag;
    if(!t){
      activeTags.clear();
    } else {
      if(activeTags.has(t)) activeTags.delete(t);
      else activeTags.add(t);
    }
    activeDomain = null; activeTopic = null;
    buildTagRow(); renderActiveChip(); render();
  }));
}

function updateArchToggle(){
  const b = document.getElementById('archToggle');
  const n = DATA.stats.archived || 0;
  b.textContent = (showArchived ? 'Hide archived' : 'Show archived') + (n ? ` (${n})` : '');
  b.classList.toggle('active', showArchived);
}
document.getElementById('archToggle').addEventListener('click', ()=>{
  showArchived = !showArchived;
  try{ localStorage.setItem('devhub_archived', showArchived ? '1' : '0'); }catch(e){}
  updateArchToggle(); render();
});

// ---- Favorites filter + quick-action toggles ------------------------------
function favCount(){
  let n = 0;
  for(const blk of Object.values(DATA.categories)) blk.projects.forEach(p=>{ if(p.favorite) n++; });
  return n;
}
function updateFavToggle(){
  const b = document.getElementById('favToggle');
  const n = favCount();
  b.textContent = '★ Favorites' + (n ? ` (${n})` : '');
  b.classList.toggle('active', showFavOnly);
}
function setFavOnly(next){
  showFavOnly = next;
  try{ localStorage.setItem('devhub_favonly', showFavOnly ? '1' : '0'); }catch(e){}
  updateFavToggle();
}
document.getElementById('favToggle').addEventListener('click', ()=>{
  setFavOnly(!showFavOnly);
  renderActiveChip(); render();
});
// Toggle one of the flag verbs (favorite/pin/archive) via the helper, then
// refresh the whole view from the returned manifest.
async function toggleQa(kind, p){
  const field = kind==='favorite' ? 'favorite' : (kind==='pin' ? 'pinned' : 'archived');
  const next = !p[field];
  const msg = {favorite: next?'Added to favorites ★':'Removed from favorites',
               pin: next?'Pinned to top of category 📌':'Unpinned',
               archive: next?'Archived 📦':'Unarchived'}[kind];
  try{
    const j = await callApi(kind, {project: p.name, [field]: next});
    toast(msg, 'ok');
    refreshFromManifest(j.manifest);
  }catch(e){ toast('Error: '+e.message+' — is the helper running? (devhub serve)', 'err'); }
}

// Source filter (Mine / External / All) — persisted alongside the other view state.
// When github_login is unset the Mine/External distinction is meaningless
// (every repo would be classified Mine), so hide the select entirely instead
// of letting users select a filter that silently shows nothing.
(function(){
  const sel = document.getElementById('sourceMode');
  if(!sel) return;
  const loginConfigured = !!((DATA_CONFIG && DATA_CONFIG.github_login || '').trim());
  if(!loginConfigured){
    sel.style.display = 'none';
    sel.title = 'Set github_login in Settings to enable source filtering';
    if(sourceMode !== 'all') setSourceMode('all');
    return;
  }
  sel.value = sourceMode;
  sel.classList.toggle('active', sourceMode!=='all');
  sel.addEventListener('change', ()=>{
    setSourceMode(sel.value);
    renderActiveChip();
    render();
  });
})();

// ---- Filters collapse toggle ----------------------------------------------
const filtersBlock = document.getElementById('filtersBlock');
let filtersOpen = (function(){ try{ return localStorage.getItem('devhub_filters_open')==='1'; }catch(e){ return false; } })();
function updateFiltersToggle(){
  const btn = document.getElementById('filtersToggle');
  filtersBlock.style.display = filtersOpen ? '' : 'none';
  const dotIfActive = (activeCat.size||activeTags.size||activeDomain||activeTopic) ? ' •' : '';
  btn.innerHTML = (filtersOpen ? 'Filters ▾' : 'Filters ▸') + dotIfActive;
  btn.classList.toggle('active', filtersOpen);
}
document.getElementById('filtersToggle').addEventListener('click', ()=>{
  filtersOpen = !filtersOpen;
  try{ localStorage.setItem('devhub_filters_open', filtersOpen?'1':'0'); }catch(e){}
  updateFiltersToggle();
});

// ---- Settings gear menu ---------------------------------------------------
// Reflect the configured terminal app (Kitty, Ghostty, iTerm2, …) in both the
// gear-menu item and any open detail-modal button. Called from gear-menu init
// and after a Config-save POST updates DATA_CONFIG.
function applyTerminalLabel(){
  const label = (DATA_CONFIG && DATA_CONFIG.terminal_app) || 'Terminal';
  document.querySelectorAll('[data-ws="terminal"]').forEach(el=>{ el.textContent = label; });
  document.querySelectorAll('[data-action="terminal"]').forEach(el=>{ el.textContent = label + ' ▸'; });
}
(function(){
  const wrap = document.getElementById('settingsWrap');
  const btn  = document.getElementById('gearBtn');
  const menu = document.getElementById('gearMenu');
  if(!wrap || !btn || !menu) return;
  const openMenu  = ()=>{ menu.classList.add('open');  btn.setAttribute('aria-expanded','true'); };
  const closeMenu = ()=>{ menu.classList.remove('open'); btn.setAttribute('aria-expanded','false'); };
  btn.addEventListener('click', e=>{ e.stopPropagation(); menu.classList.contains('open')?closeMenu():openMenu(); });
  document.addEventListener('click', e=>{ if(!wrap.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeMenu(); });

  applyTerminalLabel();

  // Open the workspace root in Terminal / Finder / VS Code via the helper.
  menu.querySelectorAll('[data-ws]').forEach(b=>b.addEventListener('click', ()=>{
    const action = b.dataset.ws, path = DATA.dev_root;
    closeMenu();
    const url = `http://127.0.0.1:${DATA.helper_port}/open?action=${encodeURIComponent(action)}&path=${encodeURIComponent(path)}`;
    fetch(url).then(r=>r.json()).then(j=>{
      toast(j.ok ? (j.launched?'Opened ✓':'OK ✓') : ('Error: '+(j.error||'')), j.ok?'ok':'err');
    }).catch(()=>{
      if(action==='finder'){ window.open(encodeURI('file://'+path),'_blank'); toast('Opened in browser','ok'); }
      else toast('Run: devhub serve to enable this','err');
    });
  }));

  document.getElementById('gmConfig').addEventListener('click', ()=>{ closeMenu(); openConfigDialog(); });

  document.getElementById('gmPorts').addEventListener('click', ()=>{
    closeMenu();
    window.open(`http://127.0.0.1:${DATA.helper_port}/ports`, '_blank');
  });

  // Restart helper — kicks the LaunchAgent so it respawns this process with
  // the new code / freshly bound helper_port. The fetch may resolve OR error
  // depending on whether the response flushes before the process gets killed;
  // either way, the dev-state poll will drive the status dot back to "online"
  // once the supervisor brings the helper back (~1-2s).
  document.getElementById('gmRestart').addEventListener('click', ()=>{
    closeMenu();
    toast('Restarting helper…', 'ok');
    fetch(`http://127.0.0.1:${DATA.helper_port}/api/helper/restart`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
    }).then(r=>r.json()).then(j=>{
      if(j && j.ok === false) toast('Error: ' + (j.error || 'restart failed'), 'err');
    }).catch(()=>{ /* expected mid-restart: connection killed by SIGKILL */ });
  });

  // Sign out — only meaningful behind the Cloudflare Worker (basic auth). Hidden
  // on file:// and the local helper (localhost/127.0.0.1), where /logout 404s.
  const h = location.hostname;
  const isRemote = location.protocol.indexOf('http') === 0 && h && h !== 'localhost' && h !== '127.0.0.1';
  const lo = document.getElementById('gmLogout');
  if(isRemote && lo) lo.style.display = '';
  if(lo) lo.addEventListener('click', ()=>{ location.assign('/logout'); });

  // Helper online/offline dot, refreshed by the dev-state poll.
  window.setHelperStatus = function(online){
    const dot = document.getElementById('gmDot'), txt = document.getElementById('gmDotTxt');
    if(dot){ dot.classList.toggle('on', !!online); dot.classList.toggle('off', !online); }
    if(txt){ txt.textContent = online ? 'helper online' : 'helper offline'; }
  };
})();

// ---- Config dialog (settings gear) ----------------------------------------
function openConfigDialog(){
  const c = DATA_CONFIG || {};
  const apps = c.terminal_apps || ['Terminal','iTerm2','Kitty','Ghostty','Alacritty'];
  const cur  = c.terminal_app || 'Terminal';
  const appOpts = apps.map(a=>`<option value="${esc(a)}"${a===cur?' selected':''}>${esc(a)}</option>`).join('');
  modalBody.innerHTML = `
    <div class="dhead"><div class="dtitle">⚙ Settings</div></div>
    <p class="ddesc">Edits <code>categories.json</code>. Saving regenerates the dashboard. Requires <code>devhub serve</code> running.</p>
    <div class="editform">
      <label>Terminal app <span class="cf-hint">— Terminal buttons &amp; dev-server launch</span></label>
      <select id="cf-terminal_app">${appOpts}</select>
      <div class="row">
        <div><label>Stale threshold (days)</label><input type="number" id="cf-stale_days" min="1" max="3650" value="${esc(String(c.stale_days!=null?c.stale_days:120))}"></div>
        <div><label>Dev port base</label><input type="number" id="cf-dev_port_base" min="1024" max="65535" value="${esc(String(c.dev_port_base!=null?c.dev_port_base:6100))}"></div>
      </div>
      <div class="row">
        <div><label>Helper port <span class="cf-hint">— restart helper to apply</span></label><input type="number" id="cf-helper_port" min="1024" max="65535" value="${esc(String(c.helper_port!=null?c.helper_port:7333))}"></div>
        <div><label>GitHub login</label><input type="text" id="cf-github_login" value="${esc(c.github_login||'')}" placeholder="username"></div>
      </div>
      <label>host_root <span class="cf-hint">— absolute Mac path embedded in links; machine-specific</span></label>
      <input type="text" id="cf-host_root" value="${esc(c.host_root||'')}" placeholder="/Users/you/Arik/dev">
      <div class="actions">
        <button class="btn success" id="cf-save">Save</button>
        <button class="btn" id="cf-cancel">Cancel</button>
      </div>
    </div>`;
  modal.classList.add('open');
  document.getElementById('cf-cancel').addEventListener('click', closeModal);
  document.getElementById('cf-save').addEventListener('click', async ()=>{
    const body = {
      terminal_app:  document.getElementById('cf-terminal_app').value,
      stale_days:    parseInt(document.getElementById('cf-stale_days').value, 10),
      dev_port_base: parseInt(document.getElementById('cf-dev_port_base').value, 10),
      helper_port:   parseInt(document.getElementById('cf-helper_port').value, 10),
      github_login:  document.getElementById('cf-github_login').value.trim(),
      host_root:     document.getElementById('cf-host_root').value.trim(),
    };
    try{
      const r = await fetch(`http://127.0.0.1:${DATA.helper_port}/api/config`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || 'save failed');
      if(j.config){ DATA_CONFIG = j.config; applyTerminalLabel(); }
      toast('Settings saved', 'ok');
      if(j.manifest) refreshFromManifest(j.manifest);
      closeModal();
    }catch(e){
      toast('Error: ' + (e.message||e) + ' — is `devhub serve` running?', 'err');
    }
  });
}

// ---- Toast --------------------------------------------------------------
function toast(msg, kind){
  const el = document.createElement('div');
  el.className = 'toast ' + (kind||'');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(), 200); }, 1800);
}

// ---- CRUD: call helper ---------------------------------------------------
async function callApi(verb, body){
  const url = `http://127.0.0.1:${DATA.helper_port}/api/cards/${verb}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body||{})
  });
  if(!r.ok){
    let j = {};
    try{ j = await r.json(); }catch(e){}
    throw new Error(j.error || ('HTTP '+r.status));
  }
  return await r.json();
}
function refreshFromManifest(m){
  if(!m) return;
  DATA = m;
  // rebuild ref index
  Object.keys(refsByCat).forEach(k=>delete refsByCat[k]);
  Object.keys(attachedByProject).forEach(k=>delete attachedByProject[k]);
  Object.keys(topicsByProject).forEach(k=>delete topicsByProject[k]);
  Object.keys(projById).forEach(k=>delete projById[k]);
  (DATA.references||[]).forEach(r=>{
    (refsByCat[r.category]=refsByCat[r.category]||[]).push(r);
    if(r.project){
      (attachedByProject[r.project]=attachedByProject[r.project]||[]).push(r);
      if(r.topic){ (topicsByProject[r.project]=topicsByProject[r.project]||new Set()).add(r.topic); }
    }
  });
  for(const [cat, blk] of Object.entries(DATA.categories)){
    blk.projects.forEach(p=>{ projById[cat+'::'+p.name] = p; });
  }
  buildFilters(); buildTagRow(); updateArchToggle(); updateFavToggle(); render();
}

// ---- Linkify helper -----------------------------------------------------
function linkify(text){
  if(!text) return '';
  // escape first, then convert raw URLs to links
  const safe = esc(text);
  return safe.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// ---- Edit form in modal -------------------------------------------------
function openEditForm(p){
  const cats = Object.keys(DATA.categories);
  const catOpts = cats.map(c=>`<option value="${esc(c)}"${c===p.category?' selected':''}>${esc(DATA.categories[c].label)}</option>`).join('');
  const tagChips = (p.tags||[]).map(t=>`<span class="tagedit-chip" data-tag="${esc(t)}">#${esc(t)} <span class="x" title="Remove">×</span></span>`).join('');
  const html = `
    <div class="editform" id="editform" data-project="${esc(p.name)}">
      <label>Name</label>
      <input type="text" id="ef-name" value="${esc(p.name)}">
      <label>Category</label>
      <select id="ef-category">${catOpts}</select>
      <label>Note</label>
      <textarea id="ef-note" placeholder="Short description shown on the card">${esc(p.note||'')}</textarea>
      <label>Tags</label>
      <div class="tagedit-chips" id="ef-tagchips">${tagChips}</div>
      <input type="text" id="ef-tagadd" placeholder="type tag and press Enter to add" style="margin-top:6px">
      <label style="margin-top:10px"><input type="checkbox" id="ef-favorite"${p.favorite?' checked':''}> Favorite (★ quick-filter in the toolbar)</label>
      <label style="margin-top:6px"><input type="checkbox" id="ef-pinned"${p.pinned?' checked':''}> Pinned (sorts to the top of its category)</label>
      <label style="margin-top:6px"><input type="checkbox" id="ef-archived"${p.archived?' checked':''}> Archived (dim and hide by default)</label>
      <div class="actions">
        <button class="btn success" id="ef-save">Save</button>
        <button class="btn" id="ef-cancel">Cancel</button>
        <button class="btn danger right" id="ef-archive-btn">${p.archived?'Unarchive':'Archive'}</button>
      </div>
    </div>`;
  document.getElementById('editform-mount').innerHTML = html;

  const form = document.getElementById('editform');
  // tag chip remove
  form.querySelectorAll('.tagedit-chip .x').forEach(x=>x.addEventListener('click', ()=>{
    x.closest('.tagedit-chip').remove();
  }));
  // tag add via Enter
  document.getElementById('ef-tagadd').addEventListener('keydown', (ev)=>{
    if(ev.key !== 'Enter') return;
    ev.preventDefault();
    const input = ev.currentTarget;
    const val = input.value.trim();
    if(!val) return;
    const norm = val.toLowerCase().replace(/\s+/g,'-');
    const chips = document.getElementById('ef-tagchips');
    if(![...chips.querySelectorAll('.tagedit-chip')].some(c=>c.dataset.tag===norm)){
      const span = document.createElement('span');
      span.className='tagedit-chip';
      span.dataset.tag=norm;
      span.innerHTML = `#${esc(norm)} <span class="x" title="Remove">×</span>`;
      span.querySelector('.x').addEventListener('click', ()=>span.remove());
      chips.appendChild(span);
    }
    input.value='';
  });
  document.getElementById('ef-cancel').addEventListener('click', ()=>{
    document.getElementById('editform-mount').innerHTML = '';
  });
  document.getElementById('ef-archive-btn').addEventListener('click', async ()=>{
    try{
      const j = await callApi('archive', {project: p.name, archived: !p.archived});
      toast(p.archived ? 'Unarchived' : 'Archived', 'ok');
      refreshFromManifest(j.manifest);
      closeModal();
    }catch(e){ toast('Error: '+e.message, 'err'); }
  });
  document.getElementById('ef-save').addEventListener('click', async ()=>{
    const newName = document.getElementById('ef-name').value.trim();
    const newCat  = document.getElementById('ef-category').value;
    const newNote = document.getElementById('ef-note').value;
    const newArch = document.getElementById('ef-archived').checked;
    const newFav  = document.getElementById('ef-favorite').checked;
    const newPin  = document.getElementById('ef-pinned').checked;
    const newTags = [...form.querySelectorAll('.tagedit-chip')].map(c=>c.dataset.tag);
    const oldTags = new Set(p.tags||[]);
    const setNew = new Set(newTags);
    const toAdd  = newTags.filter(t=>!oldTags.has(t));
    const toRm   = [...oldTags].filter(t=>!setNew.has(t));
    try{
      let lastManifest = null;
      let projectName = p.name;
      // rename first (so subsequent ops refer to the new name)
      if(newName && newName !== p.name){
        const j = await callApi('rename', {project: p.name, new_name: newName});
        lastManifest = j.manifest;
        projectName = newName;
      }
      // move
      if(newCat && newCat !== p.category){
        const j = await callApi('move', {project: projectName, category: newCat});
        lastManifest = j.manifest;
      }
      // note
      if((newNote||'') !== (p.note||'')){
        const j = await callApi('note', {project: projectName, text: newNote});
        lastManifest = j.manifest;
      }
      // tags (one call with add+remove)
      if(toAdd.length || toRm.length){
        const j = await callApi('tag', {project: projectName, add: toAdd, remove: toRm});
        lastManifest = j.manifest;
      }
      // archive / favorite / pin
      if(newArch !== !!p.archived){
        const j = await callApi('archive', {project: projectName, archived: newArch});
        lastManifest = j.manifest;
      }
      if(newFav !== !!p.favorite){
        const j = await callApi('favorite', {project: projectName, favorite: newFav});
        lastManifest = j.manifest;
      }
      if(newPin !== !!p.pinned){
        const j = await callApi('pin', {project: projectName, pinned: newPin});
        lastManifest = j.manifest;
      }
      toast('Saved', 'ok');
      if(lastManifest) refreshFromManifest(lastManifest);
      closeModal();
    }catch(e){
      toast('Error: '+e.message, 'err');
    }
  });
}

// ---- Add card button (top toolbar) --------------------------------------
function openAddCardDialog(){
  const cats = Object.keys(DATA.categories);
  const catOpts = '<option value="">(auto-classify)</option>' +
    cats.map(c=>`<option value="${esc(c)}">${esc(DATA.categories[c].label)}</option>`).join('');
  modalBody.innerHTML = `
    <div class="dhead"><div class="dtitle">Add a card</div></div>
    <p class="ddesc">Paste a git repo URL, a web/youtube link, or a local folder path.</p>
    <div class="editform">
      <label>Source</label>
      <input type="text" id="ac-source" placeholder="https://github.com/owner/repo  or  https://example.com/article  or  /abs/path">
      <div class="row">
        <div><label>Category (optional)</label><select id="ac-category">${catOpts}</select></div>
        <div><label>Name override (repos/folders)</label><input type="text" id="ac-name" placeholder="(derived from URL)"></div>
      </div>
      <label>Title override (links only)</label>
      <input type="text" id="ac-title" placeholder="(fetched from page if blank)">
      <div class="actions">
        <button class="btn success" id="ac-create">Create</button>
        <button class="btn" id="ac-cancel">Cancel</button>
      </div>
    </div>`;
  modal.classList.add('open');
  document.getElementById('ac-cancel').addEventListener('click', closeModal);
  document.getElementById('ac-create').addEventListener('click', async ()=>{
    const source = document.getElementById('ac-source').value.trim();
    if(!source){ toast('Source is required', 'err'); return; }
    const body = {source};
    const cat = document.getElementById('ac-category').value.trim();
    const name = document.getElementById('ac-name').value.trim();
    const title = document.getElementById('ac-title').value.trim();
    if(cat) body.category = cat;
    if(name) body.name = name;
    if(title) body.title = title;
    try{
      toast('Creating…');
      const j = await callApi('create', body);
      toast(j.created==='reference' ? `Saved link in ${j.category}` : `Created ${j.name} in ${j.category}`, 'ok');
      refreshFromManifest(j.manifest);
      closeModal();
    }catch(e){ toast('Error: '+e.message, 'err'); }
  });
}
document.getElementById('addCardBtn').addEventListener('click', openAddCardDialog);

hydrateUIState();
updateViewBtns();
buildFilters();
buildTagRow();
renderActiveChip();
updateArchToggle();
updateFavToggle();
updateFiltersToggle();
render();
</script>
</body>
</html>"""


def cmd_dev(args):
    """Start a project's dev server on its assigned port and print its .test name.

    Adds no spawn logic of its own — it is the terminal entry point to the same
    resolution chain the dashboard button uses (detect_dev_command ->
    build_launch_command -> DEVHUB_PORT/PORT), so a project's port is honored
    identically from either surface.
    """
    import subprocess as sp
    cfg = load_config()
    name = args.project
    target, _cat = _find_project_path(name, cfg)
    if target is None:
        print(f"unknown project: {name}", file=sys.stderr)
        return 1

    # Two directories can share a name, and the registry is keyed by name — so
    # the port and the .test route belong to whichever resolves first. Say so
    # before anything else, since it explains every surprise downstream.
    try:
        others = [DEV_ROOT / c / name for c in known_categories(cfg)
                  if (DEV_ROOT / c / name).is_dir()
                  and (DEV_ROOT / c / name) != target]
    except Exception:
        others = []          # advisory only; never block a launch over it
    if others:
        print(f"note: {len(others) + 1} directories are named {name!r}; using "
              f"{target}. Sharing its port and .test name: "
              + ", ".join(str(o) for o in others), file=sys.stderr)

    entry = (cfg.get("links") or {}).get(name) or {}
    port = entry.get("dev_port")
    if not port:
        print(f"{name} has no dev_port — run: devhub ports", file=sys.stderr)
        return 1

    devcmd = detect_dev_command(target, cfg)
    if not devcmd:
        print(f"{name} has no detectable dev command; set one with "
              f"`devhub set-link {name} --dev-cmd '<cmd>'`", file=sys.stderr)
        return 1

    url = _resolved_dev_url(target, cfg)
    launch = build_launch_command(devcmd, int(port), Path(target))
    run = f"{dev_env_prefix(name, int(port))} {launch}"

    print(f"{name}  ->  {url}")
    print(f"  {run}")
    if getattr(args, "dry_run", False):
        return 0
    sp.Popen(run, shell=True, cwd=str(target))
    return 0


# --------------------------------------------------------------------------- #
# arg parsing
# --------------------------------------------------------------------------- #
def cmd_ports(args):
    """Assign/list devhub-managed dev ports. Assigns the next free port (from
    dev_port_base) to every project missing one; --reassign forces a value."""
    cfg = load_config()
    # Same project set the manifest shows (categorized + pinned top-level),
    # without the full git-scanning manifest build just to list names.
    names = [n for n, _ in _ports_projects(cfg)]
    if getattr(args, "reassign", None):
        name, port = args.reassign[0], int(args.reassign[1])
        links = cfg.setdefault("links", {})
        for other, e in links.items():
            if other != name and isinstance(e, dict) and e.get("dev_port") \
                    and int(e["dev_port"]) == port:
                print(f"refused: port {port} already assigned to {other}",
                      file=sys.stderr)
                sys.exit(1)
        links.setdefault(name, {})["dev_port"] = port
        save_config(cfg)
        print(f"set {name} dev_port={port}")
        return
    changed = assign_dev_ports(cfg, names)
    if changed:
        save_config(cfg)
    base = int(cfg.get("dev_port_base") or DEFAULT_DEV_PORT_BASE)
    print(f"dev_port_base={base}  ({len(changed)} newly assigned)")
    for name in sorted(names):
        e = (cfg.get("links") or {}).get(name) or {}
        if e.get("dev_port"):
            path = e.get("dev_path") or ""
            mark = " *new*" if name in changed else ""
            print(f"  {name:24} :{e['dev_port']}{path}{mark}")


def cmd_announce(args):
    """Tell the running helper that a dev server is up (self-advertise).
    Intended to be called from a project's dev script:
        devhub announce --project NAME --port $PORT
    """
    cfg = load_config()
    port = int(args.helper_port or cfg.get("helper_port", 7333))
    # No pid: announce is a separate short-lived process, so its pid is never
    # the dev server's. Stop/restart resolves the real pid lazily via lsof on
    # the assigned port — sending os.getpid() here would store a dead pid and
    # make the safety check refuse the kill.
    payload = json.dumps({"project": args.project, "port": int(args.port)}).encode()
    url = f"http://127.0.0.1:{port}/api/dev/register"
    req = urllib.request.Request(url, data=payload,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            ok = json.load(r).get("ok")
        print(f"announced {args.project} :{args.port}" if ok else "announce rejected")
    except Exception as e:
        # best-effort: never fail the caller's dev script if the helper is down
        print(f"announce failed: {e}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# builds gallery (showcase) sync — keep builds.beric.ca in step with deploys
# --------------------------------------------------------------------------- #
# The "Builds" portfolio at https://builds.beric.ca is a *curated* gallery of
# the user's own shipped apps. Its source lives beside this toolkit:
#   builds-gallery-src/apps.json  card data (name/category/kind/image/…/live)
#   builds-gallery-src/build.mjs  bun generator -> ~/Arik/dev/showcase.html
#   builds-gallery-src/shots/     per-app screenshots referenced by `image`
#   builds-gallery/index.html     Vercel deploy root (a copy of showcase.html)
# `gallery gaps` reports live-deployed, own-owned projects NOT yet in apps.json
# (this powers the /devhub skill's "offer to showcase it" step after a deploy).
# `gallery build [--deploy]` regenerates the gallery and optionally ships it to
# Vercel prod. Entry authoring + screenshots stay in the skill (they need
# judgment); this command owns only the deterministic, error-prone mechanics.
GALLERY_SRC = HERE / "builds-gallery-src"
GALLERY_APPS = GALLERY_SRC / "apps.json"
GALLERY_BUILD_MJS = GALLERY_SRC / "build.mjs"
GALLERY_SHOTS = GALLERY_SRC / "shots"
GALLERY_DEPLOY_DIR = HERE / "builds-gallery"
GALLERY_SHOWCASE_OUT = DEV_ROOT / "showcase.html"   # build.mjs OUT_DIR
GALLERY_VERCEL_SCOPE = "eric-baruchs-projects"
GALLERY_LIVE_URL = "https://builds.beric.ca"


def _gallery_repo_slug(url: str) -> str:
    """owner/repo (lowercased, no .git) from a git remote/github URL; '' if none."""
    owner = _parse_owner(url or "")
    if not owner:
        return ""
    m = re.search(r"[:/]" + re.escape(owner) + r"/([^/#?]+)", url, re.I)
    repo = (m.group(1) if m else "").strip().lower()
    if repo.endswith(".git"):
        repo = repo[:-4]
    return f"{owner.lower()}/{repo}" if repo else ""


def _url_host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _load_gallery_apps() -> list:
    try:
        data = json.loads(GALLERY_APPS.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"warning: could not read {GALLERY_APPS}: {e}", file=sys.stderr)
        return []


def _gallery_present(apps: list) -> set:
    """Identity tokens already in the gallery: repo slugs + live-URL hosts."""
    keys = set()
    for a in apps:
        slug = _gallery_repo_slug(a.get("github") or "")
        if slug:
            keys.add(slug)
        host = _url_host(a.get("live") or "")
        if host:
            keys.add(host)
    return keys


def _gallery_gaps(as_json: bool = True) -> list:
    """Own-owned projects with a live deploy URL that aren't in the gallery yet."""
    if not MANIFEST_PATH.exists():
        print("No manifest.json yet — run `devhub scan` first.", file=sys.stderr)
        return []
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"error: could not read manifest: {e}", file=sys.stderr)
        return []
    present = _gallery_present(_load_gallery_apps())
    gaps = []
    for cat_key, cat in (manifest.get("categories") or {}).items():
        for p in cat.get("projects", []):
            if not p.get("mine"):
                continue
            dep = (p.get("deployed") or "").strip()
            if not dep:
                continue
            slug = _gallery_repo_slug(p.get("remote") or "")
            host = _url_host(dep)
            if (slug and slug in present) or (host and host in present):
                continue
            gaps.append({
                "name": p.get("name"),
                "category": p.get("category") or cat_key,
                "remote": p.get("remote") or "",
                "deployed": dep,
                "path": p.get("path") or "",
            })
    gaps.sort(key=lambda g: (g["category"], (g["name"] or "").lower()))
    if not gaps:
        print("Gallery is in sync — every live-deployed own project is showcased.")
    else:
        print(f"{len(gaps)} deployed project(s) not yet in the builds gallery "
              f"({GALLERY_LIVE_URL}):")
        for g in gaps:
            print(f"  • {(g['name'] or '?'):22} {(g['category'] or ''):6} {g['deployed']}")
        print("\nFor each: add a screenshot to shots/ + an apps.json entry, then "
              "`devhub gallery build --deploy`. (The /devhub skill drives this.)")
    if as_json:
        print("\n=== GALLERY GAPS (JSON) ===")
        print(json.dumps(gaps, indent=2))
        print("=== END GALLERY GAPS ===")
    return gaps


def _gallery_build(deploy: bool = False) -> int:
    """Regenerate showcase.html from apps.json and (optionally) ship to Vercel."""
    if not GALLERY_BUILD_MJS.exists():
        print(f"error: {GALLERY_BUILD_MJS} not found.", file=sys.stderr)
        return 1
    bun = shutil.which("bun")
    if not bun:
        print("error: `bun` not found on PATH — needed to build the gallery.",
              file=sys.stderr)
        return 1
    print(f"Building gallery from {GALLERY_APPS.name} …")
    r = subprocess.run([bun, "build.mjs"], cwd=str(GALLERY_SRC),
                       capture_output=True, text=True)
    if r.returncode != 0:
        if r.stdout:
            print(r.stdout)
        print(r.stderr, file=sys.stderr)
        print("gallery build failed.", file=sys.stderr)
        return r.returncode
    if not GALLERY_SHOWCASE_OUT.exists():
        print(f"error: expected {GALLERY_SHOWCASE_OUT} after build.", file=sys.stderr)
        return 1
    GALLERY_DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    dest = GALLERY_DEPLOY_DIR / "index.html"
    shutil.copyfile(GALLERY_SHOWCASE_OUT, dest)
    print(f"Built {len(_load_gallery_apps())} cards -> {dest}")
    if not deploy:
        print("Not deployed (pass --deploy to ship to Vercel prod).")
        return 0
    vercel = shutil.which("vercel")
    if not vercel:
        print(f"error: `vercel` CLI not found — cannot deploy. Built files are ready "
              f"at {dest}.", file=sys.stderr)
        return 1
    print(f"Deploying to Vercel prod (scope {GALLERY_VERCEL_SCOPE}) …")
    r = subprocess.run([vercel, "deploy", str(GALLERY_DEPLOY_DIR),
                        "--prod", "--yes", "--scope", GALLERY_VERCEL_SCOPE],
                       capture_output=True, text=True)
    tail = ((r.stdout or "") + (r.stderr or "")).strip()
    if tail:
        print(tail[-1500:])
    if r.returncode != 0:
        print("vercel deploy failed.", file=sys.stderr)
        return r.returncode
    print(f"Deployed. Live at {GALLERY_LIVE_URL} (custom domain tracks newest prod).")
    return 0


def cmd_gallery(args):
    action = getattr(args, "action", None) or "gaps"
    if action == "gaps":
        _gallery_gaps()
    elif action == "build":
        rc = _gallery_build(deploy=bool(getattr(args, "deploy", False)))
        if rc:
            sys.exit(rc)
    else:  # pragma: no cover — argparse choices guard this
        print(f"unknown gallery action: {action}", file=sys.stderr)
        sys.exit(2)


def main():
    ap = argparse.ArgumentParser(prog="canopy library", description="Organize projects, references, tags, links, health and dev servers.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("scan", help="rebuild manifest.json")
    pidx = sub.add_parser("index", help="scan + regenerate index.html")
    pidx.add_argument("--no-stage", action="store_true",
                      help="don't git-stage index.html after regenerating")
    sub.add_parser("doctor", help="print a health report")

    pb = sub.add_parser(
        "build",
        help="deep refresh: mine deploy URLs/CI, health-check live URLs, "
             "discover subprojects, persist auto-links (data half of "
             "the /devhub build skill workflow)")
    pb.add_argument("scope", nargs="?",
                    help="limit to a category or a single project (default: all)")
    pb.add_argument("--no-check", action="store_true", dest="no_check",
                    help="skip live URL health checks")
    pb.add_argument("--include-vendored", action="store_true",
                    dest="include_vendored",
                    help="also include upstream/cloned repos in the README report")
    pb.add_argument("--no-readmes", action="store_true", dest="no_readmes",
                    help="data-only refresh; tells the skill to skip README authoring")
    pb.add_argument("--no-fetch", action="store_true", dest="no_fetch",
                    help="skip the pre-scan parallel git fetch (offline / faster; "
                         "ahead/behind then reflects the last fetch)")

    pg = sub.add_parser("git",
                        help="monitor + batch-manage all repos "
                             "(status/fetch/pull/push/sync)")
    pg.add_argument("action", nargs="?", default="status",
                    choices=["status", "fetch", "pull", "push", "sync"],
                    help="status (default) | fetch | pull (ff-only) | push | sync")
    pg.add_argument("scope", nargs="?",
                    help="limit to a category or a single project (default: all)")
    pg.add_argument("--dirty", action="store_true",
                    help="status: show only repos that need attention")

    pc = sub.add_parser("classify", help="suggest a category for strays or a path")
    pc.add_argument("path", nargs="?", help="optional folder to classify")

    pi = sub.add_parser("import", help="onboard a repo URL, youtube/web link, or folder")
    pi.add_argument("source", help="git URL, youtube/web link, or path to a folder")
    pi.add_argument("--category", help="force category")
    pi.add_argument("--name", help="destination folder name (repos/folders)")
    pi.add_argument("--title", help="title for a saved link reference")

    pm = sub.add_parser("move", help="re-file a project and learn the override")
    pm.add_argument("project")
    pm.add_argument("category")

    pa = sub.add_parser("add-category", help="extend the taxonomy")
    pa.add_argument("name")
    pa.add_argument("label")
    pa.add_argument("keywords", nargs="*")

    prc = sub.add_parser("rename-category",
                         help="rename a category (key + folder + refs)")
    prc.add_argument("old")
    prc.add_argument("new")

    pdc = sub.add_parser("delete-category",
                         help="delete a category (refuses if non-empty unless --into is given)")
    pdc.add_argument("name")
    pdc.add_argument("--into", help="migrate any projects/refs to this category first")

    pec = sub.add_parser("edit-category", help="edit a category's label/blurb/keywords")
    pec.add_argument("name")
    pec.add_argument("--label", help="new label")
    pec.add_argument("--blurb", help="new blurb")
    pec.add_argument("--add-keyword", action="append", dest="add_keyword",
                     help="add a keyword (repeatable)")
    pec.add_argument("--rm-keyword", action="append", dest="rm_keyword",
                     help="remove a keyword (repeatable)")

    pmm = sub.add_parser("move-many", help="bulk move all projects from one category to another")
    pmm.add_argument("from_category", metavar="from-category")
    pmm.add_argument("to_category", metavar="to-category")

    pl = sub.add_parser("set-link", help="set deployed/dev URLs for a project")
    pl.add_argument("project")
    pl.add_argument("--deployed", help="deployed app URL (or '' to blank it)")
    pl.add_argument("--dev", help="local dev URL, e.g. http://localhost:5173")
    pl.add_argument("--dev-cmd", dest="dev_cmd",
                    help="command the Local dev button runs, e.g. 'bun run dev' "
                         "(or '' to clear and re-enable auto-detection)")
    pl.add_argument("--clear", action="store_true", help="remove all overrides")

    pt = sub.add_parser("tag", help="add user tags to a project or reference")
    pt.add_argument("target", help="project name or reference id/title-substring")
    pt.add_argument("tags", nargs="+", help="one or more tag strings")
    pun = sub.add_parser("untag", help="remove tags from a project or reference")
    pun.add_argument("target")
    pun.add_argument("tags", nargs="+")
    sub.add_parser("tags", help="list all user tags with counts")

    prt = sub.add_parser("rename-tag", help="rename a tag everywhere (projects + refs)")
    prt.add_argument("old")
    prt.add_argument("new")
    pdt = sub.add_parser("delete-tag", help="delete a tag from every project and reference")
    pdt.add_argument("tag")
    ptm = sub.add_parser("tag-many",
                         help="bulk tag projects matching a category name or glob")
    ptm.add_argument("selector", help="category name (e.g. 'web-apps') or fnmatch glob (e.g. 'mcp-*')")
    ptm.add_argument("tags", nargs="+")

    pr = sub.add_parser("relate", help="create a relation link between two items (projects/refs)")
    pr.add_argument("a", help="project name or reference id/title-substring")
    pr.add_argument("b", help="project name or reference id/title-substring")
    pur = sub.add_parser("unrelate", help="remove a relation between two items")
    pur.add_argument("a"); pur.add_argument("b")
    sub.add_parser("relations", help="list all relation links")

    pat = sub.add_parser("attach", help="link a reference to a project (Related links)")
    pat.add_argument("ref", help="reference id / title-substring / url-substring")
    pat.add_argument("project", help="target project name")
    pdt = sub.add_parser("detach", help="remove a reference's project attachment")
    pdt.add_argument("ref")

    sub.add_parser("refs", help="list saved links / references")
    pu = sub.add_parser("unref", help="remove a reference by id/title/url substring")
    pu.add_argument("query")

    pre = sub.add_parser("ref-edit",
                         help="edit a reference's title and/or category (also moves the .webloc)")
    pre.add_argument("query", help="reference id, title-substring, or url-substring")
    pre.add_argument("--title", help="new title")
    pre.add_argument("--category", help="new category")

    prn = sub.add_parser("rename", help="rename a project folder (updates overrides/tags/notes/refs/relations)")
    prn.add_argument("project")
    prn.add_argument("new_name", metavar="new-name")
    par = sub.add_parser("archive", help="archive a project (dimmed on dashboard, kept on disk)")
    par.add_argument("project")
    pua = sub.add_parser("unarchive", help="unarchive a project")
    pua.add_argument("project")
    pno = sub.add_parser("note", help="set or clear a free-text note on a project")
    pno.add_argument("project")
    pno.add_argument("text", nargs="?", default="",
                     help="note text (omit or pass '' to clear)")
    punn = sub.add_parser("unnote", help="clear a project's note")
    punn.add_argument("project")

    pp = sub.add_parser("ports", help="assign/list devhub-managed dev ports")
    pp.add_argument("--reassign", nargs=2, metavar=("PROJECT", "PORT"),
                    help="force PROJECT's dev_port to PORT")

    pdev = sub.add_parser("dev",
                          help="start a project's dev server on its assigned port")
    pdev.add_argument("project")
    pdev.add_argument("--dry-run", action="store_true",
                      help="print the URL and command without launching")

    pa = sub.add_parser("announce", help="tell the helper a dev server is up")
    pa.add_argument("--project", required=True)
    pa.add_argument("--port", required=True, type=int)
    pa.add_argument("--helper-port", dest="helper_port", type=int)

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return
    result = {
        "scan": cmd_scan, "index": cmd_index, "doctor": cmd_doctor,
        "build": cmd_build, "git": cmd_git,
        "classify": cmd_classify, "import": cmd_import, "move": cmd_move,
        "add-category": cmd_add_category,
        "rename-category": cmd_rename_category,
        "delete-category": cmd_delete_category,
        "edit-category": cmd_edit_category,
        "move-many": cmd_move_many,
        "set-link": cmd_set_link,
        "serve": cmd_serve, "install-agent": cmd_install_agent,
        "uninstall-agent": cmd_uninstall_agent,
        "tag": cmd_tag, "untag": cmd_untag, "tags": cmd_tags,
        "rename-tag": cmd_rename_tag, "delete-tag": cmd_delete_tag,
        "tag-many": cmd_tag_many,
        "attach": cmd_attach, "detach": cmd_detach,
        "relate": cmd_relate, "unrelate": cmd_unrelate, "relations": cmd_relations,
        "refs": cmd_refs, "unref": cmd_unref, "ref-edit": cmd_ref_edit,
        "rename": cmd_rename_project, "archive": cmd_archive, "unarchive": cmd_unarchive,
        "note": cmd_note, "unnote": cmd_unnote,
        "ports": cmd_ports, "dev": cmd_dev,
        "announce": cmd_announce,
        "gallery": cmd_gallery,
    }[args.cmd](args)
    if isinstance(result, int) and result:
        raise SystemExit(result)


if __name__ == "__main__":
    main()
