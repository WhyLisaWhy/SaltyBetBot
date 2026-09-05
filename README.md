# Salty Bet Bot

Salty Bet Bot is a personal-use, unpacked Chrome extension for SaltyBet. It analyzes matches, displays the original strategy's recommendations, records completed matches, and provides chart and records viewers.

The project runs on Manifest V3 with a restart-safe service worker. It preserves the existing betting formulas and bundled 458,292-match baseline while adding safer controls for automation, match selection, personal records, and backups.

## Features

- Observe-only mode is the default; automatic virtual betting must be enabled explicitly.
- A designated SaltyBet controller tab is the only tab allowed to place a wager. Other open SaltyBet tabs remain on standby until selected.
- Matchmaking's maximum bet is adjustable from the popup, with a default of 32,000 and an allowed range of 1 through 1,000,000.
- Matchmaking, tournament, and exhibition recommendations retain their separate behaviors.
- Match tracking continues through Twitch chat-container replacement, incremental chat rendering, background tabs, and service-worker restarts.
- Personal records support deduplicated import, personal/all-record export, clearing without touching the bundled baseline, and chart/records views. The popup shows progress and recoverable errors in a responsive layout.
- Personal-record backups are refreshed locally and published only after validation; empty, malformed, out-of-order, or regressed data is rejected.

## Safety default

The extension always installs in **Observe only** mode. In this mode it may calculate predictions and collect records, but it cannot click a betting button.

Automatic betting requires both of these conditions:

1. The persistent **Enable automatic betting** setting is explicitly turned on and confirmed in the popup.
2. The SaltyBet tab is the designated controller tab.

Do not enable automation until several complete live match cycles have produced sensible predictions and new personal records without errors.

## Build

Requirements:

- Node.js 22.22.3 (pinned in `.nvmrc`)
- Rust 1.97.1 (pinned in `rust-toolchain.toml`)
- `wasm-pack` 0.15.0

One-time setup:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
npm ci
```

Create the unpacked extension:

```sh
npm run build
```

The only directory Chrome should load is:

```text
dist/extension
```

The build verifies and compresses the seven immutable baseline chunks. The resulting extension is about 27 MB instead of the roughly 260 MB source history.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's `dist/extension` directory.
5. Open SaltyBet and confirm the blue **Observe only — no bets will be placed** status appears.

Chrome assigns an extension ID when the directory is loaded. Rebuilding in place and choosing **Reload** on the extension card preserves local settings and personal records.

## Observe-only validation

Before enabling automation, watch several complete matchmaking cycles and verify:

- The overlay changes from loading to **Observe only**.
- Open, locked, winner, and mode-switch chat messages are recognized.
- Recommendations appear for the fighters shown on SaltyBet.
- The popup's **Matchmaking maximum** defaults to 32,000 and persists after reopening.
- No betting button is clicked and the wager is not submitted.
- The records page gains one personal record per eligible completed match, without duplicates.
- The extension keeps tracking when the SaltyBet tab is in the background.
- Twitch chat continues to be recognized when its container is replaced or a message is rendered incrementally.
- Closing and reopening Chrome preserves personal records and the automation setting.

If multiple SaltyBet tabs are open, the first valid tab becomes the controller and the others show **Standby**. Open the extension popup from the tab you want and choose **Use this SaltyBet tab** to transfer control. The extension never closes user tabs.

## Enable or disable automation

1. Open the extension popup while the intended SaltyBet tab is active.
2. Choose **Use this SaltyBet tab**.
3. Turn on **Enable automatic betting**.
4. Read and accept the confirmation prompt.

The change takes effect on the next complete eligible match; it will not place a late wager on a match already processed in observe mode.

Turn the switch off at any time to return immediately to observe-only operation. The setting persists across Chrome restarts.

## Adjust the matchmaking maximum

1. Open the extension popup.
2. Enter a whole-number maximum from **1** through **1,000,000**.
3. Choose **Save maximum**.

The saved maximum replaces the old fixed maximum in the matchmaking confidence calculation and remains the final cap after the existing match-history and balance scaling. It takes effect with the next new matchmaking match, so changing it during an open match does not alter that match's recommendation. The existing mine all-in behavior at or below 4,100 remains unchanged. This control does not change tournament wagers, exhibition `$1` recommendations, or `$1` tie fallbacks.

## Records and backups

The bundled 458,292-match history is immutable and cannot be deleted from the UI. Newly collected and imported records are stored separately in IndexedDB as personal records.

Popup actions:

- **Import** accepts legacy JSON exports and adds only records that are not duplicates of bundled or existing personal history.
- **Export personal records** creates a compact backup of imports and newly collected history.
- **Export all records** combines bundled and personal history in chronological order.
- **Clear personal records** removes only personal history; the bundled baseline remains available.

Keep the popup open while a record operation is running. Record actions are disabled during the operation, but the automation switch remains available. Invalid imports and canceled or failed export requests show an inline message and let you retry. A successful export request means the download has started; check Chrome downloads for completion.

The service worker also refreshes `Downloads/SaltyBetBot Backups/personal-records-latest.json` every 30 minutes while Chrome is running. It never replaces the last good export with an empty or regressed database.

A scheduled collector validates that export every 15 minutes and publishes the latest copy and metadata under [`community-records`](community-records/). Invalid, out-of-order, regressed, or historically incomplete exports are rejected before Git is changed. A watchdog alerts after two consecutive failures or 45 minutes without a successful backup, including a stale protected `master` branch. Publication lag and GitHub availability are tracked independently of successful or unchanged exports, so retries cannot hide a stalled publication. These files are public and include only the collector's match-history, virtual wager, and balance fields; they do not contain browser credentials or login data.

Back up personal records before replacing the repository directory or Chrome profile. The automated copy protects the scheduled installation, but other installations should configure their own off-device destination.

## Update

1. Export personal records as a precaution.
2. Pull or apply the new source changes.
3. Run `npm ci` if dependencies changed.
4. Run `npm run build`.
5. Open `chrome://extensions` and choose **Reload** on Salty Bet Bot.
6. Reload open SaltyBet tabs and confirm the expected mode badge.

