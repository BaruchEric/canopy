# Task 7 report: the capacity chip

- Red: `bun test ui/src/capacity.test.ts` failed before the pure UI module existed (`Cannot find module './capacity'`). The expired-hit regression then failed as intended: expected `no reading`, received `limit`.
- Green: `bun test ui/src/capacity.test.ts` passed with 4 tests and 25 expectations after expired hits were removed from the displayed row state.
- Store race red/green: `bun test ui/src/store.test.ts -t capacity` failed when the event counter was disabled: the older pending read replaced the newer `0.8` reading with `0.1`. It passed after restoring the per-backend event counter. The 404 case leaves the older backend out of the capacity map.
- Focused verification: `bun test ui/src/capacity.test.ts ui/src/api.test.ts ui/src/store.test.ts` passed (165 tests, 647 expectations); `bun run typecheck` and `bun run lint` passed; `git diff --check` passed.
- Startup fixture: `ui/src/store.test.ts` now expects `/api/capacity` among the initial home-backend requests.
- Changed: `ui/src/capacity.ts`, `ui/src/capacity.test.ts`, `ui/src/components/Capacity.tsx`, `ui/src/store.ts`, `ui/src/store.test.ts`, `ui/src/api.ts`, `ui/src/components/TopBar.tsx`, and `ui/src/styles.css`. The CSS also adds `.st-limited { --tone: var(--lichen); }` for the limited-run chip.
- Commit: `feat(capacity): a top-bar chip shows each backend's usage windows and their resets (FR-028)`.
- Concerns: the full test suite and build remain for the coordinator after integration. No live backend or credentials were accessed.
