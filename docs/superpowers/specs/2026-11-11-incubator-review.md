# Incubator review, 2026-11-11

A review of the incubator's whole path, intake to retro, on the day three new projects in a row failed or stuck. It lists what broke, what the same commit fixed, the five P1s fixed later that day, and what is still open. FR-062 tracks the open list.

## How it was done

One pass read the orchestrator and the live backends by hand. Three more read the page and the CLI, the six stage workflows, and the isolation and state code. Findings marked "reproduced" have a test or a live record behind them. The rest come from reading the code at the file and line given, and nobody has run them. Check each one before fixing it.

## What broke that day

1. **Every claude stage on the mini.** The stages' `/login` lapsed on 2026-11-01. A `/login` ends about 30 days after it is made, used or not, and claude then empties both tokens in `.credentials.json`. Nothing said so for ten days. The first project to reach clarify parked on "Failed to authenticate: OAuth session expired and could not be refreshed". Reproduced on the mini.
2. **A GitHub file url as the repo.** `https://github.com/<owner>/<repo>/blob/main/TUTORIAL.md` went to `git clone`, which answered "repository not found". Reproduced from the day's vault note.
3. **A project started on the Mac.** The Mac's server has no stage runner and no `CANOPY_INCUBATOR_UNISOLATED=1`. It took the project in and kept it queued for good, with nothing on the page saying why. Reproduced: `sp_4ba1a31be656` is still queued there.

## Fixed in the same commit

- The stage runner's hello says the state of the stages' claude login (`src/stage/logincheck.ts`), never a token. Health has two new checks, "stages' claude login" and "coordinator's claude login", which go down on the day a login lapses and say what to do.
- A dead login holds the queue the way a runner away does. Queued projects wait with the reason on the card, the sheet and the bar, spend no run, and start on their own at the first hello that says the login is back.
- A stage's claude can sign in with a `claude setup-token` token kept as `oauth-token.txt` in the runner's claude folder on the host. It lasts a year, and saving it needs no redeploy. compose still names no secret for stages.
- A stage park whose error is claude's own words for a refused login carries the fix after the error.
- A GitHub file, folder, issue or raw url given as the repo clones the repo it sits in and stays a link. A project parked on the old behaviour clones the right repo on a retry.
- A project with a repo and no text is titled `owner/name`, not the url's last path part.
- `POST /api/incubator` answers 409 on a backend with nowhere to run a stage. The new-project sheet says so and disables the button, and `canopy new` prints the same words.
- The sheet shows an action's error under the stage strip, where the button is, and a rejected project's reason.
- A flow that gates again on the step it was resumed from parks the project again. Before, the project read "clarifying" with no reason while its flow sat at a gate. Reproduced with a test.
- docs/deploy.md no longer tells the coordinator to live on a copy of the stages' login, which lapses with its source. The coordinator's own login lapses on 2026-12-01.

## Fixed later the same day: the five P1s

P1 meant it can lose work or ship the wrong thing. Each fix has a test that fails on the code before it.

- **A crash during prepare no longer strands a voice memo.** The record is saved after each transcript, so a restart finds the memo done. A transcript file left under a number no entry holds is written over, where the exclusive write used to fail every later try (`addEntry` in `src/core/incubator.ts`).
- **Accept's "no" reaches the builder with its reasons.** The sentence the builder gets now ends with the Accept step's own closing words, and the builder step of `build-new.md`, `renovate.md` and `extend.md` is told to keep what is built and read `.canopy/accept.md` first.
- **"Retry" at a judge's park goes back to the builder.** A park at a gate that refused the work names the step a retry returns to (`Flow.backTo`), and the retry goes there with the reason, past the step's retry count. "Continue" still passes the gate, since overriding the judge is the user's call. The buttons now say what each does: "send it back to Scaffold" comes first, and going on reads "deploy it anyway", or "hand it off anyway" for an extend (`gateWords` in `ui/src/flows.ts`, `parkWords` in `ui/src/sprouts.ts`).
- **A ship cut short makes no second repo or project.** The name goes on the project's record before GitHub or Vercel is asked for it (`Sprout.shipAsked`). The next try takes up a repo under that name that is private and empty, or a Vercel project nothing was deployed to. The tests run against fakes, and a probe ran the real shipper against GitHub and Vercel on the mini that evening, with the login and the token a ship uses. A repo and a project made under a random name and then asked for again were taken up, with no second name asked for. `GET /v6/deployments?projectId=` answered an empty `deployments` list for the new project and one entry for a live one. Asked for a name that is in use (the bill splitter's), with every write refused inside the probe, the shipper went on to the next name both times. The probe's project and repo were deleted. It ran no push and no deploy.
- **A failed run parks its step.** On a seed, a run that ends in an error leaves the flow waiting at that step. A resume runs that step again, on its Claude session when it has one, and the steps before it stand. The park names the step, the error and what a resume does.