Never load the repository root or the old `static` source directory. `dist/extension` is the reproducible install target.

## Tests

```sh
npm test
npm run test:parser
npm run build
node scripts/verify-build.mjs
npm run test:browser
```

The Rust tests include the algorithm and shared API crates. The focused popup workflow checks cover invalid-import recovery, deduplication, personal/all-record export, download failure recovery, clear/cancel, settings retry, navigation, and responsive layouts at 360px and 200% text size.

The browser harness launches a clean Chromium profile with mocked SaltyBet and Twitch pages, confirms current WAIFU4u parsing, renders the popup, chart, and records pages, and asserts that observe-only mode performs zero betting-button clicks. Install its browser once with:

```sh
npx playwright install chromium
```

## Troubleshooting

- **Extension will not load:** confirm Chrome is pointed at `dist/extension`, then inspect the extension card for a manifest or service-worker error.
- **Status remains Loading history:** open the SaltyBet tab console and check for a missing record chunk, decompression, WASM, or memory error.
- **Chat stale:** the Twitch observer watches the stable document body and survives chat-container replacement, reconnects, and incremental message rendering. If the service worker still reports a prolonged missing heartbeat, it reloads only the controller SaltyBet tab; it never closes the tab.
- **Standby:** another valid SaltyBet tab owns control. Transfer it from the popup.
- **No recommendations:** verify the Twitch chat iframe is visible and WAIFU4u is posting match events; then reload the controller tab.
- **Records do not appear:** keep automation off, complete a full matchmaking cycle, and inspect the service worker under `chrome://extensions`.
- **Unexpected behavior:** disable automation first, export personal records, then capture the SaltyBet console and extension service-worker errors.

## Strategy notes

The project does not retrain or alter the original formulas and constants. Matchmaking intentionally favors selected upset opportunities and scales wager size with balance and confidence; its default maximum is 32,000 and the popup can set a different maximum without removing those scaling rules. Tournaments use their separate balance, while exhibitions retain the original nominal recommendation. Recommendations are not a guarantee of virtual-salt gains.
