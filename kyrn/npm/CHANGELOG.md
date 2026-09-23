# Changelog

## [0.1.1] - 2026-09-22

### Added

- `judge/manifest.json`, the description of every decision and feature the desktop app draws its settings from, so the app can run an mu that came from npm.
- The settings texts in eleven more languages (zh-TW, ja-JP, ko-KR, de-DE, fr-FR, es-ES, pt-BR, ru-RU, uk-UA, tr-TR, fa-IR).
- `mu auth status | login <provider> | logout <provider>`: the subscription sign-in (ChatGPT, Claude, Grok, and Google while `googleLogin` is on) as JSON lines, which the desktop app runs, also with the copy of mu it carries inside it.

### Fixed

- `mu doctor` no longer reports a login on a fresh install, where pi has only written an empty auth.json.

## [0.1.0] - 2026-09-22

### Added

- First npm release of mu: `npm i -g mu-agent`, then `mu`.
- The judgment layer (29 decision points in 32 features) on pi 0.86, in shadow mode by default.
- `mu doctor`, `mu ledger`, `mu judge` (the local judge Laya, macOS on Apple Silicon) and `mu migrate`.
