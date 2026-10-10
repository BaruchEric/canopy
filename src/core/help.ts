/**
 * The CLI's usage text, plain. The CLI prints it with the name in bold; the
 * web UI's command line reads its verbs, usage and words from it, so the
 * two never describe different commands. Browser-safe.
 */

export const HELP_TEXT = `canopy — multi-repo git cockpit

usage:
  canopy [dir]                       tree of every repo under dir (default: .)
  canopy status [dir]                only repos that need attention
  canopy ui [dir] [--port N]        start the web UI and open the browser
    --no-open                       start it without opening a browser tab
  canopy helper [--backend URL]     lend this machine's desktop openers to a shared backend
    --name N | --openers a,b        what to register as (default: the hostname, what is installed)
  canopy commit <repo> -m "msg"     commit staged changes
  canopy commit <repo> --ai [--all] [--push]   AI message; --all stages everything
  canopy suggest <repo>              print an AI-suggested commit message
  canopy push <repo>                 push the checked-out branch
  canopy pull <repo>                 fast-forward the checked-out branch
  canopy open <repo> [--app <app>]   open the repo in an app (default: kitty)
    --app kitty|terminal|code|finder|agent|herdr
                                     agent: the repo's agent (claude or codex, as
                                     its shell route says) in a terminal
                                     herdr: the same, in a herdr workspace
  canopy ws                          list workspaces
  canopy ws create <name> <dirs...>  group repos into a workspace
  canopy ws add <name> <dirs...>
  canopy ws rm <name> [dir]          remove a repo, or the whole workspace
  canopy ws open <name> [--app code|kitty|terminal|finder|agent|herdr]
  canopy launch <repo>               builds here, then the repo's releases and open pull requests
  canopy launch <repo> <tag>         install that release for this machine if needed, then launch it
  canopy launch <repo> --pr N        check the pull request out as a worktree, build it, launch it
  canopy launch <repo> --here        build this checkout with its build line, then launch it
  canopy launch <repo> --rm <build>  remove an installed release (release:<tag>) or worktree (pr:N)
  canopy launch <repo> --build "…" | --run "…" | --asset "glob" | --open "…"   set the launch lines
  canopy library [--root dir] <command> [args...]
                                     organize projects, links, tags, health, and dev servers
  canopy source                      list the extra folders the UI scans
  canopy source add <dir> [--host h] [--label l]   scan another folder; --host for one over ssh
  canopy source add --forgejo <url> [--token f]    list a self-hosted Forgejo's repos
  canopy source rm <id>              stop scanning it
  canopy peers status                this machine's name, sync mode, and its peers
  canopy peers init                  set up each peer's git remote in every repo
  canopy peers sync [id]             fetch every peer once, fast-forward, list WIP
  canopy peers take <id> <peer> [branch]    land a peer's WIP here
  canopy peers track <id> <peer> <branch>   a local branch at a peer's tip
  canopy peers seed <id>             copy allowlisted ignored files from a peer
  canopy peers gate --root dir       what a peer key's authorized_keys entry runs
  canopy new "<idea>" [--file f]... [--url u]... [--repo url]
                                     start a project in the incubator; prints its link
  canopy incubator list | show <id>  the incubator's projects, or one project
    --backend URL                    the backend (default: $CANOPY_API, else 127.0.0.1:7850)
  canopy ranger [status]             the always-on agent on a backend, and its wakes
    --backend URL                    the backend (default: $CANOPY_API, else 127.0.0.1:7850)
  canopy ranger on | off | restart | fresh   turn it on or off, restart it, or a fresh conversation
  canopy ranger say "message"        DM it through the backend's tailchan
  canopy ranger wake <when> "prompt" wake it later: in 30m, 14:00, an ISO time
    --cron "0 8 * * *" | --run <id>  on a cron line instead, or when a run ends
  canopy ranger unwake <id>          remove a wake
  canopy spec status [dir]           every repo against the shared repo spec
  canopy spec sync <repo> [--visual | --doc]   write the spec's blocks into a repo
                                     --visual adds DESIGN.md, --doc keeps only SPEC.md
  canopy spec check [repo]           exit 1 unless the repo's spec text is in sync
  canopy version                     the version and the commit this canopy was built from
`;
