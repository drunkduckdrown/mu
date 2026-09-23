# Changelog

## [0.1.3] - 2026-09-23

### Added

- The plain-language board keeps a running account: one plain line per step the moment it ends (a file changed, a check passed or failed, a command run; reading folded into one line that counts up), what the agent says retold by the board's model as soon as Jev calls it news, and the summing up as the account's last line. New presentation event `board.note`; `board.update` carries the last 40 lines as `log`, so a reopened session has its account; `/board` lists it.

### Fixed

- `judge/manifest.json` carries the settings texts in all eleven extra languages again (0.1.2 was packed from a checkout without the translations), and every text of the newer decision points and options is translated.
- The judge is spelled Jev everywhere.

## [0.1.2] - 2026-09-23

0.1.1 was prepared on 2026-09-22 but never published; its changes are in this release.

### Added

- `mu import --list` finds your Claude Code and Codex conversations, `mu import <file>...` brings them into mu as sessions to continue; `/import-chat` does the same inside a session. Thinking and images are not imported; a transcript is never imported twice.
- `judge/manifest.json`, the description of every decision and feature the desktop app draws its settings from, so the app can run an mu that came from npm.
- The settings texts in eleven more languages (zh-TW, ja-JP, ko-KR, de-DE, fr-FR, es-ES, pt-BR, ru-RU, uk-UA, tr-TR, fa-IR).
- `mu auth status | login <provider> | logout <provider>`: the subscription sign-in (ChatGPT, Claude, Grok, and Google while `googleLogin` is on) as JSON lines, which the desktop app runs, also with the copy of mu it carries inside it.

### Fixed

- `mu doctor` no longer reports a login on a fresh install, where pi has only written an empty auth.json.
- mu started by the desktop app's Electron no longer hands `ELECTRON_RUN_AS_NODE` to the programs it starts.

## [0.1.0] - 2026-09-22

### Added

- First npm release of mu: `npm i -g mu-agent`, then `mu`.
- The judgment layer (29 decision points in 32 features) on pi 0.86, in shadow mode by default.
- `mu doctor`, `mu ledger`, `mu judge` (the local judge Laya, macOS on Apple Silicon) and `mu migrate`.
