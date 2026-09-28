# Changelog

All notable changes to Vorsum are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.7] - 2026-09-22
### Changed
- The changelog now follows the Keep a Changelog format (readable Markdown with dated, grouped sections).

## [1.1.6] - 2026-09-22
### Changed
- The in-app changelog is now read from CHANGELOG.md.

## [1.1.5] - 2026-09-22
### Changed
- The Σ button now shows a bold Σ while a summary is open (instead of "∑ - Hide summary"), on pages, watch pages, and embeds, and in History.
### Fixed
- The floating dot is now kept fully on-screen when dragged (and after a window resize).

## [1.1.4] - 2026-09-21
### Added
- A Change log button in Options.
### Changed
- Widened the Data & Privacy popup.
### Fixed
- The "Show transcript download T" option now toggles live without a page reload.

## [1.1.3] - 2026-09-21
### Changed
- Compacted the History row buttons to ∑ / X.
### Fixed
- History entries sometimes saved the video ID instead of the title on modern card layouts.

## [1.1.2] - 2026-09-20
### Fixed
- Summaries are now only saved in local IndexedDB, and deleting any/all History entries now clears the respective "Saved" status.

## [1.1.1] - 2026-09-20
<!-- highlight -->
### Added
- An interrupted-summary resume queue, so closing a tab mid-request no longer loses the summary.
- Web Locks job ownership (with a staleness fallback) to prevent duplicate work across tabs.
- A cross-tab/embed debug log cache with tab/context tags in the Debug panel, Copy log, and bug reports.
### Changed
- The floating dot and the onboarding dot preview are now light/dark theme-reactive.
### Fixed
- The Options/History panel scrollbar, so content scrolls inside the panel only when needed.

## [1.1.0] - 2026-09-19
<!-- highlight -->
### Added
- Expanded onboarding from 3 to 7 slides (welcome, URL mode, Caption mode, recap, privacy, API setup, how-to).
- Progress dots, responsive horizontal mode diagrams, faux video thumbnails, Gemini/LLM icons, and inline ∑ chips.
- A light/dark toggle on the first slide.
- An "N new" badge on the minimized dot; a single new summary auto-opens the newest History entry.
- The userscript @icon.
- Hover/press animation on the dot.
- Embed support: a compact ∑ button on embedded players (Options toggle, on by default).
### Changed
- Moved slide buttons to a fixed footer and added a smooth slide/fade transition.
- The floating UI now starts minimized (dot) by default.
- Hid the dot in fullscreen.
- Restructured the prompt: shared base plus mode-specific additions, with a CAPTION_UNUSABLE sentinel that triggers the URL fall-back.
- Onboarding "I know what I'm doing" now embeds the API Configuration form inline; the custom prompt field is prefilled with an editable copy of the default.
### Fixed
- Dark-mode accent colors on the onboarding slides.

## [1.0.9] - 2026-09-18
<!-- highlight -->
### Added
- A "Set up bug report" tool with auto-filled environment details, a prefilled GitHub issue, copy-to-clipboard, and anonymous submission via Web3Forms.
- Automatic Caption fall-back when URL mode is rejected with HTTP 403, with a clear message when a Gemini key is required.
### Changed
- Compacted the History Export/Clear buttons onto one row.
- Options: grouped the mode slider and URL fall-back into a "Summary mode" panel; moved the drag handle to a bottom grip; widened the panel to 400px with full-width History summaries.
- Options reorg: a "Summary Configuration" accordion open by default; cache/Stats & Data/FAQ/Data & Privacy moved to the bottom; default summary text size 14px; accordion ARIA states; trimmed API Configuration copy.
- Simplified Developer Contact (mailto email + GitHub link) and relabeled the debug toggle to "Show/Hide debug log".
### Fixed
- Watch-page title extraction no longer picks up a sidebar video's title.
- Repaired Caption mode: added the token-free Android InnerTube caption path and timedtext format-3 parsing after YouTube began returning HTTP 400 to get_transcript.

## [1.0.8] - 2026-09-17
### Changed
- Renamed the shipped file to Vorsum.user.js and updated every reference.
- Switched @updateURL/@downloadURL (and the README install link) to the GitHub raw URL; the in-panel update banner now opens the raw install URL.
- Added a release note clarifying that the version lives only in the @version line.

[Unreleased]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.7...HEAD
[1.1.7]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/PipettingBeaver/Vorsum/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/PipettingBeaver/Vorsum/compare/v1.0.9...v1.1.0
[1.0.9]: https://github.com/PipettingBeaver/Vorsum/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/PipettingBeaver/Vorsum/compare/v1.0.7...v1.0.8
