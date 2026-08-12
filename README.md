# Salty Bet Bot

Salty Bet Bot is a private, unpacked Chrome extension that analyzes SaltyBet matches, displays the original strategy's recommendations, records completed matches, and provides chart and records viewers.

This branch restores the 2021 extension on Manifest V3. It preserves the existing betting formulas and bundled 458,292-match baseline while replacing the obsolete persistent background page with a restart-safe service worker.

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

## Records and backups

The bundled 458,292-match history is immutable and cannot be deleted from the UI. Newly collected and imported records are stored separately in IndexedDB as personal records.

Popup actions:

- **Import** accepts legacy JSON exports and adds only records that are not duplicates of bundled or existing personal history.
- **Export personal records** creates a compact backup of imports and newly collected history.
- **Export all records** combines bundled and personal history in chronological order.
- **Clear personal records** removes only personal history; the bundled baseline remains available.

Back up personal records before replacing the repository directory or Chrome profile.

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

The restoration does not retrain or alter the original formulas and constants. Matchmaking intentionally favors selected upset opportunities and scales wager size with balance and confidence. Tournaments use their separate balance, while exhibitions retain the original nominal recommendation. Recommendations are not a guarantee of virtual-salt gains.
