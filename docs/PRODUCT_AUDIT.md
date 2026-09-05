# Product audit — 2026-09-05

Base: `cc4c38b`, isolated branch `codex/product-audit-2026-09-05`.
Local implementation only. No production access, betting, publication, or changes to personal records.

## Coverage and baseline

Reviewed the MV3 entry points, popup controls and Rust record workflows, shared API, service-worker settings/persistence/controller code, browser harness, build/verification scripts, CI and backup publication/watchdog boundaries. Delegated independent persistence and engineering reviews. This is a targeted first-party audit; legacy strategy internals and every chart/records interaction are not exhaustively reviewed.

Baseline and final verification both passed; results are recorded below. Browser checks use a fresh disposable profile, mocked SaltyBet/Twitch pages and synthetic personal records. Baseline popup screenshots are in `output/playwright/before/`.

## Selected changes and acceptance plan

1. **P1: Settings lost updates.** `extension/service-worker-core.js` reads all settings and rewrites both on a partial update. Concurrent disable/save and startup normalization can restore enabled automation. Serialize setting mutations including initialization. Risk: ordering and failed-write recovery. Acceptance: deterministic regression tests fail before the fix; concurrent changes preserve both values, initialization cannot undo them, failed writes do not block later saves, existing settings/controller tests pass.
2. **P1: Publication freshness monitoring.** Publisher success is refreshed on unchanged exports; watchdog uses this changing timestamp to measure a stalled protected branch/read failure. Track continuous publication incidents independently of publisher success. Risk: persistence, recovery and repeated alerts. Acceptance: fixture tests with repeated successful exports still alert at the existing threshold, recovery resets the incident, subsequent failures have a fresh grace period.
3. **P1/P2: Recoverable, cohesive popup.** `src/popup/src/lib.rs` uses panicking JSON deserialization, hides loading only on success, and ignores download errors. Its global Rust styles also impose a 500px minimum and a full-height records panel under separately styled settings. Keep Rust parsing/deduplication and replace only popup presentation/operation handling. A JS rewrite would duplicate working data semantics; a CSS-only fix would leave recovery broken. Acceptance: invalid JSON and failed download do not trap the UI; retry/import/deduplication/export/clear and navigation remain usable; no duplicate operations; automation stays accessible; no overflow at 360px and larger text; before/after screenshots and browser error assertions.
4. **Verification gap:** include shared API unit tests in the normal Rust test command; add the focused popup workflow browser check to the existing browser command.

No strategy changes, data migrations, new third-party packages, or broad removal of legacy components were made. Generated extension output was rebuilt because it is tracked and is the install target.


## Implemented result

- `extension/service-worker-core.js`: one settings-write queue covers normal saves and startup normalization. Failure recovery keeps subsequent saves usable. Persistent schema and defaults are unchanged.
- `scripts/personal-records-backup-status.mjs` and `scripts/personal-records-backup-watchdog.mjs`: publication incidents persist in `alert.key.incident.json` beside the alert key, separately from publisher-owned state. Successful exports cannot reset their age. Verified recovery resets the incident. Damaged incident JSON/timestamps are repaired without hiding ordinary filesystem errors. Existing schedules and alert thresholds are unchanged.
- `extension/popup.html`, `extension/popup-controls.css`, `extension/popup-controls.js`: one purple operational theme, responsive controls, visible keyboard focus, labels, inline status, Enter-to-save and connection retry. Settings render independently of database health, including a request that never resolves. Save-in-progress flags and refresh revisions prevent stale status from undoing current UI edits.
- `src/popup/src/lib.rs`: one record-operation lifecycle restores controls after failure. Invalid JSON is reported without a WASM panic. Export requests report cancellation/failure and distinguish download start from completion. Record actions disable during work while automation remains accessible. Existing Rust record parsing, duplicate detection, personal/all export and clear confirmation remain.
- `package.json`: normal Rust tests now include the shared API crate. Browser verification includes the focused popup workflows in addition to the existing collector smoke test.

### Safe simplification

Removed popup-only global Rust styles, generated CSS classes, full-screen loading overlays, duplicate export handlers, and the tab-opening bridge. Named CSS styles, a shared operation runner, one export function and native links replace them. Other Rust pages and their loading behavior were preserved. Removed `lazy_static` and `futures-signals` only from the popup's direct dependency list after removing their popup consumers; they remain available to other crates. `serde_json` was already in the workspace lockfile and is now used directly for fallible import parsing. No user-facing actions, record formats, history chunks or strategies were removed.

## Verification evidence

All commands ran from `the isolated audit checkout`.

