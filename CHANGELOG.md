# Changelog

Newest first. Each release is a level-2 heading `## <version> - <YYYY-MM-DD>`;
a `(highlight)` suffix marks versions worth surfacing once in the in-app
"What's new" banner. Changes are `- ` bullets under the heading. The userscript
fetches and parses this file, so keep the heading/bullet format intact.

## 1.1.6 - 2026-09-22
- The in-app changelog is now read from a readable CHANGELOG.md.

## 1.1.5 - 2026-09-22
- The Σ button now shows a bold Σ while a summary is open (instead of "∑ - Hide summary"), on pages, watch pages, and embeds, and in History.
- The floating dot is now kept fully on-screen when dragged (and after a window resize), and its hover/press scale is a bit more noticeable.

## 1.1.4 - 2026-09-21
- The "Show transcript download T" option now toggles live without a page reload.
- Added a Change log button in Options and widened the Data & Privacy popup.

## 1.1.3 - 2026-09-21
- Fixed History entries sometimes saving the video ID instead of the title on modern card layouts; compacted the History row buttons to ∑ / X.

## 1.1.2 - 2026-09-20
- Summaries are now properly only saved in local IndexedDB, and deleting any/all History entries now clears the respective "Saved" status.

## 1.1.1 - 2026-09-20 (highlight)
- Added an interrupted-summary resume queue so closing a tab mid-request no longer loses the summary.
- Added Web Locks job ownership (with a staleness fallback) to prevent duplicate work across tabs.
- Added a cross-tab/embed debug log cache with tab/context tags in the Debug panel, Copy log, and bug reports.
- The floating dot and the onboarding dot preview are now light/dark theme-reactive.
- Fixed the Options/History panel scrollbar so content scrolls inside the panel only when needed.

## 1.1.0 - 2026-09-19 (highlight)
- Expanded onboarding from 3 to 7 slides (welcome, URL mode, Caption mode, recap, privacy, API setup, how-to).
- Added progress dots, responsive horizontal mode diagrams, faux video thumbnails, Gemini/LLM icons, and inline ∑ chips.
- Added a light/dark toggle on the first slide and fixed dark-mode accent colors.
- Moved slide buttons to a fixed footer and added a smooth slide/fade transition.
- Added an "N new" badge to the minimized dot; a single new summary auto-opens the newest History entry.
- The floating UI now starts minimized (dot) by default.
- Added the userscript @icon and hid the dot in fullscreen.
- Added hover/press animation to the dot.
- Added embed support: a compact ∑ button on embedded players (Options toggle, on by default).
- Restructured the prompt: shared base plus mode-specific additions, with a CAPTION_UNUSABLE sentinel that triggers the URL fall-back.
- Onboarding "I know what I'm doing" now embeds the API Configuration form inline; the custom prompt field is prefilled with an editable copy of the default.

## 1.0.9 - 2026-09-18 (highlight)
- History: compacted Export JSON/CSV and Clear all history onto one row.
- Options: grouped the mode slider and URL fall-back into a "Summary mode" panel; moved the drag handle to a bottom grip; widened the panel to 400px with full-width History summaries.
- Fixed watch-page title extraction so it no longer picks up a sidebar video's title.
- URL mode now falls back to Caption automatically on HTTP 403, with a clear message when a Gemini key is required for the fall-back.
- Repaired Caption mode: added the token-free Android InnerTube caption path and timedtext format-3 parsing after YouTube began returning HTTP 400 to get_transcript.
- Added the "Set up bug report" tool with auto-filled environment details, a prefilled GitHub issue, copy-to-clipboard, and anonymous submission via Web3Forms.
- Simplified Developer Contact (mailto email + GitHub link) and relabeled the debug toggle to "Show/Hide debug log".
- Options reorg: "Summary Configuration" accordion open by default; cache/Stats & Data/FAQ/Data & Privacy moved to the bottom; default summary text size 14px; accordion ARIA states; trimmed API Configuration copy.

## 1.0.8 - 2026-09-17
- Renamed the shipped file to Vorsum.user.js and updated every reference.
- Switched @updateURL/@downloadURL (and the README install link) to the GitHub raw URL; the in-panel update banner now opens the raw install URL.
- Added a release note clarifying that the version lives only in the @version line.
