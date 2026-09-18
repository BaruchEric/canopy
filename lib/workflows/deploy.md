---
name: deploy
label: deploy
verb: deploy
blurb: Claude works out how this project deploys (Vercel, Firebase, Cloudflare, a Dockerfile, a script...), runs the project's own gates first, and deploys. Uncommitted changes and anything outside the usual pipeline come back to you as a question.
when: any
note: target, environment, or anything else Claude should know (optional)
---

## Deploy
tools: git-read, bun, Bash(npm run:*), Bash(cat:*), Bash(ls:*)
turns: 80

Task: deploy this project to where it normally deploys.
1. Find out how it deploys: vercel.json or .vercel, firebase.json, wrangler.toml, fly.toml, a Dockerfile or compose file, deploy scripts in package.json, a Makefile, and anything CLAUDE.md or README says about deploying. If nothing indicates a deploy target, say so and stop.
2. If there are uncommitted changes, ask with AskUserQuestion whether to commit them first, deploy as-is, or stop.
3. Run the project's own gates before deploying (typecheck, lint, tests, build, in whatever form the project defines them). Stop and report if one fails; do not deploy a failing build.
4. Deploy. Prefer the project's own script over a raw CLI call when both exist.
5. Report the deployment URL and anything you noticed.