| Command | Original baseline | Final result |
| --- | --- | --- |
| `npm run verify` | Passed, exit 0 | Passed, exit 0 |
| `npm test` (included in verify) | 29 JS + 7 algorithm tests passed | 39 JS + 7 algorithm + 1 shared API tests passed |
| `npm run test:parser` (included in verify) | 1 WASM parser test passed | 1 WASM parser test passed |
| `npm run build` (included in verify) | Passed | Passed; tracked install output rebuilt |
| `node scripts/verify-build.mjs` (included in verify) | 27.3 MB; 458,292 records verified | 27.2 MB; 458,292 records, chunk checksums, chronology, manifest and WASM outputs verified |
| `npm run test:browser` (included in verify) | Existing collector smoke passed | Collector smoke and focused popup workflows passed |
| `git diff --check` | Clean | Passed |

Regression evidence: new settings race, watchdog freshness/corrupt-state and invalid-import tests failed before their fixes. Follow-up browser regressions reproduced blocked-health initialization before repair. During development the settings/health review also reproduced a controller-refresh/save overlap; the final browser suite verifies it stays disabled until the save finishes.

The collector browser suite verifies observe-only recommendations, incremental/replaced chat, controller transfer, one deduplicated completed personal record, backup start and chart/records rendering. Both fixture SaltyBet tabs recorded **zero betting-button clicks**. The popup suite exercises malformed and empty imports, valid retry, repeat-import deduplication, personal and full-history exports (1 and 458,293 records), a rejected download, clear/cancel, keyboard save/error/retry, failed and indefinitely pending health, failed settings initialization/retry, overlapping claim/save, navigation, and busy controls. It checks no horizontal overflow at 360px and 200% text size. No uncaught errors in the main popup journey.

Pre-existing warnings remain: deprecated Chrono/DOM APIs, unused legacy Rust code/imports, and wasm-pack's fallback for its unavailable prebuilt wasm-bindgen binary. They did not fail baseline or final verification. No separate lint/type-check scripts exist; Rust is compiler checked and JavaScript is exercised by the existing unit/browser suite.

### Visual evidence

- Before: `output/playwright/before/popup-desktop.png`, `output/playwright/before/popup-narrow.png`. The old popup forced at least 500px width and added a large blank area above record actions.
- After: `output/playwright/popup-desktop.png`, `output/playwright/popup-narrow.png`, `output/playwright/popup-large-text.png`. These were opened and visually inspected, alongside the interaction assertions.
- Representative existing consumers: `output/playwright/records.png`, `output/playwright/chart.png`, `output/playwright/observe-only.png`.
- Full logs: `output/audit/baseline.log`, `output/audit/final-verify.log`.

## Deferred risks and coverage limits

- No live SaltyBet/Twitch session, existing Chrome profile, actual toolbar bubble, production VM, scheduler, GitHub publishing or wagering was exercised. Popup testing uses its real extension page in a disposable Chromium profile. Download failure/success for manual popup exports uses a local browser API fixture; actual user save-dialog cancellation and final transfer completion are not claimed.
- Backup service-worker metadata currently records a last-good backup at download start. A separate completion/interruption lifecycle deserves a future change and tests.
- Service-worker and backup input validation is weaker than Rust's complete Record schema; ordinary popup import now uses fallible typed parsing, but other internal message paths warrant contract validation. No existing corrupt records were established or modified.
- Privileged internal messages lack an explicit sender capability policy. This audit did not demonstrate arbitrary website access or an exploit; hardening should cover all trusted extension callers before changing those contracts.
- Records/chart UX remains a follow-up: the records table is dense, exposes long decimal values and small pagination controls, while the chart settings need clearer visible labels and empty-range feedback. Their representative desktop renders were inspected, but they were not redesigned in this batch.
- Some legacy collector DOM parsing uses panics on missing or changing elements. Broader mutation-fixture coverage is warranted. The original strategy internals, every chart/records interaction, and performance characteristics were not exhaustively audited. No runtime speed or strategy-quality improvement is claimed.
- Large imports still use the existing batch insert API and require keeping the popup open. An interrupted operation can be retried with the same file because the existing deduplication semantics are preserved.

## Run or review locally

The implementation was prepared on `codex/product-audit-2026-09-05` in `the isolated audit checkout`. The original `the original checkout` checkout remains on `docs/readme-update` with its pre-existing `.worktrees/` entry untouched.

Run `npm run verify` from the audit checkout. Its `node_modules` currently links to the original checkout's installed dependencies; `npm ci` is the documented independent setup for another copy. The built unpacked extension is `dist/extension` under the audit checkout. Preview that directory with Chrome's Load unpacked in a disposable profile, retaining observe-only mode. Loading a different directory can create a separate extension installation; it does not migrate the existing profile's records. This is an extension, so no web preview server/address was created.

The audit phase performed no release or production-data modification. Release and deployment require a separate authorized step.
