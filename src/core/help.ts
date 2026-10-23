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
    --pair [--code CODE]            first get a helper token from the backend (approve it in the inbox)
  canopy auth login [--backend URL] [--code CODE]   sign this CLI in to a backend
  canopy auth logout | status       sign out (revokes this CLI's session) | show mode and who you are
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
  canopy sweep                       idle shells, chats, runs and PRs a backend offers for closing
  canopy sweep --yes [--kind shell,chat,run,pr]   close the ticked ones; a kind named closes all it may (pr only when named, never a draft)
    --backend URL                    the backend (default: $CANOPY_API, else 127.0.0.1:7850)
  canopy awake [off|always|working]  keep the backend's machine from idle sleep: never, always, or while an agent there works
    --backend URL                    the backend (default: $CANOPY_API, else 127.0.0.1:7850)
  canopy health [--bad] [--repo R] [--canopy] [--json]
                                     every check on every backend the home one lists; exit 1 while one is down
    --on NAME                        only that backend (checks, add and rm speak to it too)
    --backend URL                    the home backend, asked alone (default: $CANOPY_API, else 127.0.0.1:7850)
  canopy health show <id>            one check: why, how it heals, its last 20 changes
  canopy health heal <id>            heal one check now (--on NAME when two backends have it)
  canopy health watch [--bad] [--repo R]   follow the checks as they change
  canopy health checks <repo>        a repo's checks as defined, and its file's errors
  canopy health add <repo> <name> --http URL | --port N | --task T | --compose S | --command CMD
                    [--fix CMD] [--heal auto|button|none] [--while TASK] [--every S]
                                     a check in canopy's config; --while runs it only while that task does
  canopy health rm <repo> <name>     take one of canopy's checks away
  canopy kit [status|apply]          the skills every agent has on every machine, and linking them
    --machine M | --dry-run          one machine only; apply says what it would do and changes nothing
  canopy land <run>                  a ready branch run into its repo's landing queue: rebase, gates, fast-forward; never a push
  canopy queue [repo]                every landing queue: queued in order, sent back and why, ready to land
  canopy pr <run> [--draft]          push a ready branch run and open a PR on GitHub in place of landing it
  canopy prs [repo]                  every PR branch runs opened: where it stands, its checks, auto-fix and auto-merge
  canopy secrets [list] [--json]     the secret store's names, tags, rotation dates and sinks; never a value
  canopy secrets status [--json]     this backend's copy: commit, refusals, the key's lock, sink drift; exit 1 on drift
  canopy secrets unlock              unlock this machine's key (asks for its passphrase); its sinks are written then
  canopy secrets pin <key> [--remote URL]   trust the mini's signing key, and where to pull eric/secrets from
  canopy secrets recover <checkout> --breakglass FILE --out DIR
                                     rebuild the mini's keys from the break-glass identity; commits nothing
  canopy health lint [dir]           read a repo's .canopy/health.json, exit 1 on a bad entry
  canopy health init [dir]           write a starter .canopy/health.json
  canopy spec status [dir]           every repo against the shared repo spec
  canopy spec sync <repo> [--visual | --doc]   write the spec's blocks into a repo
                                     --visual adds DESIGN.md, --doc keeps only SPEC.md
  canopy spec check [repo]           exit 1 unless the repo's spec text is in sync
  canopy version                     the version and the commit this canopy was built from

every command except source also takes:
    --token T                        the caller token to send (default: the token file for the backend, else $CANOPY_TOKEN)
`;