Two things follow from the last one. A project parked this way keeps its slot until someone resumes or stops it, as one parked at a gate does, so two of them hold the whole queue. And a server rolled back past this commit skips such a flow at restore with a log line, so that project's stage starts over on resume, as every failed run did before.

The first live park after the deploy, a scout the judge was not sure of on the mini, showed two more things, fixed the same evening. A park kept by the engine from before the fix came back with no `backTo`, so its button read "retry this step" while the retry went back to Research; `restore` now reads it again. And going on past scout's last step read "accept and finish anyway", which sounds like the end of the project; it now reads "build it anyway", since canopy takes the pick and queues the build.

## Still open

P2 misleads or strands a project. P3 is polish.

### Intake

- **P2. The CLI turns a mistyped flag into the idea.** An unknown `--flag` becomes idea text, a lone url is never offered as `--repo`, and a url with a token in the idea text reaches the title, the slug, the brief and the vault note (`parseNewArgs` in `src/cli`).
- **P2. The sheet drops a typed idea.** Escape or a click on the backdrop closes a dirty intake form, and cancel during an upload does not abort the request (`ui/src/components/IncubatorSheets.tsx`).
- **P2. A slow or failed stages read for another backend is silent.** The page asks each backend once and never again, so the new-project sheet can show "stages unknown" until a reload (`ui/src/store.ts:4444-4451`).
- **P2. The intake clone has no time limit in its words and pulls LFS files.** It also keeps the upstream's notes refs (`src/core/seed.ts:235-257`).
- **P3. `canopy new` uploads before it asks.** It learns of the 409 only after sending every file. It could read `/api/incubator/stages` first.
- **P3. `canopy new` prints a link built from the API origin**, which is loopback inside a canopy shell.

### Clarify

- **P2. Clarify's check passes on stale output.** A `questions.json` left from an earlier pass, or none at all with no `intent.md`, still passes.

### Scout

- **P2. The workspace snapshot reads a retired file.** `src/core/stageshare.ts:64` reads `<root>/_devhub/manifest.json`. devhub was retired on 2026-09-12 and canopy's library keeps its own manifest, so scout sees a workspace that stopped changing two months ago.
- **P2. `@pick-check` runs before the flow ends**, so a refusal that depends on the host, the target or the license comes after the judge already passed the pick.
- **P2. Input added during scout or build voids the pick and lets the flow run on.**

### Build

- **P2. Extend's Baseline runs every gate under the 10-minute check cap, with no retries.**
- **P2. Nothing bounds a stage run that waits on a prompt**, and the job ground rules in `actions.ts:60-62` contradict what the stage prompts ask for.

### Retro

- **P2. A capacity wait fails a retro for good**, and a park retro's commit moves the seed past `builtHead`, which then reads as "the seed moved".
- **P3. Retro lessons are read and answered on the home backend only.**

### Parks and resume

- **P2. A failed run's park still carries the harness's raw words.** It now says which step failed and what a resume does, and a login refusal carries its fix. Every other error reads as the harness wrote it.
- **P2. A check out of retries parks with "check failed with exit N"** and none of its output. A retry by hand now sends the output back to the builder, but the park's own line still shows none.
- **P2. "Stop" means two things.** On a gate's inbox item it stops the flow. On the sheet it ends the project.
- **P2. `POST /api/incubator/answer` can hang for up to two hours** inside `inQuietSeed` while the seed is busy.
- **P3. Every park appends a daily line**, even one equal to the last, and a failed vault write is never tried again.
- **P3. The inbox does not say why a queued project waits.** The card and the sheet now do.

### Isolation and state

- **P2. The login check reads the file, not Anthropic.** A token revoked at claude.ai reads "signed in with a token", and a copied login can be stale. A stage that meets one parks with the fix. A daily one-turn probe would catch it first.
- **P2. `canopy:stages` stays unknown when the runner was down from the start**, and a runner that reports no harness reads ready.
- **P2. `VaultNotes.put` overwrites on any 409** (`src/core/vault.ts:96-99`). Two backends that pick the same slug write over each other's note.
- **P3. A server that does not own the incubator answers `/api/incubator/stages` as if it did.**
- **P3. Nothing sweeps leftovers:** `.canopy-making`, `.shared/.tmp-*`, `.shared/{inputs,workspace,record}/<id>`, `.canopy-mirrors/<slug>`, `incubator/.dismissed/<id>`.

### The CLI as a whole

- **P2. The CLI can start a project and little else.** It cannot answer or skip questions, resume, stop, dismiss, add input or hand off, and `canopy incubator show` leaves out the questions and the reason a project waits.

## What to do first

With the P1s fixed, the stale `_devhub` manifest comes first, because scout reads it on every project.
