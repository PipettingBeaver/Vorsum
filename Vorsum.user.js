// ==UserScript==
// @name         Vorsum - Youtube Summary Button
// @namespace    https://github.com/PipettingBeaver/Vorsum
// @icon         https://s.ytimg.com/yts/img/favicon_32-vflWoMFGx.png
// @version      1.1.2
// @description  Adds a click-to-summarize button to YouTube grid cards. Two modes: caption-transcript or direct-URL (Gemini watches the video itself). Beginner friendly and includes a tutorial.
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_info
// @grant        unsafeWindow
// @connect      generativelanguage.googleapis.com
// @connect      www.youtube.com
// @connect      api.anthropic.com
// @connect      api.openai.com
// @connect      api.web3forms.com
// @connect      *
// @connect      raw.githubusercontent.com
// @updateURL   https://github.com/PipettingBeaver/Vorsum/raw/refs/heads/main/Vorsum.user.js
// @downloadURL https://github.com/PipettingBeaver/Vorsum/raw/refs/heads/main/Vorsum.user.js
// @run-at       document-idle
// ==/UserScript==

// ---- Cutting a release ----
// The version number lives in EXACTLY ONE place: the `// @version` line
// above. Bump only that line.
//   - getVersion() reads it at runtime from GM_info.script.version, so no
//     JS constant needs updating.
//   - @updateURL / @downloadURL / REPO_RAW_URL / REPO_PAGE_URL are all
//     version-free and do not change between releases.
// Pushing this file to `main` with a higher @version is what makes
// ViolentMonkey/Tampermonkey - and the in-panel update banner - notice it.

(function () {
  'use strict';

  // ---- Config ----
  const MODEL = 'gemini-3.5-flash-lite'; // free-tier lightweight model on the Interactions API

  // InnerTube client used only to obtain caption tracks WITHOUT a PoToken.
  // The ANDROID player returns caption track URLs that don't carry the
  // exp=xpe "proof-of-origin required" flag, whereas the WEB client's do.
  // This is what lets Caption mode work on layouts (e.g. Project Vorapis)
  // that replace YouTube's modern HTML5 player with an older fork and hence
  // never initialize the in-page BotGuard WebPoClient. The key is Google's
  // long-public Android client key (same one yt-dlp and friends use).
  const ANDROID_API_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
  const ANDROID_CLIENT_VERSION = '20.10.38';
  // Shared base prompt for BOTH modes. Mode-specific instructions (the
  // caption music/art heuristic, the fallback sentinel) are appended per call
  // in buildSummaryPrompt(), so URL mode never carries a caption-only clause.
  const SUMMARY_PROMPT =
    'Summarize this video in 3-4 sentences for someone deciding whether to watch it, and give in Standard Technical English. ' +
    'Focus on the concrete points/conclusions, not vague teasers. Remove any preamble, only reply with summary itself.';

  // Emitted by the model in Caption mode when the transcript is unusable, so
  // the result can be machine-detected (see handleClick) and, when the URL
  // fall-back is enabled, trigger a retry in URL mode instead of being shown.
  const CAPTION_UNUSABLE_MARKER = 'CAPTION_UNUSABLE';
  const CAPTION_UNUSABLE_RE = new RegExp(`\\b${CAPTION_UNUSABLE_MARKER}\\b`, 'i');

  // ---- LLM providers (Caption mode only - URL mode is Gemini-exclusive) ----
  // URL mode depends on Gemini's specific ability to ingest a YouTube URL
  // directly and watch the video (audio+visual, not just text) - no other
  // major provider offers that, so there's nothing to generalize there.
  // Caption mode is a plain text-completion call (transcript in, summary
  // out) once the transcript is in hand, which IS provider-agnostic, so
  // that's the one that gets a selectable backend. Each adapter maps to
  // one real API shape; "OpenAI-compatible" covers OpenAI itself plus the
  // overwhelming majority of local runners (Ollama, LM Studio,
  // text-generation-webui, llama.cpp server) and third-party aggregators
  // (OpenRouter, Groq, etc.), since that's the de facto standard interface
  // nearly everyone in that space exposes.
  const LLM_PROVIDERS = {
    gemini: {
      label: 'Gemini',
      needsBaseUrl: false,
      needsModel: false, // uses the fixed MODEL constant above, same as URL mode
      buildRequest({ apiKey, model, promptText, videoUri }) {
        const input = [{ type: 'text', text: promptText }];
        if (videoUri) input.push({ type: 'video', uri: videoUri }); // URL mode only
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`,
          headers: { 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
          body: JSON.stringify({ model: model || MODEL, input })
        };
      },
      parseResponse(data) {
        if (data.error) return { error: data.error.message || data.error.status || 'Unknown error' };
        const modelStep = data.steps?.find((s) => s.type === 'model_output');
        const text = modelStep?.content?.find((c) => c.type === 'text')?.text;
        return text ? { text } : { error: 'No text in response' };
      },
      isTransient(res, data) {
        return (
          res.status >= 500 ||
          res.status === 429 ||
          data?.error?.status === 'UNAVAILABLE' ||
          data?.error?.status === 'RESOURCE_EXHAUSTED' ||
          data?.error?.code === 'gateway_timeout' ||
          /deadline expired|high demand|overloaded|try again later|rate limit/i.test(data?.error?.message || '')
        );
      }
    },
    anthropic: {
      label: 'Claude (Anthropic)',
      needsBaseUrl: false,
      needsModel: true,
      modelPlaceholder: 'claude-sonnet-5',
      buildRequest({ apiKey, model, promptText }) {
        return {
          url: 'https://api.anthropic.com/v1/messages',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            // Anthropic added CORS support for direct-from-browser calls
            // gated behind this exact header, with a "bring your own key"
            // pattern in mind - which is precisely what this is.
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-5',
            max_tokens: 1024,
            messages: [{ role: 'user', content: promptText }]
          })
        };
      },
      parseResponse(data) {
        if (data.error) return { error: data.error.message || data.error.type || 'Unknown error' };
        const text = data.content?.find((c) => c.type === 'text')?.text;
        return text ? { text } : { error: 'No text in response' };
      },
      isTransient(res, data) {
        return res.status >= 500 || res.status === 429 || data?.error?.type === 'overloaded_error';
      }
    },
    openai_compatible: {
      label: 'OpenAI-compatible (OpenAI, Ollama, LM Studio, local, etc.)',
      needsBaseUrl: true,
      baseUrlPlaceholder: 'https://api.openai.com/v1/chat/completions',
      needsModel: true,
      modelPlaceholder: 'gpt-4o-mini / llama3.1 / etc.',
      buildRequest({ apiKey, baseUrl, model, promptText }) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`; // often unset/irrelevant for local servers
        return {
          url: baseUrl,
          headers,
          body: JSON.stringify({ model: model || '', messages: [{ role: 'user', content: promptText }] })
        };
      },
      parseResponse(data) {
        if (data.error) {
          return { error: typeof data.error === 'string' ? data.error : data.error.message || 'Unknown error' };
        }
        const text = data.choices?.[0]?.message?.content;
        return text ? { text } : { error: 'No text in response' };
      },
      isTransient(res) {
        return res.status >= 500 || res.status === 429;
      }
    }
  };

  function getLlmProvider() {
    const stored = GM_getValue('vorsum_llm_provider', 'gemini');
    return LLM_PROVIDERS[stored] ? stored : 'gemini';
  }
  function setLlmProvider(p) {
    GM_setValue('vorsum_llm_provider', p);
  }
  function getProviderCredentials(provider) {
    if (provider === 'gemini') {
      return { apiKey: GM_getValue('gemini_api_key', ''), model: MODEL, baseUrl: null };
    }
    if (provider === 'anthropic') {
      return {
        apiKey: GM_getValue('vorsum_anthropic_key', ''),
        model: GM_getValue('vorsum_anthropic_model', ''),
        baseUrl: null
      };
    }
    return {
      apiKey: GM_getValue('vorsum_openai_key', ''),
      model: GM_getValue('vorsum_openai_model', ''),
      baseUrl: GM_getValue('vorsum_openai_base_url', '')
    };
  }

  // Explicit, separately-configurable output language instead of leaving it
  // implicit in prompt text - specifically to avoid the exact failure
  // YouTube's own native auto-summary has been observed to have: a
  // German-language video producing a German-language summary regardless
  // of the viewer's own language, i.e. no localization at all. Blank means
  // "don't add a language instruction" (whatever the model defaults to).
  function getSummaryLanguage() {
    return GM_getValue('vorsum_summary_language', 'English');
  }
  function setSummaryLanguage(lang) {
    GM_setValue('vorsum_summary_language', lang);
  }

  // When caption mode fails to produce a transcript, automatically retry the
  // same video in URL mode (Gemini watches it directly). Off by default is
  // the conservative choice, but the user can opt in from Options.
  function getFallbackToUrlEnabled() {
    return GM_getValue('vorsum_fallback_to_url', false);
  }
  function setFallbackToUrlEnabled(v) {
    GM_setValue('vorsum_fallback_to_url', v);
  }

  function getTranscriptButtonEnabled() {
    return GM_getValue('vorsum_transcript_button', false);
  }
  function setTranscriptButtonEnabled(v) {
    GM_setValue('vorsum_transcript_button', v);
  }

  // Whether the compact ∑ button is shown over embedded players (iframes on
  // other sites). On by default; the floating widget is never shown in embeds
  // regardless, so turning this off means embeds get nothing.
  function getEmbedButtonEnabled() {
    return GM_getValue('vorsum_embed_button', true);
  }
  function setEmbedButtonEnabled(v) {
    GM_setValue('vorsum_embed_button', v);
  }

  function sanitizeFilename(name) {
    return (name || 'transcript').replace(/[^\w\s-]/g, '').trim().slice(0, 80) || 'transcript';
  }

  // The real question isn't "is this a phone" (unreliable to detect and not
  // actually what matters) - it's "does this device have hover at all".
  // (hover: none) and (pointer: coarse) together mean touch-primary input
  // with no hover capability, which is the actual condition hover-reveal
  // needs to avoid: a touch laptop with a mouse attached still has hover
  // and shouldn't be swept into "mobile" just because it's touch-capable.
  function isMobileDevice() {
    return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  }
  function getHoverOnlyEnabled() {
    return GM_getValue('vorsum_hover_only', !isMobileDevice());
  }
  function setHoverOnlyEnabled(v) {
    GM_setValue('vorsum_hover_only', v);
  }
  // Same lesson already learned twice in this file (theme colors, then
  // font-size): a stylesheet rule, even with !important and a live
  // :hover/attribute selector, is a bet against whatever CSS Vorapis or
  // YouTube's own page ships, and that bet has kept losing here for
  // reasons not fully diagnosable from outside a real browser. Opacity
  // visibility moves to the same deterministic mechanism as those two:
  // real mouseenter/mouseleave/focus/blur listeners on the card, setting
  // opacity directly on the button inline with 'important' priority -
  // nothing on the page can out-rank that, and it doesn't depend on a
  // CSS selector correctly winning a specificity fight we can't see.
  function applyBtnHoverVisibility(btn) {
    // Buttons that manage their own reveal (the embed ∑ button) opt out of the
    // shared hover-only system - otherwise its pointer-events:none would make
    // the button unclickable, and its forced opacity would fight the reveal.
    if (btn.dataset.vorsumOwnVisibility === 'true') return;
    if (!getHoverOnlyEnabled()) {
      btn.style.setProperty('opacity', '1', 'important');
      btn.style.setProperty('pointer-events', 'auto', 'important');
      return;
    }
    const hovered = btn.dataset.vorsumHovered === 'true';
    const cached = btn.classList.contains('vorsum-btn-cached');
    // "Active" = anything other than the idle glyph - busy/fetching,
    // rate-limited, an error, or the overlay currently open. These need
    // to stay visible regardless of hover so progress/errors are never
    // silently invisible, and so the button that opened an overlay is
    // still reachable to close it without having to re-hover the card.
    // Set by setButtonState() whenever the label changes.
    const active = btn.dataset.vorsumActive === 'true';
    // A cached video's button stays at low opacity rather than fully
    // invisible when idle - a passive "a summary is already waiting
    // here" signal that would otherwise be lost entirely behind
    // hover-only.
    const visible = active || hovered;
    const opacity = visible ? '1' : cached ? '0.35' : '0';
    btn.style.setProperty('opacity', opacity, 'important');
    btn.style.setProperty('pointer-events', visible ? 'auto' : 'none', 'important');
  }

  function refreshAllButtonHoverVisibility() {
    document.querySelectorAll('.vorsum-btn').forEach(applyBtnHoverVisibility);
  }

  function applyHoverOnlySetting() {
    // Attribute kept for easy inspection in devtools, but nothing above
    // depends on it anymore.
    document.documentElement.setAttribute('data-vorsum-hover-only', getHoverOnlyEnabled() ? 'true' : 'false');
    refreshAllButtonHoverVisibility();
  }
  const CARD_SELECTOR = [
    '.yt-lockup', // feed layout VORAPIS renders (search results, subscriptions, etc.)
    '.lohp-media-object-content', // VORAPIS homepage "featured" shelf - both the large
                                   // hero tile and the smaller tiles share this class on
                                   // their title+metadata block, which is self-contained
                                   // (has its own watch link, title, and channel link) so
                                   // it doubles as both the card root and the append target
    'li.related-list-item', // VORAPIS watch-page sidebar - both "Up Next" and the
                             // "related" list below it use this per-item wrapper
    '.ytLockupViewModelMetadata', // vanilla YouTube's current "lockup view model" card -
                                  // self-contained the same way as the homepage shelf
                                  // above (own watch link, title, channel link), so no
                                  // separate thumbnail-side lookup is needed
    'ytd-video-renderer #dismissible' // vanilla YouTube search results page - an older,
                                  // separate renderer template from the lockup-view-model
                                  // one above, so it needed its own entry. Scoped with the
                                  // ytd-video-renderer ancestor rather than a bare
                                  // #dismissible, since that id is reused (invalid HTML,
                                  // but browsers tolerate it) by several unrelated
                                  // component types elsewhere on the page.
  ].join(',');

  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = { transcript: 45000, url: 180000 };
  const BACKOFF_BASE_MS = { transcript: 3000, url: 5000 };

  const MAX_TRANSCRIPT_CHARS = 20000; // soft cap so we don't burn tokens on very long videos

  // TEMPORARY: verbose debug panel default-on while we're diagnosing timeouts.
  // Flip to false once things are stable - it's noisy for daily use.
  const DEBUG_DEFAULT = true;

  const HISTORY_PAGE_SIZE = 15;

  // ---- Settings (GM storage: small, infrequently-written values) ----
  function getMode() {
    return GM_getValue('vorsum_mode', 'url');
  }
  function setMode(mode) {
    GM_setValue('vorsum_mode', mode);
  }
  function getDebugOn() {
    return GM_getValue('vorsum_debug', DEBUG_DEFAULT);
  }
  function setDebugOn(on) {
    GM_setValue('vorsum_debug', on);
  }
  function getWidgetCollapsed() {
    // Default to minimized (the floating dot), so a first-run install doesn't
    // drop a full panel onto the page. The onboarding "I know what I'm doing"
    // path still expands it via openCaptionProviderSettings().
    return GM_getValue('vorsum_widget_collapsed', true);
  }
  function setWidgetCollapsed(collapsed) {
    GM_setValue('vorsum_widget_collapsed', collapsed);
  }

  // Shared top-right anchor (in CSS px) for BOTH the collapsed dot and the
  // expanded panel. One stored position means dragging either one keeps the
  // two visually linked - the dot and the panel always share the same
  // top-right corner. Anchoring to the RIGHT (not the left) is what makes
  // the minimize button land exactly where the open button was: the panel's
  // minimize button sits in its top-right corner, so a top-right-anchored
  // panel puts it on top of the dot that opened it. The default (right 20,
  // top 100) is the "100px down, 20px from the right edge" starting spot,
  // independent of the page skin (vanilla vs Vorapis).
  function getWidgetPos() {
    const stored = GM_getValue('vorsum_widget_pos', null);
    if (stored && Number.isFinite(stored.right) && Number.isFinite(stored.top)) {
      return { right: stored.right, top: stored.top };
    }
    return { right: 20, top: 100 };
  }
  function setWidgetPos(right, top) {
    GM_setValue('vorsum_widget_pos', { right: Math.round(right), top: Math.round(top) });
  }
  function getOnboarded() {
    return GM_getValue('vorsum_onboarded', false);
  }
  function setOnboarded(v) {
    GM_setValue('vorsum_onboarded', v);
  }

  // Reads the @version header directly (via GM_info) instead of duplicating
  // it in a separate JS constant, so the two can't drift out of sync. Once
  // this is published, @updateURL/@downloadURL pointed at the raw GitHub
  // file is what lets a manager (Tampermonkey/Violentmonkey) notice this
  // number changed and offer an update - GM_info itself doesn't check
  // anything remotely, it just reports the locally-installed version.
  function getVersion() {
    try {
      return (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';
    } catch (e) {
      return '?';
    }
  }

  // ---- Update check ----
  // @updateURL/@downloadURL (in the header above) is what actually lets
  // Tampermonkey/Violentmonkey update the script - that happens entirely
  // in the manager's own UI, on its own schedule, and a lot of people never
  // notice the little badge for it. This is the second half: vorsum checks
  // for itself, on its own throttled schedule, and says so somewhere the
  // person is actually looking - inside its own panel.
  const REPO_RAW_URL = 'https://raw.githubusercontent.com/PipettingBeaver/Vorsum/refs/heads/main/Vorsum.user.js';
  // Where the in-panel update banner sends people. Points at the raw
  // userscript URL (not the repo page) because that's the URL a userscript
  // manager intercepts to offer install/update - the repo page would just
  // show source code with no install prompt.
  const REPO_PAGE_URL = 'https://github.com/PipettingBeaver/Vorsum/raw/refs/heads/main/Vorsum.user.js';
  const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once/day - no need for more than that
  let updateNoticeEl = null;
  let latestKnownVersion = null;

  // Shown in the main widget (not the onboarding modal) whenever it's open
  // and literally no provider has a key configured yet - the state where
  // summarizing genuinely can't work at all, distinct from onboarding's own
  // "you haven't finished setup" framing. Checks all three provider keys,
  // not just Gemini's, since someone could have configured only Claude/a
  // local server for Caption mode and never touched Gemini at all.
  let noKeyNoticeEl = null;
  function hasAnyApiKeyConfigured() {
    return !!(GM_getValue('gemini_api_key', '') || GM_getValue('vorsum_anthropic_key', '') || GM_getValue('vorsum_openai_key', ''));
  }
  function renderNoKeyNotice() {
    if (!noKeyNoticeEl) return;
    noKeyNoticeEl.style.display = hasAnyApiKeyConfigured() ? 'none' : 'block';
  }

  // Simple numeric-part comparison (1.2.10 > 1.2.9), not a full semver
  // parser - fine for this project's plain MAJOR.MINOR.PATCH versioning.
  function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] || 0;
      const db = pb[i] || 0;
      if (da !== db) return da > db;
    }
    return false;
  }

  function renderUpdateNotice() {
    if (!updateNoticeEl) return;
    if (!latestKnownVersion || !isNewerVersion(latestKnownVersion, getVersion())) {
      updateNoticeEl.style.display = 'none';
      return;
    }
    updateNoticeEl.textContent = `v${latestKnownVersion} available (you're on v${getVersion()}) - click to update`;
    updateNoticeEl.style.display = 'block';
  }

  function checkForUpdate(force) {
    const lastChecked = GM_getValue('vorsum_update_last_checked', 0);
    if (!force && Date.now() - lastChecked < UPDATE_CHECK_INTERVAL_MS) return;
    GM_setValue('vorsum_update_last_checked', Date.now());

    GM_xmlhttpRequest({
      method: 'GET',
      url: REPO_RAW_URL,
      timeout: 15000,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          log(`Update check: HTTP ${res.status}`, 'warn');
          return;
        }
        // Only the @version line is needed - no reason to parse or run the
        // rest of the fetched file.
        const match = res.responseText.match(/@version\s+([\d.]+)/);
        if (!match) {
          log('Update check: could not find @version in the fetched file', 'warn');
          return;
        }
        latestKnownVersion = match[1];
        log(`Update check: latest on GitHub is v${latestKnownVersion}, running v${getVersion()}`);
        renderUpdateNotice();
      },
      onerror: () => log('Update check: network error', 'warn'),
      ontimeout: () => log('Update check: timed out', 'warn')
    });
  }

  // ---- Changelog / "What's new" ----
  // changelog.json lives on the repo; fetched lazily (only when the version
  // changed and the cache is stale, or on demand) and cached in GM storage -
  // never bundled, never on a fixed interval.
  const CHANGELOG_RAW_URL = 'https://raw.githubusercontent.com/PipettingBeaver/Vorsum/refs/heads/main/changelog.json';
  const CHANGELOG_CACHE_KEY = 'vorsum_changelog_cache';
  const CHANGELOG_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const LAST_SEEN_VERSION_KEY = 'vorsum_last_seen_version';
  let whatsNewNoticeEl = null;

  function getCachedChangelog() {
    const cache = GM_getValue(CHANGELOG_CACHE_KEY, null);
    return cache && Array.isArray(cache.data) ? cache : null;
  }
  function fetchChangelog(force) {
    const cache = getCachedChangelog();
    if (!force && cache && Date.now() - (cache.fetchedAt || 0) < CHANGELOG_CHECK_INTERVAL_MS) {
      return Promise.resolve(cache.data);
    }
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: CHANGELOG_RAW_URL,
        timeout: 15000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            resolve(cache ? cache.data : null);
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            if (Array.isArray(data)) {
              GM_setValue(CHANGELOG_CACHE_KEY, { fetchedAt: Date.now(), data });
              resolve(data);
            } else {
              resolve(cache ? cache.data : null);
            }
          } catch (e) {
            resolve(cache ? cache.data : null);
          }
        },
        onerror: () => resolve(cache ? cache.data : null),
        ontimeout: () => resolve(cache ? cache.data : null)
      });
    });
  }
  function findChangelogEntry(data, version) {
    if (!Array.isArray(data)) return null;
    return data.find((e) => e && e.version === version) || null;
  }

  // Fetches if needed, then shows a version's changes in the generic modal.
  function openWhatsNew(version) {
    const target = version || getVersion();
    fetchChangelog(true).then(() => showChangelogModal(target));
  }

  function showChangelogModal(version) {
    const data = getCachedChangelog() ? getCachedChangelog().data : null;
    const entry = findChangelogEntry(data, version);
    showSimpleModal(`What's new in v${version}`, (body) => {
      if (!entry) {
        addModalParagraph(body, 'No changelog details are available right now (offline or not published yet).');
      } else {
        const ul = document.createElement('ul');
        ul.style.cssText = 'margin:0 0 12px;padding-left:18px';
        (entry.changes || []).forEach((c) => {
          const li = document.createElement('li');
          li.textContent = c;
          li.style.cssText = 'margin-bottom:6px';
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      const link = document.createElement('a');
      link.href = CHANGELOG_RAW_URL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'See the full changelog';
      link.className = 'vorsum-history-title';
      link.style.cssText = 'text-decoration:underline';
      registerThemedEl(link);
      body.appendChild(link);
    });
  }

  // One-time, dismissible in-panel banner when the running version is newer
  // than the last one seen and is flagged `highlight` in changelog.json.
  function showWhatsNewBanner(entry) {
    if (!whatsNewNoticeEl) return;
    whatsNewNoticeEl.replaceChildren();
    const msg = document.createElement('span');
    msg.textContent = `\u2728 What's new in v${entry.version} - click to see`;
    msg.style.cssText = 'cursor:pointer;flex:1';
    msg.addEventListener('click', () => {
      whatsNewNoticeEl.style.display = 'none';
      showChangelogModal(entry.version);
    });
    const dismiss = document.createElement('button');
    dismiss.className = 'vorsum-ctrl-btn';
    dismiss.textContent = '\u00d7';
    dismiss.title = 'Dismiss';
    dismiss.style.cssText = 'padding:0 5px;font-size:11px !important;margin-left:4px';
    dismiss.addEventListener('click', () => {
      whatsNewNoticeEl.style.display = 'none';
    });
    whatsNewNoticeEl.appendChild(msg);
    whatsNewNoticeEl.appendChild(dismiss);
    whatsNewNoticeEl.style.display = 'flex';
    registerThemedSubtree(whatsNewNoticeEl);
  }

  function checkWhatsNew() {
    const current = getVersion();
    const lastSeen = GM_getValue(LAST_SEEN_VERSION_KEY, null);
    if (lastSeen === null) {
      GM_setValue(LAST_SEEN_VERSION_KEY, current); // first ever run - record silently
      return;
    }
    if (lastSeen === current) return;
    // Version changed since last seen. Defer to onboarding/update banners.
    if (onboardingModalOpen) return;
    if (updateNoticeEl && updateNoticeEl.style.display !== 'none') return;
    fetchChangelog(false).then((data) => {
      GM_setValue(LAST_SEEN_VERSION_KEY, current); // mark seen regardless of what we show
      const entry = findChangelogEntry(data, current);
      if (!entry || entry.highlight === false) return;
      if (onboardingModalOpen) return;
      showWhatsNewBanner(entry);
    });
  }


  // Fill this in once a screenshot is hosted somewhere reachable - e.g.
  // the raw GitHub URL after adding it to this repo's /assets folder
  // (https://raw.githubusercontent.com/<you>/<repo>/main/assets/hover-demo.png).
  // Meant to show hovering a video to reveal the \u2211 button and the
  // summary it produces. Left blank by default so a fresh clone doesn't
  // show a broken image icon; onboarding screen 1 hides the image slot
  // gracefully if this is empty or fails to load.
  const HOVER_SUMMARY_SCREENSHOT_URL = '';

  // 'light' | 'dark'. Falls back to the OS/browser preference the first
  // time this ever runs; after that it's whatever was last chosen, so it
  // stays put across YouTube's own theme toggling.
  function getTheme() {
    const stored = GM_getValue('vorsum_theme', null);
    if (stored === 'light' || stored === 'dark') return stored;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }
  function setTheme(theme) {
    GM_setValue('vorsum_theme', theme);
  }

  // Same lesson as font-size, applied to color: a stylesheet rule - even
  // with !important and a reasonably specific selector - is still a bet
  // against whatever Project Vorapis's own CSS does, and that bet kept
  // losing across several rounds for reasons not fully diagnosable from
  // outside a real browser (specificity fights we can't see, load order,
  // or something else entirely). So theme moves to the same deterministic
  // mechanism as font-size: every themed element is tracked by direct
  // reference, and its colors are stamped on individually, inline, with
  // 'important' priority - nothing on the page can out-rank that, full stop.
  //
  // One entry per class name we use for theming; an element can carry more
  // than one (e.g. "vorsum-ctrl-btn vorsum-danger-btn"), applied in this
  // fixed order so later entries (like the danger-red text) correctly
  // override earlier ones (like the base button color) regardless of the
  // order the classes happen to appear in the element's className string.
  const THEME_CLASS_ORDER = [
    'vorsum-widget-panel',
    'vorsum-dot',
    'vorsum-ctrl-btn',
    'vorsum-log',
    'vorsum-log-error',
    'vorsum-log-warn',
    'vorsum-log-info',
    'vorsum-search-input',
    'vorsum-textarea',
    'vorsum-select',
    'vorsum-history-row',
    'vorsum-history-title',
    'vorsum-history-meta',
    'vorsum-label',
    'vorsum-history-summary',
    'vorsum-empty',
    'vorsum-btn',
    'vorsum-btn-cached', // after vorsum-btn: overrides its color as an accent for "already summarized"
    'vorsum-summary-panel',
    'vorsum-banner',
    'vorsum-modal-backdrop',
    'vorsum-modal',
    'vorsum-danger-btn' // last: a color override on top of vorsum-ctrl-btn
  ];
  const THEME_STYLES = {
    'vorsum-widget-panel': {
      light: { background: '#ffffff', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#1e1e1e', color: '#f0f0f0', borderColor: '#444444', colorScheme: 'dark' }
    },
    'vorsum-dot': {
      light: { background: '#f4f4f4', color: '#333333', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#2c2c2c', color: '#f0f0f0', borderColor: '#666666', colorScheme: 'dark' }
    },
    'vorsum-ctrl-btn': {
      light: { background: '#f0f0f0', color: '#000000', borderColor: '#999999' },
      dark: { background: '#2c2c2c', color: '#f0f0f0', borderColor: '#666666' }
    },
    'vorsum-danger-btn': {
      light: { color: '#a00000' },
      dark: { color: '#ff6b6b' }
    },
    'vorsum-log': {
      light: { background: '#f5f5f5', color: '#000000', colorScheme: 'light' },
      dark: { background: '#111111', color: '#dddddd', colorScheme: 'dark' }
    },
    'vorsum-log-error': { light: { color: '#a00000' }, dark: { color: '#ff8080' } },
    'vorsum-log-warn': { light: { color: '#8a6d00' }, dark: { color: '#ffd080' } },
    'vorsum-log-info': { light: { color: '#000000' }, dark: { color: '#c8c8c8' } },
    'vorsum-search-input': {
      light: { background: '#ffffff', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#2c2c2c', color: '#f0f0f0', borderColor: '#666666', colorScheme: 'dark' }
    },
    'vorsum-textarea': {
      light: { background: '#ffffff', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#2c2c2c', color: '#f0f0f0', borderColor: '#666666', colorScheme: 'dark' }
    },
    'vorsum-select': {
      light: { background: '#ffffff', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#2c2c2c', color: '#f0f0f0', borderColor: '#666666', colorScheme: 'dark' }
    },
    'vorsum-history-row': {
      light: { borderColor: '#eeeeee' },
      dark: { borderColor: '#3a3a3a' }
    },
    'vorsum-history-title': {
      light: { color: '#0645ad' },
      dark: { color: '#6ea8fe' }
    },
    'vorsum-history-meta': {
      light: { color: '#555555' },
      dark: { color: '#aaaaaa' }
    },
    'vorsum-label': {
      light: { color: '#555555' },
      dark: { color: '#aaaaaa' }
    },
    'vorsum-history-summary': {
      light: { color: '#000000' },
      dark: { color: '#dddddd' }
    },
    'vorsum-empty': {
      light: { color: '#777777' },
      dark: { color: '#999999' }
    },
    'vorsum-btn': {
      light: { background: '#f8f8f8', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#2c2c2c', color: '#f0f0f0', borderColor: '#555555', colorScheme: 'dark' }
    },
    // Accent for "this video already has a cached summary for the current
    // mode" - a subtle blue tint, distinguishable without relying on color
    // alone since the tooltip also says so (see refreshButtonCachedVisual).
    'vorsum-btn-cached': {
      light: { background: '#e3edff', color: '#0b3d91', borderColor: '#8ab4f8' },
      dark: { background: '#16233a', color: '#9fc6ff', borderColor: '#3d6fb8' }
    },
    'vorsum-summary-panel': {
      // Needs an opaque background now that it's a floating overlay on
      // top of arbitrary page content (thumbnails, etc.) rather than an
      // inline element inheriting the page's own background - without
      // one the text would be illegible against whatever's behind it.
      light: { background: '#ffffff', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#1e1e1e', color: '#dddddd', borderColor: '#3a3a3a', colorScheme: 'dark' }
    },
    'vorsum-banner': {
      light: { background: '#fff6d8', color: '#5c4600', borderColor: '#e0c460' },
      dark: { background: '#3a3320', color: '#ffe38a', borderColor: '#8a742f' }
    },
    'vorsum-modal-backdrop': {
      light: { background: 'rgba(0,0,0,0.55)' },
      dark: { background: 'rgba(0,0,0,0.7)' }
    },
    'vorsum-modal': {
      light: { background: '#ffffff', color: '#000000', borderColor: '#cccccc', colorScheme: 'light' },
      dark: { background: '#1e1e1e', color: '#f0f0f0', borderColor: '#444444', colorScheme: 'dark' }
    }
  };

  function applyThemeToElement(el) {
    const theme = getTheme();
    THEME_CLASS_ORDER.forEach((cls) => {
      if (!el.classList.contains(cls)) return;
      const props = THEME_STYLES[cls]?.[theme];
      if (!props) return;
      if (props.background !== undefined) el.style.setProperty('background', props.background, 'important');
      if (props.color !== undefined) el.style.setProperty('color', props.color, 'important');
      if (props.borderColor !== undefined) el.style.setProperty('border-color', props.borderColor, 'important');
      if (props.colorScheme !== undefined) el.style.setProperty('color-scheme', props.colorScheme, 'important');
    });
  }

  let trackedThemedEls = [];
  function registerThemedEl(el) {
    trackedThemedEls.push(el);
    applyThemeToElement(el);
    return el;
  }
  // Bulk version: registers the root itself (if it carries a themed class)
  // plus every descendant carrying one, in one sweep - used for chunks of
  // UI built all at once (a widget panel, a history row) so adding a new
  // themed child later doesn't require remembering to register it by hand.
  const THEMED_SELECTOR = THEME_CLASS_ORDER.map((c) => `.${c}`).join(',');
  function registerThemedSubtree(root) {
    if (root.classList && THEME_CLASS_ORDER.some((c) => root.classList.contains(c))) {
      registerThemedEl(root);
    }
    root.querySelectorAll(THEMED_SELECTOR).forEach((el) => registerThemedEl(el));
  }

  function applyTheme() {
    // Attribute kept for easy inspection in devtools, but nothing above
    // depends on it anymore - the direct per-element application below is
    // what actually determines what's on screen.
    document.documentElement.setAttribute('data-vorsum-theme', getTheme());
    trackedThemedEls = trackedThemedEls.filter((el) => el.isConnected);
    trackedThemedEls.forEach(applyThemeToElement);
  }

  // Summary text size, for readability - applied via a CSS custom property
  // so both the inline (per-card) and History summary text stay in sync.
  // Plain numeric px rather than named steps (Small/Medium/Large/...) -
  // a 1px-granularity slider is a finer-grained control than 5 fixed
  // named sizes, and there's no real value in naming the in-between ones.
  const MIN_FONT_SIZE_PX = 9;
  const MAX_FONT_SIZE_PX = 24;
  const DEFAULT_FONT_SIZE_PX = 14;

  function getFontSizePx() {
    const stored = Number(GM_getValue('vorsum_font_size_px', DEFAULT_FONT_SIZE_PX));
    if (!Number.isFinite(stored)) return DEFAULT_FONT_SIZE_PX;
    return Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(stored)));
  }
  function setFontSizePx(px) {
    GM_setValue('vorsum_font_size_px', Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(px))));
  }
  function applyFontSize() {
    // Deliberately NOT a CSS custom property / var() lookup: that requires
    // an unbroken inheritance chain from <html> down to each element, which
    // depends on nothing in between (including YouTube's own script, which
    // is known to rewrite document.documentElement.style wholesale for
    // things like theater mode / fullscreen) ever touching that chain. This
    // was the actual bug - the variable could get silently clobbered after
    // being set, with no visible error. Instead: track direct references to
    // every scalable element and stamp font-size onto each one individually,
    // inline, with 'important' priority - the highest-priority mechanism in
    // the entire CSS cascade, so nothing else on the page can override it,
    // and it doesn't depend on any ancestor state surviving.
    const px = `${getFontSizePx()}px`;
    trackedSummaryEls = trackedSummaryEls.filter((el) => el.isConnected);
    trackedSummaryEls.forEach((el) => el.style.setProperty('font-size', px, 'important'));
  }

  // Elements whose text size is user-adjustable via the Options stepper
  // (currently: inline per-card summaries + History summaries). Holding
  // direct references means updates never depend on a DOM query being able
  // to find them again later (e.g. across whatever container YouTube's
  // renderer places a card in) - we already have the node, we just restyle it.
  let trackedSummaryEls = [];
  function registerScalableSummaryEl(el) {
    trackedSummaryEls.push(el);
    el.style.setProperty('font-size', `${getFontSizePx()}px`, 'important');
  }
  function refreshScalableSummaryEl(el) {
    el.style.setProperty('font-size', `${getFontSizePx()}px`, 'important');
  }

  // Optional override for the prompt sent to Gemini. Empty/unset = use the
  // built-in SUMMARY_PROMPT above.
  function getCustomPrompt() {
    return GM_getValue('vorsum_custom_prompt', '');
  }
  function setCustomPrompt(text) {
    GM_setValue('vorsum_custom_prompt', text);
  }
  function getEffectivePrompt() {
    const custom = getCustomPrompt().trim();
    return custom || SUMMARY_PROMPT;
  }

  // The full prompt for a given mode. The shared base (or the user's custom
  // prompt) is always the starting point - the mode clause is appended on top
  // so custom prompts keep working while still getting Caption-only behavior.
  // Applied to BOTH modes' behavior, not just the default prompt.
  function buildSummaryPrompt(mode) {
    let prompt = getEffectivePrompt();
    const lang = getSummaryLanguage().trim();
    if (lang) prompt += ` Respond in ${lang}.`;

    if (mode === 'transcript') {
      if (getFallbackToUrlEnabled()) {
        // Fall-back on: ask for a machine-detectable hard error instead of a
        // soft suggestion, so handleClick can retry in URL mode.
        prompt +=
          ` If the transcript is repetitive, nonsensical, or reads like song lyrics rather than speech` +
          ` (e.g. a music or art video), reply with exactly ${CAPTION_UNUSABLE_MARKER} and nothing else.`;
      } else {
        // Fall-back off: the friendly suggestion, as before.
        prompt += ' If the transcript is repetitive or nonsensical, suggest that the video may be a music or art video.';
      }
    }
    // URL mode adds nothing: Gemini watches the video and has no transcript to
    // judge, so the caption heuristic doesn't apply.
    return prompt;
  }

  // Only non-themed rule left: colors are now applied directly per-element
  // via applyThemeToElement() above, not through this stylesheet (see the
  // comment on THEME_CLASS_ORDER for why). This stays because :disabled
  // styling doesn't depend on theme and is simplest as a plain CSS rule.
  // Hover-reveal used to live here as a stylesheet rule keyed off a
  // data-vorsum-hover-only attribute + :hover selectors. It didn't
  // reliably work (same class of problem as the theme/font-size fights
  // documented elsewhere in this file), so it's now handled entirely by
  // applyBtnHoverVisibility() via real event listeners + inline
  // !important styles - see that function. Only the :disabled rule
  // stays here, since it doesn't depend on theme or any of this.
  function injectGlobalStyles() {
    if (document.getElementById('vorsum-styles')) return;
    const style = document.createElement('style');
    style.id = 'vorsum-styles';
    style.textContent = `
      .vorsum-ctrl-btn:disabled { opacity:0.4 !important; cursor:default !important; }
      /* box-sizing was never set anywhere in this file, so every
         width:100% input/select/textarea with padding was overflowing
         its container by the padding amount (default box-sizing is
         content-box) - most visible on the Summary language field since
         its label is the longest, but it was a systemic issue across the
         whole panel, not just that one field. */
      .vorsum-widget-panel, .vorsum-widget-panel *, .vorsum-modal, .vorsum-modal * {
        box-sizing: border-box !important;
      }
      /* Floating dot: grow slightly on hover, squash while pressed/clicked.
         Transform/box-shadow aren't set inline, so these apply cleanly (the
         shadow needs !important to outrank the dot's inline style). */
      #vorsum-widget-dot {
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      #vorsum-widget-dot:hover {
        transform: scale(1.08);
        box-shadow: 0 3px 10px rgba(0,0,0,0.45) !important;
      }
      #vorsum-widget-dot:active {
        transform: scale(0.94);
      }
      /* Embedded-player ∑ button: same grow/squash feedback. */
      #vorsum-embed-btn:hover {
        transform: scale(1.12);
      }
      #vorsum-embed-btn:active {
        transform: scale(0.9);
      }
    `;
    document.head.appendChild(style);
  }

  // ---- Debug log ----
  // Per-page in-memory buffer (the live view) PLUS a shared, per-tab rolling
  // cache in GM storage so a report filed from a main tab can include entries
  // from other tabs/embeds, which live in separate JS contexts. Each page owns
  // its own `vorsum_log_<tab>` key, so there's no read-modify-write clobbering
  // between tabs; GM storage is manager-level (not partitioned per top-level
  // site) so embed logs are visible too.
  const logBuffer = [];
  let logPanelEl = null;

  const TAB_ID = 't' + Math.random().toString(36).slice(2, 7);
  const LOG_CONTEXT = (() => {
    try {
      return location.pathname.startsWith('/embed/') ? 'embed' : 'main';
    } catch (e) {
      return 'main';
    }
  })();
  const LOG_TAG = `${TAB_ID} ${LOG_CONTEXT}`;
  const SHARED_LOG_PREFIX = 'vorsum_log_';
  const SHARED_LOG_MAX = 300;
  const SHARED_LOG_TTL_MS = 60 * 60 * 1000; // drop other tabs' caches after 1h
  function mySharedLogKey() {
    return SHARED_LOG_PREFIX + TAB_ID;
  }

  let sharedFlushTimer = null;
  function flushSharedLog() {
    if (sharedFlushTimer) {
      clearTimeout(sharedFlushTimer);
      sharedFlushTimer = null;
    }
    const lines = logBuffer.slice(-SHARED_LOG_MAX).map((e) => ({ ts: e.ts, level: e.level, line: e.line }));
    try {
      GM_setValue(mySharedLogKey(), { tab: TAB_ID, ctx: LOG_CONTEXT, updatedAt: Date.now(), lines });
    } catch (e) {
      /* best-effort diagnostics - never let a log write break the page */
    }
  }
  // Debounced, event-driven - NOT an interval. One write per burst of
  // activity; warn/error flush almost immediately. An idle page writes nothing.
  function scheduleSharedFlush(delay) {
    clearTimeout(sharedFlushTimer);
    sharedFlushTimer = setTimeout(() => {
      sharedFlushTimer = null;
      flushSharedLog();
    }, delay);
  }
  function pruneSharedLogs() {
    const now = Date.now();
    try {
      GM_listValues().forEach((k) => {
        if (!k.startsWith(SHARED_LOG_PREFIX) || k === mySharedLogKey()) return;
        const rec = GM_getValue(k, null);
        if (!rec || !rec.updatedAt || now - rec.updatedAt > SHARED_LOG_TTL_MS) GM_deleteValue(k);
      });
    } catch (e) {
      /* best-effort */
    }
  }
  // Merged view for the debug panel + bug report: this tab's live buffer plus
  // every other tab's persisted cache, oldest first, each tagged tab/context.
  function getMergedLogEntries() {
    const out = [];
    try {
      GM_listValues().forEach((k) => {
        if (!k.startsWith(SHARED_LOG_PREFIX) || k === mySharedLogKey()) return;
        const rec = GM_getValue(k, null);
        if (!rec || !Array.isArray(rec.lines)) return;
        const tag = `${rec.tab} ${rec.ctx}`;
        rec.lines.forEach((l) => out.push({ ts: l.ts || 0, line: l.line, level: l.level, tag }));
      });
    } catch (e) {
      /* best-effort */
    }
    logBuffer.forEach((e) => out.push({ ts: e.ts, line: e.line, level: e.level, tag: LOG_TAG }));
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }
  function formatMergedLog() {
    return getMergedLogEntries()
      .map((e) => `[${e.tag}] ${e.line}`)
      .join('\n');
  }

  function fmtTime() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function log(msg, level = 'info') {
    const ts = Date.now();
    const line = `[${fmtTime()}] ${msg}`;
    logBuffer.push({ ts, line, level, msg });
    if (logBuffer.length > 500) logBuffer.shift();

    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(`[vorsum] ${msg}`);

    if (getDebugOn() && logPanelEl) {
      renderLogLine({ ts, line, level, tag: LOG_TAG });
    }

    scheduleSharedFlush(level === 'warn' || level === 'error' ? 300 : 5000);
  }

  function renderLogLine(entry) {
    const row = document.createElement('div');
    row.textContent = `[${entry.tag}] ${entry.line}`;
    row.className = entry.level === 'error' ? 'vorsum-log-error' : entry.level === 'warn' ? 'vorsum-log-warn' : 'vorsum-log-info';
    logPanelEl.appendChild(row);
    logPanelEl.scrollTop = logPanelEl.scrollHeight;
    registerThemedEl(row);
  }

  function renderFullLog() {
    if (!logPanelEl) return;
    logPanelEl.replaceChildren();
    getMergedLogEntries().forEach(renderLogLine);
  }

  // Persist on hide/close so a closing tab isn't lost, and drop stale
  // per-tab caches once per load.
  window.addEventListener('pagehide', flushSharedLog);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSharedLog();
  });
  pruneSharedLogs();

  // ---- History storage (IndexedDB) ----
  // Why IndexedDB instead of GM_setValue: GM storage has no listing/query
  // primitives (GM_listValues + manual filtering is an O(n) scan-and-fetch),
  // and a "one big JSON blob" design gets slower and riskier to write as it
  // grows. IndexedDB gives us indexed, paginated, sorted access natively and
  // has no practical size ceiling for this use case. GM storage stays for
  // small settings (mode, debug flag, API key, usage counter) which don't
  // need any of that.
  const DB_NAME = 'vorsum';
  const DB_VERSION = 1;
  const STORE = 'summaries';
  let dbPromise = null;

  // In-memory index of History ids (`<mode>_<videoId>`) that currently have a
  // saved summary. IndexedDB is the single source of truth; this derived Set
  // exists only so the blue "Saved" tint can be checked synchronously during
  // button scans. Built from the store's keys at startup and kept in sync on
  // save/delete/clear + cross-tab broadcasts - never persisted.
  let savedSummaryIndex = new Set();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('videoId', 'videoId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function thumbUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  // Compact codes for History's stored `mode` field specifically - it's a
  // bare string per record with no other savings nearby, unlike the
  // internal getMode()/setMode() values and cache object keys (used all
  // over the click-handling logic as 'url'/'transcript', and nested under
  // much longer property names in storage already), which aren't worth
  // renaming for a couple of bytes. codeToModeLabel also normalizes old
  // full-word records written before this existed, so Stats & Data
  // grouping and display don't split "url (12)" / "U (34)" into separate
  // buckets.
  const MODE_TO_CODE = { url: 'U', transcript: 'C' };
  const CODE_TO_LABEL = { U: 'URL', C: 'Captions', url: 'URL', transcript: 'Captions' };
  function modeToStorageCode(mode) {
    return MODE_TO_CODE[mode] || mode;
  }
  function codeToModeLabel(code) {
    return CODE_TO_LABEL[code] || code;
  }
  const CODE_TO_MODE_KEY = { U: 'url', C: 'transcript' };
  function codeToModeKey(code) {
    // Translates History's stored mode field (short code, or an old
    // full-word entry) back into the actual key used in the video cache's
    // summaries object, which is never shortened (see comment above).
    return CODE_TO_MODE_KEY[code] || code;
  }

  async function historyRecordSummary({ videoId, mode, title, url, summary, channelName, channelUrl, silent }) {
    try {
      const db = await openDb();
      const id = `${mode}_${videoId}`;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);

      const existing = await new Promise((resolve) => {
        const r = store.get(id);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
      const isNewEntry = !existing;

      const record = {
        id,
        videoId,
        mode: modeToStorageCode(mode),
        title: title || existing?.title || videoId,
        url,
        channelName: channelName || existing?.channelName || null,
        channelUrl: channelUrl || existing?.channelUrl || null,
        thumbnailUrl: thumbUrl(videoId),
        summary,
        createdAt: existing?.createdAt || Date.now(),
        lastViewedAt: Date.now()
      };
      store.put(record);
      savedSummaryIndex.add(id); // keep the sync "Saved" tint index in step
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
      log(`History: saved record ${id}`);
      // Notification decisions moved out of here: they now depend on
      // whether the Summarize button was on-screen when the summary
      // arrived (see handleClick's onload handler), which this function
      // has no way to know. isNewEntry/silent are still accepted for
      // record-shape reasons (title/channel fallback above) but no longer
      // drive a notification from in here.
    } catch (e) {
      log(`History: failed to save record: ${e.message}`, 'warn');
    }
  }

  async function historyGetRecent(limit, offset) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const results = [];
      let skipped = 0;
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('createdAt');
      const req = idx.openCursor(null, 'prev'); // newest first
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function historySearch(query, limit) {
    const db = await openDb();
    const q = query.toLowerCase();
    return new Promise((resolve, reject) => {
      const results = [];
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('createdAt');
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        if ((cursor.value.title || '').toLowerCase().includes(q)) {
          results.push(cursor.value);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function historyDelete(id) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    savedSummaryIndex.delete(id);
    return new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  async function historyClearAll() {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    savedSummaryIndex.clear();
    return new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  // Deletes the N oldest entries by createdAt. Returns which ones (videoId +
  // mode code) for logging; the sync "Saved" index is updated here too.
  async function historyDeleteOldest(n) {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('createdAt');
      const req = idx.openCursor(null, 'next'); // oldest first
      const deleted = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || deleted.length >= n) {
          resolve(deleted);
          return;
        }
        deleted.push({ videoId: cursor.value.videoId, mode: cursor.value.mode });
        savedSummaryIndex.delete(cursor.value.id);
        cursor.delete();
        cursor.continue();
      };
      req.onerror = () => resolve(deleted);
    });
  }

  async function historyGetAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    // Quote whenever the field could otherwise be misread: a comma, a quote,
    // or a newline. Doubling embedded quotes is the standard CSV escape.
    if (/[",\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the download a moment to actually start before freeing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportHistory(format) {
    log(`Export: gathering all history entries as ${format}`);
    let entries;
    try {
      entries = await historyGetAll();
    } catch (e) {
      log(`Export: failed to read history: ${e.message}`, 'error');
      return;
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);

    const dateStamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      const payload = entries.map((e) => ({
        title: e.title,
        channelName: e.channelName || null,
        channelUrl: e.channelUrl || null,
        url: e.url,
        mode: codeToModeLabel(e.mode),
        summary: e.summary,
        createdAt: new Date(e.createdAt).toISOString(),
        lastViewedAt: e.lastViewedAt ? new Date(e.lastViewedAt).toISOString() : null
      }));
      downloadFile(`vorsum-history-${dateStamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
    } else {
      const header = ['Title', 'Channel', 'Channel URL', 'Video URL', 'Mode', 'Created', 'Summary'];
      const rows = entries.map((e) =>
        [
          e.title,
          e.channelName || '',
          e.channelUrl || '',
          e.url,
          codeToModeLabel(e.mode),
          new Date(e.createdAt).toISOString(),
          e.summary
        ]
          .map(csvEscape)
          .join(',')
      );
      const csv = [header.map(csvEscape).join(','), ...rows].join('\r\n');
      downloadFile(`vorsum-history-${dateStamp}.csv`, csv, 'text/csv');
    }
    log(`Export: downloaded ${entries.length} entries as ${format}`);
  }

  // One-time migration: pull existing vorsum_cache_* GM keys (including
  // orphaned pre-mode-toggle ones) into IndexedDB history so nothing gets
  // lost when this version rolls out. Runs once, guarded by a GM flag.
  const CACHE_PREFIX = 'vorsum_cache_';

  function parseCacheKey(key) {
    if (!key.startsWith(CACHE_PREFIX)) return null;
    const rest = key.slice(CACHE_PREFIX.length);
    if (rest.startsWith('transcript_')) {
      return { mode: 'transcript', videoId: rest.slice('transcript_'.length) };
    }
    if (rest.startsWith('url_')) {
      return { mode: 'url', videoId: rest.slice('url_'.length) };
    }
    return { mode: 'legacy', videoId: rest }; // pre-mode-toggle key (v0.2.0)
  }

  async function runMigrationIfNeeded() {
    if (GM_getValue('vorsum_migrated_v1', false)) return;

    log('Migration: checking for pre-existing cache entries to import into history');
    let keys = [];
    try {
      keys = GM_listValues().filter((k) => k.startsWith(CACHE_PREFIX));
    } catch (e) {
      log(`Migration: GM_listValues failed: ${e.message}`, 'warn');
      GM_setValue('vorsum_migrated_v1', true);
      return;
    }

    let imported = 0;
    for (const key of keys) {
      const parsed = parseCacheKey(key);
      if (!parsed) continue;
      const summary = GM_getValue(key, '');
      if (!summary) continue;

      await historyRecordSummary({
        videoId: parsed.videoId,
        mode: parsed.mode,
        title: null, // unrecoverable for migrated entries - falls back to videoId
        url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
        summary,
        silent: true
      });
      imported++;
    }

    GM_setValue('vorsum_migrated_v1', true);
    log(`Migration: imported ${imported} existing summary/summaries into history`);
  }

  // One-time: fold any legacy vorsum_video_cache entries into History (now the
  // single source of truth), then delete the old key. Runs AFTER
  // loadSavedSummaryIndex() so entries already in History are skipped.
  async function migrateVideoCacheToHistory() {
    if (GM_getValue('vorsum_video_cache_migrated', false)) return;
    let cache = {};
    try {
      cache = GM_getValue('vorsum_video_cache', {}) || {};
    } catch (e) {
      cache = {};
    }
    let imported = 0;
    for (const [videoId, entry] of Object.entries(cache)) {
      const summaries = entry && entry.summaries ? entry.summaries : null;
      if (!summaries) continue;
      for (const [mode, val] of Object.entries(summaries)) {
        const text = typeof val === 'string' ? val : val && val.text;
        if (!text) continue;
        if (savedSummaryIndex.has(savedSummaryId(videoId, mode))) continue; // already in History
        await historyRecordSummary({
          videoId,
          mode,
          title: null, // unrecoverable - falls back to the video id
          url: `https://www.youtube.com/watch?v=${videoId}`,
          summary: text,
          silent: true
        });
        imported++;
      }
    }
    try {
      GM_deleteValue('vorsum_video_cache');
    } catch (e) {
      /* best-effort */
    }
    GM_setValue('vorsum_video_cache_migrated', true);
    if (imported) {
      refreshAllButtonCachedVisuals();
      log(`Migration: imported ${imported} summary/summaries from the old video cache`);
    }
  }

  // One-time cleanup, run AFTER the history migration above (which needs to
  // read these same keys first) - deletes every leftover per-video/per-day
  // GM key from the old storage scheme now that everything going forward
  // uses the consolidated vorsum_video_cache / vorsum_daily_count keys.
  // Requested explicitly: no backward-compat concern, just remove the bloat.
  function cleanupLegacyStorage() {
    if (GM_getValue('vorsum_storage_v2_migrated', false)) return;

    let keys = [];
    try {
      keys = GM_listValues();
    } catch (e) {
      log(`Storage cleanup: GM_listValues failed: ${e.message}`, 'warn');
      GM_setValue('vorsum_storage_v2_migrated', true);
      return;
    }

    const legacyPrefixes = ['vorsum_cache_', 'vorsum_transcript_', 'vorsum_count_'];
    let removed = 0;
    keys.forEach((key) => {
      if (!legacyPrefixes.some((p) => key.startsWith(p))) return;
      try {
        GM_deleteValue(key);
        removed++;
      } catch (e) {
        log(`Storage cleanup: failed to delete ${key}: ${e.message}`, 'warn');
      }
    });

    GM_setValue('vorsum_storage_v2_migrated', true);
    log(`Storage cleanup: removed ${removed} legacy key(s) - now on consolidated storage`);
  }

  // ---- Small helpers ----
  function getApiKey() {
    let key = GM_getValue('gemini_api_key', '');
    if (!key) {
      key = prompt('Enter your Gemini API key (from aistudio.google.com):') || '';
      if (key) GM_setValue('gemini_api_key', key);
    }
    return key;
  }

  // Single self-resetting record instead of one GM key per calendar day
  // forever (vorsum_count_2026-08-12, vorsum_count_2026-08-13, ...). The
  // record just gets overwritten with a fresh {date, count} whenever the
  // stored date isn't today - no accumulation, no cleanup ever needed.
  function getTodayDateStr() {
    const now = new Date();
    const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return pacific.toISOString().slice(0, 10);
  }

  function bumpUsageCount() {
    const today = getTodayDateStr();
    const rec = GM_getValue('vorsum_daily_count', { date: '', count: 0 });
    const count = (rec.date === today ? rec.count : 0) + 1;
    GM_setValue('vorsum_daily_count', { date: today, count });
    return count;
  }

  function getUsageCount() {
    const today = getTodayDateStr();
    const rec = GM_getValue('vorsum_daily_count', { date: '', count: 0 });
    return rec.date === today ? rec.count : 0;
  }

  // ---- Saved-summary access (IndexedDB is the single source of truth) ----
  // Summaries live ONLY in the History store now; there is no separate
  // vorsum_video_cache blob to keep in sync. hasCachedSummary() stays
  // synchronous for the button tint by consulting the derived in-memory index
  // above, while getCachedSummary() reads the actual text from IndexedDB.
  function savedSummaryId(videoId, mode) {
    return `${mode}_${videoId}`;
  }
  function hasCachedSummary(videoId, mode) {
    return savedSummaryIndex.has(savedSummaryId(videoId, mode));
  }
  async function getCachedSummary(videoId, mode) {
    const id = savedSummaryId(videoId, mode);
    try {
      const db = await openDb();
      const rec = await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(id);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
      return (rec && rec.summary) || '';
    } catch (e) {
      return '';
    }
  }
  // Populates the sync index from the store's keys and re-tints any buttons
  // that were injected before it finished loading.
  async function loadSavedSummaryIndex() {
    try {
      const db = await openDb();
      const keys = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      savedSummaryIndex = new Set(keys.map(String));
      refreshAllButtonCachedVisuals();
    } catch (e) {
      log(`Saved-summary index: failed to load from History: ${e.message}`, 'warn');
    }
  }

  // Raw scraped transcripts are intentionally NOT persisted. They can run up
  // to MAX_TRANSCRIPT_CHARS (20,000) each, versus a summary at maybe a few
  // hundred - persisting them at scale (a few hundred videos) would bloat
  // IndexedDB for no real benefit. A transcript is only ever useful again
  // within the same click-to-retry chain (a failed summarize attempt retrying
  // moments later) - once a summary exists, the cache-hit check above
  // short-circuits before the transcript is ever touched again. A plain
  // in-memory Map covers that need without persisting anything to disk: gone
  // on page reload, and never grows the on-disk store at all.
  const transcriptSessionCache = new Map();
  function getCachedTranscript(videoId) {
    return transcriptSessionCache.get(videoId) || '';
  }
  function setCachedTranscript(videoId, transcript) {
    transcriptSessionCache.set(videoId, transcript);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Byte counts via Blob (UTF-8 accurate) rather than .length (UTF-16 code
  // units) - close enough for a display estimate, not meant to be exact to
  // the byte the storage backend actually uses on disk.
  async function getCacheSizeInfo() {
    let historyEntries = [];
    try {
      historyEntries = await historyGetAll();
    } catch (e) {
      log(`Cache size: failed to read history: ${e.message}`, 'warn');
    }
    const historyBytes = historyEntries.reduce((sum, e) => sum + new Blob([JSON.stringify(e)]).size, 0);

    return {
      historyCount: historyEntries.length,
      historyBytes,
      totalBytes: historyBytes,
      entries: historyEntries
    };
  }

  function decodeEntities(str) {
    // The classic innerHTML-into-a-textarea entity-decode trick is
    // blocked outright by Trusted Types CSP, which YouTube enforces on
    // at least some configurations - this was silently throwing on the
    // XML caption-parsing fallback path whenever it ran on such a page.
    // Decoding the small set of entities actually used in timedtext XML
    // by hand instead avoids the sink entirely.
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  function extractJsonAfterMarker(html, marker) {
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) return null;
    const braceStart = html.indexOf('{', markerIdx);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;

    for (let i = braceStart; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === stringChar) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return html.slice(braceStart, i + 1);
      }
    }
    return null;
  }

  // Primary path: ask InnerTube's own player endpoint directly, carrying
  // this tab's real session context (API key, visitor data, client
  // version) read out of ytcfg - the same values the actual page's own
  // requests use. This is meaningfully different from a plain fetch()
  // carrying no session identity at all, which is what was silently
  // getting fewer/gated results (confirmed: a plain watch-page fetch on a
  // real video returned zero captionTracks at all, not even a gated one).
  // unsafeWindow is required to read ytcfg - Tampermonkey/Violentmonkey
  // sandbox userscripts away from the page's own JS state by default,
  // that's the one deliberate hole poked in that isolation.
  async function getPlayerResponseViaInnerTube(videoId, poToken) {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const ytcfg = win.ytcfg;
    const apiKey = ytcfg?.get ? ytcfg.get('INNERTUBE_API_KEY') : undefined;
    if (!apiKey) {
      log('Transcript: unsafeWindow.ytcfg has no INNERTUBE_API_KEY available on this page', 'warn');
      return null;
    }
    const clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION') || '2.20260817.01.00';
    const visitorData = ytcfg.get('VISITOR_DATA');
    log(`Transcript: requesting via InnerTube player endpoint (clientVersion=${clientVersion}, visitorData=${visitorData ? 'present' : 'MISSING'})`);

    const payload = {
      context: { client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion, visitorData } },
      videoId,
      // Standard fields the player endpoint expects; omitting them can
      // yield a degraded response (in particular, missing caption tracks).
      contentCheckOk: true,
      racyCheckOk: true
    };
    // The player endpoint omits caption tracks without a PoToken, so attach
    // one (minted by mintPoToken) when available - this is what actually
    // makes the captions object show up in the response.
    if (poToken) {
      payload.serviceIntegrityDimensions = { poToken };
    }

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': clientVersion
        },
        timeout: 15000,
        data: JSON.stringify(payload),
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            log(`Transcript: InnerTube request HTTP ${res.status}`, 'warn');
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            log(`Transcript: InnerTube response JSON parse failed: ${e.message}`, 'warn');
            resolve(null);
          }
        },
        onerror: () => {
          log('Transcript: InnerTube request network error', 'warn');
          resolve(null);
        },
        ontimeout: () => {
          log('Transcript: InnerTube request timed out', 'warn');
          resolve(null);
        }
      });
    });
  }

  // Token-free caption source. The ANDROID client's player response carries
  // caption tracks whose baseUrl has no exp=xpe, so the timedtext fetch needs
  // no PoToken/BotGuard at all. Tried FIRST by getTranscript - it works on
  // both vanilla YouTube and player-replacing skins like Vorapis, and it
  // sidesteps the WebPoClient entirely when it succeeds.
  async function getPlayerResponseViaAndroid(videoId) {
    const payload = {
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: ANDROID_CLIENT_VERSION,
          androidSdkVersion: 30,
          hl: 'en',
          gl: 'US'
        }
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    };
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://www.youtube.com/youtubei/v1/player?key=${ANDROID_API_KEY}`,
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '3',
          'X-Youtube-Client-Version': ANDROID_CLIENT_VERSION,
          'X-Goog-Api-Key': ANDROID_API_KEY
        },
        timeout: 15000,
        data: JSON.stringify(payload),
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            log(`Transcript: ANDROID player request HTTP ${res.status}`, 'warn');
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            log(`Transcript: ANDROID player response JSON parse failed: ${e.message}`, 'warn');
            resolve(null);
          }
        },
        onerror: () => {
          log('Transcript: ANDROID player request network error', 'warn');
          resolve(null);
        },
        ontimeout: () => {
          log('Transcript: ANDROID player request timed out', 'warn');
          resolve(null);
        }
      });
    });
  }

  // Fallback for when the InnerTube path returns no usable caption tracks.
  // Note: the watch page no longer embeds caption tracks for every video
  // (they're loaded lazily by the player), so this is best-effort - it helps
  // for videos that still ship captions in ytInitialPlayerResponse, but a
  // PoToken'd InnerTube request is the reliable path.
  async function getPlayerResponseViaWatchPage(videoId, html) {
    if (!html) {
      log(`Transcript: fetching watch page for ${videoId} (fallback path)`);
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'same-origin' });
      if (!res.ok) {
        log(`Transcript: watch page fetch failed: HTTP ${res.status}`, 'warn');
        return null;
      }
      html = await res.text();
      log(`Transcript: watch page fetched (${html.length} chars), extracting player response`);
    }

    const jsonStr = extractJsonAfterMarker(html, 'ytInitialPlayerResponse');
    if (!jsonStr) {
      log('Transcript: could not locate ytInitialPlayerResponse in page', 'warn');
      return null;
    }
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      log(`Transcript: JSON.parse failed on extracted player response: ${e.message}`, 'error');
      return null;
    }
  }

  // YouTube now requires a Proof-of-Origin (PoToken) to download caption
  // tracks (signaled by exp=xpe/xpv in the track URL). Tools like yt-dlp
  // get these tokens by driving YouTube's own in-page "WebPoClient"
  // (BotGuard) - either re-running the interpreter in Node (BgUtils) or,
  // as in yt-dlp's getpot-wpc plugin, using the browser's already-loaded
  // client. A userscript is already inside the page, so it can use that
  // client directly instead of re-implementing the attestation challenge.
  //
  // The authoritative mapping (from the player's own base.js, fia()/Mm()):
  //   window[<name>].bevasrs.wpc()   where <name> is "havuokmhhs-0" under the
  //                                  bg_st_hr experiment, else
  //                                  "havuokmhhs-<floor(timeOrigin)>"
  // wpc() yields the raw client whose .mws({c: videoId, ...}) mints a
  // content-bound token (captions bind to the video id). base.js places the
  // holder on `window` when the frame is top, otherwise on `window.top` - so
  // both are checked.
  //
  // Returns the object that OWNS the wpc() method (not the bare function) so
  // the caller can invoke it as holder.wpc() with the correct `this` - it is
  // a method on the BotGuard object, and calling it detached breaks that
  // binding. Falls back to scanning every enumerable key, since YouTube
  // renames this global between releases.
  function locateWpcHolder(roots, knownNames) {
    for (const root of roots) {
      if (!root) continue;
      const names = [...knownNames, ...safeKeys(root).filter((k) => k.startsWith('havuokmhhs-'))];
      for (const name of names) {
        try {
          const holder = root[name]?.bevasrs;
          if (holder && typeof holder.wpc === 'function') return holder;
        } catch (e) {
          /* accessor that throws - skip */
        }
      }
    }
    for (const root of roots) {
      for (const key of safeKeys(root)) {
        try {
          const val = root[key];
          if (!val || typeof val !== 'object') continue;
          if (val.bevasrs && typeof val.bevasrs.wpc === 'function') return val.bevasrs;
          if (typeof val.wpc === 'function') return val;
        } catch (e) {
          /* accessor that throws - skip */
        }
      }
    }
    return null;
  }

  function safeKeys(obj) {
    try {
      return obj ? Object.keys(obj) : [];
    } catch (e) {
      return [];
    }
  }

  async function mintPoToken(videoId) {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const top = win.top || win;
    const timeOrigin = Math.floor(win.performance?.timeOrigin || 0);
    // Try BOTH names regardless of the experiment flag: the player reads
    // bg_st_hr from its own config (base.js fia()), which isn't guaranteed to
    // agree with ytcfg's copy - guessing wrong here is exactly what produces
    // "WebPoClient not found" while the client actually exists under the
    // other name.
    const knownNames = ['havuokmhhs-0', `havuokmhhs-${timeOrigin}`];
    const roots = win === top ? [win] : [win, top];

    // BotGuard is created lazily (the player sets up the container the first
    // time it needs a token), and its VM can take several seconds to attach
    // `.bevasrs`. Poll patiently before giving up.
    let holder = locateWpcHolder(roots, knownNames);
    for (let attempt = 0; attempt < 25 && !holder; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      holder = locateWpcHolder(roots, knownNames);
    }
    if (!holder) {
      log('PoToken: WebPoClient not found (checked both known names and scanned window + window.top)', 'warn');
      return null;
    }

    // The exact request shape the player itself uses (base.js gia()):
    // {c: videoId, mc: true, me: true, co: {c: videoId, a: true, s: true}}.
    // A couple of reduced shapes are retried too in case the client rejects
    // the newer one.
    const shapes = [
      { c: videoId, mc: true, me: true, co: { c: videoId, a: true, s: true } },
      { c: videoId, mc: true, me: true },
      { c: videoId }
    ];
    for (let attempt = 0; attempt < 10; attempt++) {
      let client;
      try {
        client = await holder.wpc(); // method call: keeps the correct `this`
      } catch (e) {
        if (String(e).includes('SDF:notready')) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        log(`PoToken: client acquisition failed: ${e && e.message ? e.message : e}`, 'warn');
        return null;
      }
      for (const args of shapes) {
        try {
          const token = await client.mws(args);
          if (token && typeof token === 'string' && token.length > 10) {
            log(`PoToken: minted content token for ${videoId} (${token.length} chars)`);
            return token;
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          if (msg.includes('SDF:notready')) {
            await new Promise((r) => setTimeout(r, 500));
            break; // break to outer retry
          }
          // try the next shape
        }
      }
    }
    log('PoToken: mint failed for all request shapes', 'warn');
    return null;
  }

  // Extract the /get_transcript endpoint params from the watch page HTML.
  // These params are session-bound (they embed the video id + caption
  // params) and are what YouTube's own "Show transcript" panel uses. As of
  // ~2026-09 this endpoint has started returning HTTP 400 "Precondition
  // check failed" for requests made outside the page's own attested player
  // session, so it is now only a best-effort first try; the PoToken +
  // timedtext path below is the reliable one.
  function extractGetTranscriptParams(html) {
    const m = html.match(/getTranscriptEndpoint":\{"params":"([^"]+)"/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  // Recursively pull transcript text out of a get_transcript response,
  // which nests transcriptSegmentRenderer entries under frameworkUpdates.
  function extractTranscriptText(data) {
    const texts = [];
    const seen = new Set();
    function walk(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.transcriptSegmentRenderer) {
        const seg = node.transcriptSegmentRenderer;
        const runs = seg.snippet && seg.snippet.runs;
        if (Array.isArray(runs)) {
          const t = runs.map((r) => (r && r.text ? r.text : '')).join('').replace(/\s+/g, ' ').trim();
          if (t) texts.push(t);
        } else if (seg.snippet && seg.snippet.simpleText) {
          texts.push(String(seg.snippet.simpleText).trim());
        }
      }
      for (const k of Object.keys(node)) walk(node[k]);
    }
    walk(data);
    return texts.length ? texts.join(' ') : null;
  }

  // Primary transcript path: YouTube's own /get_transcript endpoint.
  async function getTranscriptViaEndpoint(videoId, params) {
    if (!params) return null;
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const ytcfg = win.ytcfg;
    const apiKey = ytcfg?.get ? ytcfg.get('INNERTUBE_API_KEY') : undefined;
    if (!apiKey) return null;
    const clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION') || '2.20260817.01.00';
    const visitorData = ytcfg.get('VISITOR_DATA');

    const payload = {
      context: { client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion, visitorData } },
      params
    };

    let data = null;
    try {
      // Same-origin fetch so the user's session cookies are included (the
      // transcript panel request is made with the page's own credentials).
      const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': clientVersion
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        data = await res.json().catch(() => null);
      } else {
        log(`Transcript: get_transcript HTTP ${res.status}`, 'warn');
      }
    } catch (e) {
      log(`Transcript: get_transcript request failed: ${e.message}`, 'warn');
    }

    if (!data) return null;
    const text = extractTranscriptText(data);
    if (!text) {
      log(`Transcript: get_transcript returned data but no transcript text found (top-level: ${Object.keys(data).join(',')})`, 'warn');
      console.log('[vorsum] get_transcript response (first 2000 chars):', JSON.stringify(data).slice(0, 2000));
    }
    return text;
  }

  async function getTranscript(videoId) {
    // Fetch the watch page HTML once - it supplies both the get_transcript
    // endpoint params (best-effort first try) and the caption track list
    // (the PoToken path). Reused below to avoid a second fetch.
    let pageHtml = null;
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'same-origin' });
      if (res.ok) pageHtml = await res.text();
    } catch (e) {
      log(`Transcript: watch page fetch failed: ${e.message}`, 'warn');
    }

    // 1. Best-effort: YouTube's own /get_transcript endpoint (the "Show
    //    transcript" panel). Now frequently HTTP 400s outside the page's own
    //    attested session (see extractGetTranscriptParams), so treat it as an
    //    opportunistic fast path, not the dependable one.
    if (pageHtml) {
      const params = extractGetTranscriptParams(pageHtml);
      if (params) {
        const text = await getTranscriptViaEndpoint(videoId, params);
        if (text) {
          log(`Transcript: obtained ${text.length} chars via get_transcript endpoint`);
          if (text.length > MAX_TRANSCRIPT_CHARS) {
            log(`Transcript: truncated to ${MAX_TRANSCRIPT_CHARS} chars`);
            return text.slice(0, MAX_TRANSCRIPT_CHARS) + ' [transcript truncated]';
          }
          return text;
        }
        log('Transcript: get_transcript endpoint returned no text - falling back to caption tracks', 'warn');
      } else {
        log('Transcript: no get_transcript params found on page - falling back to caption tracks', 'warn');
      }
    }

    // 2. Token-free first: the ANDROID InnerTube client returns caption
    //    tracks whose URLs do NOT carry exp=xpe, so no PoToken/BotGuard is
    //    needed. Preferred because it works even where the modern player (and
    //    its WebPoClient) is absent - e.g. on Vorapis, which swaps in an
    //    older HTML5 player.
    let poToken = null;
    let playerResponse = await getPlayerResponseViaAndroid(videoId);
    let tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks || !tracks.length) {
      // 3. WEB player + watch-page HTML, with a BotGuard-minted PoToken.
      log('Transcript: ANDROID client had no caption tracks - trying WEB + PoToken', 'warn');
      poToken = await mintPoToken(videoId);
      playerResponse = await getPlayerResponseViaInnerTube(videoId, poToken);
      const innerTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if ((!playerResponse || !innerTracks || !innerTracks.length) && pageHtml) {
        log('Transcript: InnerTube response had no caption tracks - using watch-page HTML', 'warn');
        playerResponse = await getPlayerResponseViaWatchPage(videoId, pageHtml);
      }
      tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    }

    if (!playerResponse) {
      log('Transcript: could not obtain a player response via any method', 'error');
      return null;
    }

    if (!tracks || !tracks.length) {
      log('Transcript: no captionTracks in player response (video may have no captions)', 'warn');
      return null;
    }

    const track = tracks.find((t) => t.languageCode === 'en') || tracks[0];
    log(`Transcript: found ${tracks.length} track(s), using languageCode=${track.languageCode}`);

    // YouTube now requires a PoToken (proof-of-origin token) on caption
    // track URLs, signaled by an exp=xpe (or exp=xpv) parameter in the
    // baseUrl. Without a valid token the endpoint returns HTTP 200 with an
    // EMPTY body - not an error status. We can mint the token ourselves via
    // the page's own WebPoClient (see mintPoToken), so there's no need to
    // give up: mint one, append it, and the same URL that was empty becomes
    // the real transcript.
    const requiresPoToken = /[?&]exp=xp[ev](&|$)/.test(track.baseUrl);
    if (requiresPoToken && !poToken) {
      log('Transcript: caption track requires a PoToken but one could not be minted - falling back to URL mode is the reliable path for this video', 'warn');
    }

    // fmt=json3 is what YouTube's own player actually requests and is far
    // more robust to parse than the default XML/TTML response.
    let trackUrl = track.baseUrl.includes('fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
    if (requiresPoToken && poToken) {
      // Same params yt-dlp appends for subtitle PoTokens: the token itself,
      // potc=1, and the innertube client name (WEB).
      trackUrl = `${trackUrl}&pot=${encodeURIComponent(poToken)}&potc=1&c=WEB`;
    }

    const captionRes = await fetch(trackUrl, { credentials: 'same-origin' });
    const bodyText = await captionRes.text();
    log(
      `Transcript: caption fetch HTTP ${captionRes.status}, content-type=${captionRes.headers.get('content-type') || 'unknown'}, body length=${bodyText.length}`
    );

    if (!captionRes.ok) {
      throw new Error(
        `Caption track fetch failed: HTTP ${captionRes.status}${requiresPoToken ? ' (PoToken required)' : ' (likely blocked)'}`
      );
    }

    if (!bodyText.trim()) {
      // The PoToken failure mode: HTTP 200, empty body, nothing to throw on.
      // Even a freshly-minted token can come back empty if the session
      // binding didn't line up; that's the case to surface clearly.
      const reason = requiresPoToken
        ? `PoToken required by this track and the minted token was rejected (empty response) - try URL mode for this video.${poToken ? '' : ' (no token could be minted)'}`
        : 'YouTube returned an empty response with no clear reason (possibly a different anti-bot check) - try URL mode.';
      log(`Transcript: caption fetch returned an empty body. ${reason}`, 'warn');
      return null;
    }

    let transcript = '';
    try {
      const data = JSON.parse(bodyText);
      const events = data.events || [];
      transcript = events
        .flatMap((e) => e.segs || [])
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      log(`Transcript: parsed json3 format, ${events.length} event(s)`);
    } catch (e) {
      // Failed JSON.parse means the server ignored fmt=json3 and returned
      // XML. Two XML shapes are possible:
      //   - legacy timedtext:      <text ...>content</text>
      //   - timedtext format 3:    <p ...><s ...>word</s>...</p>
      // (format 3 is what the ANDROID client returns for auto-generated
      // tracks, so this branch matters for the token-free path.)
      if (/<p\b[^>]*>/.test(bodyText)) {
        log(`Transcript: response wasn't valid JSON (${e.message}), parsing timedtext format 3 (<p>/<s>)`, 'warn');
        const paragraphs = [...bodyText.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)];
        const parts = [];
        for (const para of paragraphs) {
          const words = [...para[1].matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/g)].map((m) => decodeEntities(m[1]));
          if (words.length) {
            parts.push(words.join(''));
          } else {
            // A few format-3 lines carry text directly in the <p> instead.
            const plain = decodeEntities(para[1].replace(/<[^>]+>/g, '')).trim();
            if (plain) parts.push(plain);
          }
        }
        transcript = parts.join(' ').replace(/\s+/g, ' ').trim();
      } else {
        log(`Transcript: response wasn't valid JSON (${e.message}), trying legacy XML (<text>) fallback`, 'warn');
        const lines = [...bodyText.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => decodeEntities(m[1]));
        transcript = lines.join(' ').replace(/\s+/g, ' ').trim();
      }
    }

    if (!transcript) {
      log('Transcript: parsed successfully but resulted in empty text - unusual; see console for the raw response', 'warn');
      console.log('[vorsum] raw caption response (first 500 chars):', bodyText.slice(0, 500));
      return null;
    }
    log(`Transcript: assembled ${transcript.length} chars`);

    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + ' [transcript truncated]';
      log(`Transcript: truncated to ${MAX_TRANSCRIPT_CHARS} chars`);
    }

    return transcript;
  }

  function extractVideoId(card) {
    const link = card.querySelector('a[href*="watch?v="]');
    if (!link) return null;
    try {
      const url = new URL(link.getAttribute('href'), location.origin);
      return url.searchParams.get('v');
    } catch (e) {
      return null;
    }
  }

  function extractVideoTitle(card) {
    // The watch-page path passes `document` as the card (the video IS the
    // page). On that path #video-title / .yt-lockup-title* / .title[title]
    // match sidebar "up next"/related videos, NOT the video being watched -
    // so those are only consulted for real grid cards. Getting this wrong is
    // what makes a History entry show a different video's title than the one
    // actually summarized (visible when Caption mode falls back to URL on a
    // watch page, and the recorded title belongs to a sidebar video).
    const isWatchPage = card === document;
    // NB: the card-only selectors use `isWatchPage ? null : …` rather than
    // `!isWatchPage && …` - the latter yields the boolean `false` when it
    // short-circuits, which then leaks into `el` and makes `el.getAttribute`
    // throw ("el.getAttribute is not a function") on pages where no
    // watch-title selector matches (e.g. embedded players).
    const el =
      card.querySelector('h1.ytd-watch-metadata yt-formatted-string') || // modern YouTube watch-page title
      card.querySelector('#eow-title') || // classic / Vorapis watch-page title
      card.querySelector('h1.watch-title') || // classic watch-page title
      card.querySelector('.watch-title') || // classic watch-page title
      card.querySelector('#watch-headline-title h1') || // classic watch-page title
      card.querySelector('a.yt-uix-sessionlink.spf-link[title]') || // Vorapis watch-page title link
      (isWatchPage ? null : card.querySelector('#video-title')) ||
      (isWatchPage ? null : card.querySelector('.yt-lockup-title a')) ||
      (isWatchPage ? null : card.querySelector('.yt-lockup-title')) ||
      (isWatchPage ? null : card.querySelector('.lohp-video-link')) || // homepage featured shelf
      (isWatchPage ? null : card.querySelector('.title[title]')) || // sidebar (grid) title span
      (isWatchPage ? null : card.querySelector('.ytLockupMetadataViewModelHeadingReset')) || // vanilla lockup card
      (isWatchPage ? null : card.querySelector('a[href*="watch?v="]'));
    let text = (el?.getAttribute('aria-label') || el?.getAttribute('title') || el?.textContent || '').trim();
    // On a watch page where none of the watch-title selectors matched (an
    // unfamiliar skin/DOM), the browser tab title ("Video Title - YouTube")
    // is still the current video - far better than silently saving a sidebar
    // video's title.
    if (!text && isWatchPage) {
      text = document.title.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim();
    }
    return text || null;
  }

  function extractChannelInfo(card) {
    const el =
      card.querySelector('.yt-lockup-byline a') ||
      card.querySelector('.yt-lockup-byline') ||
      card.querySelector('#channel-name a') ||
      card.querySelector('#channel-name') ||
      card.querySelector('a.yt-user-name') || // homepage featured shelf
      card.querySelector('.stat.attribution b') || // watch-page sidebar - plain text, no link
      card.querySelector('yt-formatted-string.ytd-channel-name a') || // modern watch-page
      card.querySelector('a.yt-uix-sessionlink.yt-user-name') || // Vorapis watch-page
      card.querySelector('a[href*="/@"]') ||
      card.querySelector('a[href*="/channel/"]');
    const name = (el?.textContent || '').trim() || null;
    const href = el?.tagName === 'A' ? el.getAttribute('href') : null;
    let url = null;
    if (href) {
      try {
        url = new URL(href, location.origin).href;
      } catch (e) {
        url = null;
      }
    }
    return { name, url };
  }

  // Where to append our button/panel within a card. The three layouts have
  // different shapes: the feed layout has a dedicated content wrapper, the
  // homepage shelf's card root IS the content block already (self-
  // contained: watch link, title, and channel link all live directly in
  // it), and the sidebar's <li> has no such wrapper at all. Falling through
  // to `card` itself handles both of the latter correctly, which is why
  // this one helper covers all three instead of hardcoding a single class.
  function getContentArea(card) {
    return card.querySelector('.yt-lockup-content') || card.querySelector('.yt-lockup-byline')?.parentElement || card;
  }

  // Relative time for the first day (so "just now" / "5m ago" / "3h ago"
  // stay immediately meaningful), then an absolute date after that - "8d
  // ago" and especially "24d ago" stop being useful at a glance once
  // History has been in use a while, and a calendar date is easier to
  // place. Same year shows as M/D; a prior year includes the year too, so
  // an old entry doesn't read as if it happened a few months ago.
  function relativeTime(ts) {
    const diffMs = Date.now() - ts;
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const d = new Date(ts);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric', year: 'numeric' });
  }

  // ---- Control widget (mode toggle + debug + history + minimize) ----
  let historyListEl = null;
  let historyOffset = 0;
  let historySearchQuery = '';
  let loadHistoryRef = null; // set inside buildWidget - lets outer-scope handlers (cache warning) refresh an open History list
  let revealNewestHistoryRef = null; // set inside buildWidget - refresh History and expand its newest summary

  // "N new - (re)open to view" notice state. Deliberately not auto-updating
  // the rendered list when new entries land (even if History is currently
  // open) - the list only refreshes when the person explicitly opens/
  // reopens it, so it doesn't shift under them while they're mid-read.
  let historyPanelOpen = false;
  let pendingNewHistoryCount = 0;
  let historyNoticeEl = null;

  // Cross-tab sync: IndexedDB is already a single shared database across
  // every youtube.com tab, so a tab that opens History later sees new
  // entries with no extra plumbing. The ONLY thing that doesn't cross tab
  // boundaries on its own is the in-memory notice counter - each tab has
  // its own separate JS context/module scope. BroadcastChannel bridges just
  // that: same-origin, no server, no special grant. A tab that generates a
  // new entry both updates its own notice AND posts on the channel; a tab
  // that only *receives* a broadcast updates its notice but does not
  // re-broadcast (fromRemote=true below), which is what keeps this from
  // becoming an infinite echo between tabs.
  const historyChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vorsum-history-v1') : null;
  if (historyChannel) {
    historyChannel.onmessage = (event) => {
      if (event?.data?.type === 'new-entry') {
        log('History: new-entry notice received from another tab');
        // Keep this tab's sync "Saved" index in step with the other tab.
        const { videoId, mode } = event.data;
        if (videoId && mode) savedSummaryIndex.add(savedSummaryId(videoId, mode));
        else loadSavedSummaryIndex();
        notifyNewHistoryEntry(true);
      }
    };
  } else {
    log('BroadcastChannel unavailable - History notice will only work within this tab', 'warn');
  }

  function notifyNewHistoryEntry(fromRemote = false, info = null) {
    pendingNewHistoryCount++;
    renderHistoryNotice();
    if (!fromRemote && historyChannel) {
      try {
        historyChannel.postMessage({ type: 'new-entry', videoId: info?.videoId, mode: info?.mode });
      } catch (e) {
        log(`BroadcastChannel postMessage failed: ${e.message}`, 'warn');
      }
    }
    if (!fromRemote) checkCacheThreshold(); // only the tab that actually grew the cache needs to check
    // Exactly one new summary while the full UI (History) is open: also show
    // that newest summary rather than only the yellow notice bar.
    if (historyPanelOpen && pendingNewHistoryCount === 1) revealNewestHistoryRef?.();
  }

  function renderHistoryNotice() {
    // Collapsed floating dot: show an "N new ✉" badge when there are unread
    // entries (the in-panel yellow bar covers the expanded case).
    if (widgetDotBadgeEl) {
      if (pendingNewHistoryCount > 0 && getWidgetCollapsed()) {
        widgetDotBadgeEl.textContent = `${pendingNewHistoryCount} new \u2709`;
        widgetDotBadgeEl.style.display = 'block';
      } else {
        widgetDotBadgeEl.style.display = 'none';
      }
    }
    if (!historyNoticeEl) return;
    if (pendingNewHistoryCount <= 0) {
      historyNoticeEl.style.display = 'none';
      return;
    }
    const verb = historyPanelOpen ? 'reopen' : 'open';
    const plural = pendingNewHistoryCount === 1 ? '' : 's';
    historyNoticeEl.textContent = `${pendingNewHistoryCount} new summar${plural === '' ? 'y' : 'ies'} - ${verb} to view`;
    historyNoticeEl.style.display = 'block';
  }

  // ---- Interrupted-summary resume queue ----
  // A summary request is owned by the tab that started it, so closing that tab
  // mid-request drops the result. To avoid losing it entirely, the job is
  // recorded here when it starts and cleared when it concludes (success or a
  // definitive give-up). On a later page load any leftover job is re-run; its
  // result lands in History and is announced via the notice/badge rather than
  // an overlay. This is also the natural seam for moving the work into an
  // extension background context later.
  const PENDING_JOBS_KEY = 'vorsum_pending_jobs';
  function getPendingJobs() {
    const raw = GM_getValue(PENDING_JOBS_KEY, []);
    return Array.isArray(raw) ? raw : [];
  }
  function addPendingJob(videoId, mode) {
    const id = `${mode}_${videoId}`;
    const jobs = getPendingJobs();
    if (jobs.some((j) => j.id === id)) return;
    jobs.push({ id, videoId, mode, startedAt: Date.now() });
    GM_setValue(PENDING_JOBS_KEY, jobs);
    log(`Pending jobs: started ${id} (${jobs.length} in progress)`);
  }
  function clearPendingJob(videoId, mode) {
    const id = `${mode}_${videoId}`;
    const jobs = getPendingJobs();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length !== jobs.length) {
      GM_setValue(PENDING_JOBS_KEY, next);
      log(`Pending jobs: finished ${id} (${next.length} in progress)`);
    }
  }

  // Re-runs summaries that were interrupted (usually a tab closed mid-request).
  async function resumePendingJobs() {
    const jobs = getPendingJobs();
    if (!jobs.length) return;
    log(`Pending jobs: found ${jobs.length} unfinished summar${jobs.length === 1 ? 'y' : 'ies'} - resuming`);
    for (const job of jobs) {
      // If it actually completed before the tab died (result landed but the
      // clear didn't), don't redo the work.
      if (await getCachedSummary(job.videoId, job.mode)) {
        clearPendingJob(job.videoId, job.mode);
        continue;
      }
      // When Web Locks is available, handleClick acquires the job's lock with
      // ifAvailable, so a live job in another tab is skipped automatically.
      // Without locks, fall back to a staleness check: only resume once the
      // originator's request would have timed out, so a fresh job isn't redone.
      const locksAvailable =
        typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
      if (!locksAvailable) {
        const staleAfter = (TIMEOUT_MS[job.mode] || 180000) + 30000;
        if (Date.now() - (job.startedAt || 0) < staleAfter) {
          log(`Pending jobs: ${job.id} is recent and Web Locks is unavailable - leaving it to the tab that started it`);
          continue;
        }
      }
      // Detached button + card: handleClick sees the button as off-screen (so
      // the result is saved to History and announced via the notice/badge, not
      // an overlay), and the empty card makes the recorded title fall back to
      // the video id rather than this page's title.
      const ghostBtn = document.createElement('button');
      ghostBtn.className = 'vorsum-btn';
      ghostBtn.dataset.vorsumVideoId = job.videoId;
      ghostBtn.textContent = '\u2211';
      const ghostCard = document.createElement('div');
      log(`Pending jobs: resuming ${job.id}`);
      try {
        await handleClick(job.videoId, ghostCard, ghostBtn, 1, job.mode);
      } catch (e) {
        log(`Pending jobs: resume failed for ${job.id}: ${e.message}`, 'error');
      }
    }
  }

  // ---- Generic small modal (Data & Privacy, Stats & Data) ----
  // Deliberately separate from showOnboarding()'s modal below: onboarding
  // has its own one-time/replay semantics and Vorapis-detection logic that
  // don't apply here, and reusing it as-is risked tangling the two. This
  // one guards against stacking (one flag, shared across callers) but is
  // otherwise a plain "title + body + Close" shell either caller fills in.
  let anySimpleModalOpen = false;
  function showSimpleModal(title, fillBody) {
    if (anySimpleModalOpen) return;
    anySimpleModalOpen = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'vorsum-modal-backdrop';
    backdrop.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px';

    const modal = document.createElement('div');
    modal.className = 'vorsum-modal';
    modal.style.cssText =
      'max-width:440px;width:100%;max-height:80vh;overflow-y:auto;border-width:1px;border-style:solid;border-radius:6px;padding:16px;font-family:sans-serif;font-size:13px;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,0.35)';

    const heading = document.createElement('h2');
    heading.textContent = title;
    heading.style.cssText = 'margin:0 0 10px;font-size:15px';

    const body = document.createElement('div');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'vorsum-ctrl-btn';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText =
      'margin-top:12px;padding:6px 14px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important';

    function close() {
      backdrop.remove();
      anySimpleModalOpen = false;
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    modal.appendChild(heading);
    modal.appendChild(body);
    modal.appendChild(closeBtn);
    backdrop.appendChild(modal);
    document.documentElement.appendChild(backdrop);
    registerThemedSubtree(backdrop);

    fillBody(body); // may be async - body is already in the DOM, safe to mutate later
  }

  function addModalParagraph(body, text) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 10px';
    p.textContent = text;
    body.appendChild(p);
    return p;
  }

  function showApiKeyHelpModal() {
    showSimpleModal('How LLM API keys work', (body) => {
      addModalParagraph(
        body,
        "An API key is just a password that lets a piece of software (like this one) make requests to an AI company's servers on your behalf, instead of you typing into their website. You get one by making a free account on the provider's site, then paste it into vorsum - it's stored only on your own machine and sent only to that provider, never anywhere else."
      );
      addModalParagraph(
        body,
        "Most providers bill per request, but usage here is tiny (a few sentences of text in, a few sentences out) - nowhere near enough to run up a real bill for casual use. Some providers, including Google Gemini, offer a genuinely free tier with no card required, which comfortably covers exactly this kind of lightweight, occasional use."
      );
      // Built by hand (not addModalParagraph) because it embeds a real
      // hyperlink - that helper sets textContent, which would flatten it.
      const geminiSteps = document.createElement('p');
      geminiSteps.style.cssText = 'margin:0 0 10px';
      const aiStudioLink = document.createElement('a');
      aiStudioLink.href = 'https://aistudio.google.com';
      aiStudioLink.target = '_blank';
      aiStudioLink.rel = 'noopener noreferrer';
      aiStudioLink.textContent = 'aistudio.google.com';
      aiStudioLink.className = 'vorsum-history-title'; // reuse the themed link color
      aiStudioLink.style.cssText = 'text-decoration:underline';
      registerThemedEl(aiStudioLink); // added after showSimpleModal's theme sweep
      geminiSteps.append(
        "If you've never done this before: Gemini is the easiest starting point. Go to ",
        aiStudioLink,
        ", sign in with a Google account, click 'Get API key' at top right, copy the string it gives you, and paste it into Vorsum's Gemini API key field in the Options menu. There are no payment details needed for the free tier!"
      );
      body.appendChild(geminiSteps);
      addModalParagraph(
        body,
        "Claude and OpenAI-compatible providers work the same way in principle (make an account, generate a key, paste it in) but typically require billing to be set up first, even if actual usage stays cheap. A local server (Ollama, LM Studio) needs no key or account at all - everything runs on your own machine."
      );
    });
  }

  function showDataDesignModal() {

    showSimpleModal('Data & Privacy', async (body) => {
      addModalParagraph(
        body,
        "Your Gemini API key is stored locally by your userscript manager (Tampermonkey/Violentmonkey), never anywhere else. It's sent only directly to Google's Gemini API over HTTPS, only when you click Summarize or Test."
      );
      addModalParagraph(
        body,
        'Generated summaries are cached locally in your browser\'s IndexedDB (a searchable History log that also holds the title, channel, and timestamp for each one), so re-clicking Summarize on a video you already summarized is instant.'
      );
      addModalParagraph(
        body,
        'Nothing runs in the background. A network request only ever happens when you click Summarize, Test, or (once) when checking a cached transcript - every single one is logged in Options → Debugging, so you can see exactly what was sent and when.'
      );
      addModalParagraph(body, 'This script is open-source - read it, change it, or verify any of the above yourself.');

      addModalParagraph(
        body,
        'Caption mode can now be pointed at Gemini, Claude, or an OpenAI-compatible endpoint (including a fully local server like Ollama or LM Studio, running entirely on your own machine). Whichever you pick, only the transcript text and your prompt leave your browser - and only to the endpoint you configured, sent only when you click Summarize or Test.'
      );
      addModalParagraph(
        body,
        'Energy and ownership, honestly: URL mode asks Gemini to process the actual video (frames plus audio), which is inherently a heavier request than passing plain transcript text - roughly the same tradeoff as watching something versus reading a transcript of it. Caption mode is comparatively light regardless of which provider you point it at. A local model shifts that compute (and its power draw) onto your own hardware, visible and entirely under your control, with nothing sent to any company at all; a cloud provider runs it on their infrastructure, under their own stated policies. Precise energy-per-request figures vary by provider, model, and hardware and aren\'t something this script can measure or claim - this is meant as an honest description of the tradeoff, not a specific number.'
      );

      const sizeLine = addModalParagraph(body, 'Loading cache size...');
      try {
        const info = await getCacheSizeInfo();
        sizeLine.textContent = `Currently storing ${info.historyCount} summar${info.historyCount === 1 ? 'y' : 'ies'} in History (${formatBytes(info.totalBytes)} total).`;
      } catch (e) {
        sizeLine.textContent = 'Could not read cache size right now - see Debugging log.';
      }
    });
  }

  function showHistoryStatsModal() {
    showSimpleModal('Stats & Data', async (body) => {
      const loading = addModalParagraph(body, 'Loading...');
      try {
        const info = await getCacheSizeInfo();
        const byMode = info.entries.reduce((acc, e) => {
          acc[codeToModeLabel(e.mode)] = (acc[codeToModeLabel(e.mode)] || 0) + 1;
          return acc;
        }, {});
        const modeSummary = Object.entries(byMode)
          .map(([m, c]) => `${m} (${c})`)
          .join(', ');
        loading.remove();
        addModalParagraph(body, `Total summaries: ${info.historyCount}`);
        addModalParagraph(body, `By mode: ${modeSummary || '—'}`);
        addModalParagraph(body, `Local cache size: ${formatBytes(info.totalBytes)}`);
        if (info.entries.length) {
          const oldest = Math.min(...info.entries.map((e) => e.createdAt));
          const newest = Math.max(...info.entries.map((e) => e.createdAt));
          addModalParagraph(body, `Oldest: ${new Date(oldest).toLocaleDateString()}`);
          addModalParagraph(body, `Newest: ${new Date(newest).toLocaleDateString()}`);
        }
      } catch (e) {
        loading.textContent = 'Could not load stats - see Debugging log.';
      }

      // Export / clear block, moved here from the History panel so the
      // History list itself stays compact. These buttons are created AFTER
      // the modal's own registerThemedSubtree sweep (showSimpleModal runs it
      // before fillBody), so register this row explicitly - otherwise the
      // themed colors never get stamped on and they'd render unstyled.
      const exportHeader = document.createElement('div');
      exportHeader.textContent = 'Export data:';
      exportHeader.style.cssText = 'margin:14px 0 6px;font-weight:bold';

      const exportBtnStyle =
        'flex:1;padding:5px 8px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important;text-align:center';

      const exportRow = document.createElement('div');
      exportRow.style.cssText = 'display:flex;gap:6px';

      const exportJsonBtn = document.createElement('button');
      exportJsonBtn.className = 'vorsum-ctrl-btn';
      exportJsonBtn.textContent = 'Export JSON';
      exportJsonBtn.style.cssText = exportBtnStyle;
      exportJsonBtn.addEventListener('click', () => exportHistory('json'));

      const exportCsvBtn = document.createElement('button');
      exportCsvBtn.className = 'vorsum-ctrl-btn';
      exportCsvBtn.textContent = 'Export CSV';
      exportCsvBtn.style.cssText = exportBtnStyle;
      exportCsvBtn.addEventListener('click', () => exportHistory('csv'));

      const clearHistoryBtn = document.createElement('button');
      clearHistoryBtn.className = 'vorsum-ctrl-btn vorsum-danger-btn';
      clearHistoryBtn.textContent = 'Clear all history';
      clearHistoryBtn.style.cssText = exportBtnStyle;
      clearHistoryBtn.addEventListener('click', async () => {
        if (!confirm('Delete all vorsum summary history? This cannot be undone.')) return;
        await historyClearAll();
        refreshAllButtonCachedVisuals();
        if (historyListEl) historyListEl.replaceChildren();
        log('History: cleared all entries', 'warn');
        loadHistoryRef?.(true); // refresh an open History list, if there is one
      });

      exportRow.appendChild(exportJsonBtn);
      exportRow.appendChild(exportCsvBtn);
      exportRow.appendChild(clearHistoryBtn);

      body.appendChild(exportHeader);
      body.appendChild(exportRow);
      registerThemedSubtree(exportRow);
    });
  }

  function showDeveloperContactModal() {
    showSimpleModal('Developer Contact', (body) => {
      addModalParagraph(body, 'Got questions, comments, feedback? Feel free to reach out to the developer.');

      const linkStyle = 'text-decoration:underline';

      const emailP = document.createElement('p');
      emailP.style.cssText = 'margin:0 0 10px';
      emailP.appendChild(document.createTextNode('Email: '));
      const emailLink = document.createElement('a');
      emailLink.href = 'mailto:oriyion@gmail.com';
      emailLink.textContent = 'oriyion@gmail.com';
      emailLink.className = 'vorsum-history-title'; // reuse the themed link color
      emailLink.style.cssText = linkStyle;
      registerThemedEl(emailLink);
      emailP.appendChild(emailLink);
      body.appendChild(emailP);

      const ghP = document.createElement('p');
      ghP.style.cssText = 'margin:0 0 10px';
      ghP.appendChild(document.createTextNode('GitHub: '));
      const ghLink = document.createElement('a');
      ghLink.href = 'https://github.com/PipettingBeaver/Vorsum';
      ghLink.target = '_blank';
      ghLink.rel = 'noopener noreferrer';
      ghLink.textContent = 'https://github.com/PipettingBeaver/Vorsum';
      ghLink.className = 'vorsum-history-title';
      ghLink.style.cssText = linkStyle;
      registerThemedEl(ghLink);
      ghP.appendChild(ghLink);
      body.appendChild(ghP);
    });
  }

  // ---- Bug report form ----
  // Auto-fills the environment details a maintainer always ends up asking
  // for (browser, manager, version, mode/provider, debug log), leaves the two
  // "your words" fields free-form, then compiles everything into one
  // copyable block for a GitHub issue.
  function getBrowserInfoString() {
    const ua = navigator.userAgent || '';
    let friendly = 'Unknown browser';
    let m;
    if ((m = ua.match(/Firefox\/([\d.]+)/))) friendly = `Firefox ${m[1]}`;
    else if ((m = ua.match(/Edg\/([\d.]+)/))) friendly = `Edge ${m[1]}`;
    else if ((m = ua.match(/OPR\/([\d.]+)/))) friendly = `Opera ${m[1]}`;
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) friendly = `Chrome ${m[1]}`;
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) friendly = `Safari ${m[1]}`;
    const platform = navigator.platform ? ` on ${navigator.platform}` : '';
    return `${friendly}${platform} (UA: ${ua})`;
  }

  function getUserscriptManagerString() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info) {
        const handler = GM_info.scriptHandler || 'unknown manager';
        const ver = GM_info.version || '?';
        return `${handler} ${ver}`;
      }
    } catch (e) {
      /* fall through */
    }
    return 'Unknown userscript manager (GM_info unavailable)';
  }

  function getModeProviderString() {
    const mode = getMode() === 'url' ? 'URL (Gemini watches the video)' : 'Caption (transcript-based)';
    const providerKey = getLlmProvider();
    const providerLabel = LLM_PROVIDERS[providerKey]?.label || providerKey;
    return `Mode: ${mode} | Caption-mode API provider: ${providerLabel}`;
  }

  function buildBugReportText(f, maxLen = Infinity) {
    const val = (k) => (f[k] && f[k].value ? f[k].value.trim() : '');
    let text = [
      'Vorsum bug report',
      '=================',
      `Vorsum version: ${getVersion()}`,
      `Browser: ${val('browser')}`,
      `Userscript manager: ${val('manager')}`,
      `Mode / API provider: ${val('mode')}`,
      `Page URL: ${val('pageUrl') || location.href}`,
      '',
      'What happened:',
      val('problem') || '(not provided)',
      '',
      'Steps to reproduce:',
      val('steps') || '(not provided)',
      '',
      'Debug log:',
      val('log') || '(debug log empty - turn on Debug: ON in Options → Troubleshooting)',
      ''
    ].join('\n');
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + '\n... [truncated - use "Copy to Clipboard" for the full log]';
    }
    return text;
  }

  // GitHub's new-issue page accepts title/body query params, so the issue can
  // be opened pre-filled. Bodies can get long (the debug log especially), so
  // the URL-embedded copy is capped - "Copy to Clipboard" always carries the
  // full text for pasting in manually.
  const BUG_REPORT_URL_MAX_CHARS = 5000;

  function openBugReportIssue(f) {
    const firstLine = (f.problem?.value || '').trim().split('\n')[0].slice(0, 80);
    const title = firstLine ? `Bug: ${firstLine}` : 'Vorsum bug report';
    const issueBody = buildBugReportText(f, BUG_REPORT_URL_MAX_CHARS);
    const url =
      'https://github.com/PipettingBeaver/Vorsum/issues/new' +
      `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(issueBody)}`;
    window.open(url, '_blank');
  }

  // Anonymous submission via Web3Forms - a small form-to-email relay.
  const WEB3FORMS_ACCESS_KEY = 'e5918087-2e4e-416b-bba2-c12f5475a606'; // Web3Forms form access key
  const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';

  // Once a report has actually been sent anonymously, don't allow sending
  // again until the page is reloaded - avoids accidental duplicate emails.
  let bugReportSubmitted = false;

  // Mirrors openBugReportIssue (same compiled report), but POSTs it straight
  // to the developer's inbox instead of opening GitHub - for people without a
  // GitHub account. Uses GM_xmlhttpRequest rather than fetch so the request
  // isn't subject to YouTube's page CSP / CORS. onStatus(text, state) where
  // state is 'sending' | 'success' | 'error'.
  function submitBugReportAnonymously(f, onStatus) {
    if (bugReportSubmitted) return;
    if (!WEB3FORMS_ACCESS_KEY) {
      onStatus('⚠ Anonymous submission is not configured yet (access key missing).', 'error');
      return;
    }
    const report = buildBugReportText(f);
    const firstLine = (f.problem?.value || '').trim().split('\n')[0].slice(0, 80);
    const subject = firstLine ? `Vorsum bug report: ${firstLine}` : 'Vorsum bug report';

    const form = new URLSearchParams();
    form.set('access_key', WEB3FORMS_ACCESS_KEY);
    form.set('subject', subject);
    form.set('from_name', 'Vorsum bug report (anonymous)');
    form.set('message', report);
    form.set('botcheck', '');

    onStatus('Sending…', 'sending');
    GM_xmlhttpRequest({
      method: 'POST',
      url: WEB3FORMS_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeout: 20000,
      data: form.toString(),
      onload: (res) => {
        let ok = res.status >= 200 && res.status < 300;
        let msg = '';
        try {
          const data = JSON.parse(res.responseText);
          if (data && typeof data.success === 'boolean') ok = ok && data.success;
          msg = (data && data.message) || '';
        } catch (e) {
          /* non-JSON response - rely on the HTTP status */
        }
        if (ok) {
          bugReportSubmitted = true;
          log('Bug report: anonymous submission sent via Web3Forms');
          onStatus('✓ Sent. Thank you - the developer will see your report.', 'success');
        } else {
          log(`Bug report: anonymous submission failed (HTTP ${res.status}) ${msg}`, 'warn');
          onStatus(`⚠ Send failed: ${msg || `HTTP ${res.status}`}`, 'error');
        }
      },
      onerror: () => {
        log('Bug report: anonymous submission network error', 'warn');
        onStatus('⚠ Send failed: network error.', 'error');
      },
      ontimeout: () => {
        log('Bug report: anonymous submission timed out', 'warn');
        onStatus('⚠ Send failed: timed out.', 'error');
      }
    });
  }

  function showBugReportModal() {
    showSimpleModal('Set up bug report', (body) => {
      addModalParagraph(
        body,
        'Found a bug? It happens. This page opens a formatted information ticket for the developer to use as reference. Please write a short description of the issue, steps to reproduce (if possible), and click "Submit Anonymously".'
      );

      const fieldEls = {};

      function field(parent, labelText, key, { value = '', placeholder = '', rows = 4, refresh = null, mono = false } = {}) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom:10px';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px';
        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = 'flex:1;font-size:12px;font-weight:bold';
        header.appendChild(label);

        const input = document.createElement('textarea');
        input.rows = rows;
        input.className = 'vorsum-textarea';
        input.style.cssText =
          'width:100%;font-size:12px !important;padding:4px 5px;border-width:1px;border-style:solid;border-radius:3px;resize:vertical' +
          (mono ? ';font-family:monospace' : '');
        input.value = value;
        if (placeholder) input.placeholder = placeholder;

        if (refresh) {
          const refreshBtn = document.createElement('button');
          refreshBtn.className = 'vorsum-ctrl-btn';
          refreshBtn.textContent = 'Refresh';
          refreshBtn.style.cssText =
            'padding:2px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important';
          refreshBtn.addEventListener('click', () => {
            input.value = refresh();
          });
          header.appendChild(refreshBtn);
        }

        wrap.appendChild(header);
        wrap.appendChild(input);
        parent.appendChild(wrap);
        fieldEls[key] = input;
        return input;
      }

      // -- Top: the report itself --
      field(body, 'What happened?', 'problem', {
        rows: 4,
        placeholder: 'Describe the issue - e.g. "Clicking Summarize did nothing", plus any error text shown.'
      });
      field(body, 'Steps to reproduce', 'steps', {
        rows: 4,
        placeholder: 'e.g. 1) Opened a video 2) Clicked Σ 3) ...'
      });

      // -- Action buttons --
      const actionRow = document.createElement('div');
      actionRow.style.cssText = 'display:flex;gap:6px;margin:2px 0 4px';
      const openBtn = document.createElement('button');
      openBtn.className = 'vorsum-ctrl-btn';
      openBtn.textContent = 'Open GitHub Issue';
      openBtn.style.cssText =
        'flex:1;padding:7px 8px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important';
      openBtn.addEventListener('click', () => openBugReportIssue(fieldEls));

      const copyBtn = document.createElement('button');
      copyBtn.className = 'vorsum-ctrl-btn';
      copyBtn.textContent = 'Copy to Clipboard';
      copyBtn.style.cssText = openBtn.style.cssText;
      copyBtn.addEventListener('click', async () => {
        const text = buildBugReportText(fieldEls);
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => (copyBtn.textContent = 'Copy to Clipboard'), 1500);
        } catch (e) {
          // Clipboard API blocked - surface the text so it can be copied by hand.
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText =
            'width:100%;margin-top:8px;font-size:11px !important;font-family:monospace;padding:6px;border-width:1px;border-style:solid;border-radius:3px';
          body.appendChild(ta);
          ta.focus();
          ta.select();
          copyBtn.textContent = 'Select + copy below';
          setTimeout(() => (copyBtn.textContent = 'Copy to Clipboard'), 2500);
        }
      });

      actionRow.appendChild(openBtn);
      actionRow.appendChild(copyBtn);
      body.appendChild(actionRow);

      // -- Anonymous submission (no GitHub account needed) --
      const anonBtn = document.createElement('button');
      anonBtn.className = 'vorsum-ctrl-btn';
      anonBtn.textContent = 'Submit Anonymously';
      anonBtn.title = 'Emails this report straight to the developer - no GitHub account required';
      anonBtn.style.cssText =
        'width:100%;padding:7px 8px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important;margin-bottom:4px';

      const anonStatus = document.createElement('div');
      anonStatus.className = 'vorsum-label';
      anonStatus.style.cssText = 'display:none;font-size:11px !important;margin-bottom:6px;line-height:1.3';

      // "Finished" look for the one-shot anonymous send: green + disabled so
      // it can't fire again (per window) once a report has gone through.
      function markAnonSent() {
        anonBtn.disabled = true;
        anonBtn.textContent = '✓ Sent';
        anonBtn.title = 'Already sent in this window - reload the page to send another';
        anonBtn.style.setProperty('background', '#2e7d32', 'important');
        anonBtn.style.setProperty('color', '#ffffff', 'important');
        anonBtn.style.setProperty('border-color', '#2e7d32', 'important');
        anonBtn.style.setProperty('cursor', 'default', 'important');
        anonBtn.style.setProperty('opacity', '0.75', 'important');
      }

      anonBtn.addEventListener('click', () => {
        if (bugReportSubmitted) return;
        anonStatus.style.display = 'block';
        submitBugReportAnonymously(fieldEls, (text, state) => {
          anonStatus.textContent = text;
          if (state === 'success') markAnonSent();
        });
      });

      // If a report was already sent earlier in this page's lifetime,
      // reopen straight into the finished state.
      if (bugReportSubmitted) {
        anonStatus.style.display = 'block';
        anonStatus.textContent = '✓ Sent. Thank you - the developer will see your report.';
        markAnonSent();
      }

      body.appendChild(anonBtn);
      body.appendChild(anonStatus);

      // -- Bottom: collapsible auto-populated telemetry --
      const detailsBodyId = `vorsum-bug-details-${Math.random().toString(36).slice(2, 8)}`;
      const detailsToggle = document.createElement('button');
      detailsToggle.type = 'button';
      detailsToggle.className = 'vorsum-ctrl-btn';
      detailsToggle.textContent = '▸ Auto-populated details (browser, manager, mode, page URL, debug log)';
      detailsToggle.style.cssText =
        'width:100%;padding:5px 8px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:11px !important;text-align:left;opacity:0.65';
      detailsToggle.setAttribute('aria-expanded', 'false');
      detailsToggle.setAttribute('aria-controls', detailsBodyId);
      const detailsBody = document.createElement('div');
      detailsBody.id = detailsBodyId;
      detailsBody.style.cssText = 'display:none;margin-top:8px';
      detailsToggle.addEventListener('click', () => {
        const showing = detailsBody.style.display !== 'none';
        detailsBody.style.display = showing ? 'none' : 'block';
        detailsToggle.setAttribute('aria-expanded', String(!showing));
        detailsToggle.textContent = `${showing ? '▸' : '▾'} Auto-populated details (browser, manager, mode, page URL, debug log)`;
      });
      body.appendChild(detailsToggle);
      body.appendChild(detailsBody);

      field(detailsBody, 'Browser and version', 'browser', {
        rows: 2,
        value: getBrowserInfoString(),
        refresh: getBrowserInfoString
      });
      field(detailsBody, 'Userscript manager and version', 'manager', {
        rows: 2,
        value: getUserscriptManagerString(),
        refresh: getUserscriptManagerString
      });
      field(detailsBody, 'Mode and API provider', 'mode', {
        rows: 2,
        value: getModeProviderString(),
        refresh: getModeProviderString
      });
      field(detailsBody, 'Page URL', 'pageUrl', { rows: 1, value: location.href });
      field(detailsBody, 'Debug log (Options → Troubleshooting → Debug: ON)', 'log', {
        rows: 8,
        value: formatMergedLog(),
        refresh: () => formatMergedLog(),
        mono: true
      });

      // Built after showSimpleModal's own theme sweep, so register explicitly.
      registerThemedSubtree(body);
    });
  }

  // ---- Cache size threshold warning ----
  const CACHE_WARN_VIDEO_COUNT = 200;
  const CACHE_WARN_BYTES = 3 * 1024 * 1024; // ~3MB
  let cacheWarningNoticeEl = null;

  async function checkCacheThreshold() {
    let info;
    try {
      info = await getCacheSizeInfo();
    } catch (e) {
      return;
    }
    const overCount = info.historyCount >= CACHE_WARN_VIDEO_COUNT;
    const overBytes = info.totalBytes >= CACHE_WARN_BYTES;
    if (!overCount && !overBytes) return;

    // Re-warn only once it's grown meaningfully further, not on every single
    // new summary once the threshold's been crossed once.
    const lastWarnedCount = GM_getValue('vorsum_cache_warn_last_count', 0);
    if (info.historyCount < lastWarnedCount + 50) return;

    GM_setValue('vorsum_cache_warn_last_count', info.historyCount);
    showCacheWarningNotice(info);
  }

  function showCacheWarningNotice(info) {
    if (!cacheWarningNoticeEl) return;
    cacheWarningNoticeEl.replaceChildren();

    const msg = document.createElement('div');
    msg.textContent = `Cache threshold reached (${info.historyCount} summaries, ${formatBytes(info.totalBytes)}). Consider exporting your summaries or clearing older entries.`;
    msg.style.cssText = 'margin-bottom:4px';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:4px';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'vorsum-ctrl-btn';
    exportBtn.textContent = 'Export JSON';
    exportBtn.style.cssText =
      'flex:1;padding:2px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;text-align:center';
    exportBtn.addEventListener('click', () => exportHistory('json'));

    const clearOldestBtn = document.createElement('button');
    clearOldestBtn.className = 'vorsum-ctrl-btn';
    clearOldestBtn.textContent = 'Clear Oldest 50';
    clearOldestBtn.style.cssText = exportBtn.style.cssText;
    clearOldestBtn.addEventListener('click', async () => {
      const deleted = await historyDeleteOldest(50);
      refreshAllButtonCachedVisuals(); // History is the source of truth; index already updated
      log(`Cache: cleared ${deleted.length} oldest history entries`);
      cacheWarningNoticeEl.style.display = 'none';
      if (historyPanelOpen) loadHistoryRef?.(true);
    });

    btnRow.appendChild(exportBtn);
    btnRow.appendChild(clearOldestBtn);
    cacheWarningNoticeEl.appendChild(msg);
    cacheWarningNoticeEl.appendChild(btnRow);
    cacheWarningNoticeEl.style.display = 'block';
    registerThemedSubtree(cacheWarningNoticeEl);
  }

  // ---- API rate limit / quota handling ----
  const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min - a quota error won't clear in seconds, so stop hammering it
  let rateLimitedUntil = 0;
  let rateLimitNoticeEl = null;

  // When URL mode is rejected by the API with a 403 permission error (the
  // video-URI input isn't allowed for the account/key), we fall back to
  // caption mode on that same click. This flag stops an infinite
  // URL -> caption -> URL loop if captions are also unavailable/blocked:
  // once URL mode has been tried and 403'd, don't bounce BACK to it from a
  // failed caption fetch. Reset on each fresh (user-initiated) click.
  let urlModePermissionRejected = false;

  function isRateLimited() {
    return Date.now() < rateLimitedUntil;
  }

  function renderRateLimitNotice() {
    if (!rateLimitNoticeEl) return;
    if (!isRateLimited()) {
      rateLimitNoticeEl.style.display = 'none';
      return;
    }
    rateLimitNoticeEl.replaceChildren();
    const msg = document.createElement('div');
    msg.textContent =
      "Gemini API limit reached - further attempts are paused for a few minutes to avoid wasting quota. Check aistudio.google.com for your exact quota/reset time.";
    msg.style.cssText = 'margin-bottom:4px';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'vorsum-ctrl-btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText =
      'padding:2px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer';
    dismissBtn.addEventListener('click', () => {
      rateLimitNoticeEl.style.display = 'none'; // hides the banner only - the cooldown itself keeps running
    });

    rateLimitNoticeEl.appendChild(msg);
    rateLimitNoticeEl.appendChild(dismissBtn);
    rateLimitNoticeEl.style.display = 'block';
    registerThemedSubtree(rateLimitNoticeEl);
  }

  // Keeps the widget below YouTube's top bar instead of covering the
  // profile picture/notifications there. The two skins use different
  // elements for it and are mutually exclusive (Vorapis uses the plain-ID
  // one, vanilla YouTube uses the custom element), so both are checked.
  let widgetPanelEl = null;
  let openCaptionProviderSettings = null; // set inside buildWidget() - opens Options + focuses the LLM provider picker
  let widgetDotEl = null;
  let widgetDotBadgeEl = null; // "N new ✉" badge shown beside the collapsed dot

  // Shared by the widget's vertical offset (below) and the summary
  // overlay's z-index (see getOverlayZIndex, near toggleSummaryOverlay) -
  // one list of candidates so the two never drift out of sync. The
  // positioner-container selectors are the actual fixed header wrapper
  // on each skin; the older ones stay as a fallback in case a given page
  // variant doesn't have them.
  function findMastheadEl() {
    return (
      document.querySelector('#masthead-positioner-container') || // Vorapis
      document.querySelector('#masthead-positioner') || // Vorapis
      document.querySelector('#frosted-glass') || // vanilla YouTube
      document.querySelector('#yt-masthead-container') ||
      document.querySelector('#yt-masthead') ||
      document.querySelector('ytd-masthead') ||
      null
    );
  }

  // One below the masthead's own live z-index, so a summary overlay that
  // ends up scrolled to that region gets correctly covered by the fixed
  // header - the same way an ordinary video thumbnail scrolling past
  // gets covered - instead of floating on top of header content and
  // looking visually disjointed. Computed fresh each time an overlay
  // opens rather than cached, since it's cheap and avoids any staleness
  // if the page structure changes between opens.
  function getOverlayZIndex() {
    const el = findMastheadEl();
    if (!el) return 9999;
    const z = parseInt(getComputedStyle(el).zIndex, 10);
    return Number.isFinite(z) ? z - 1 : 9999;
  }

  // Stamps the shared position onto BOTH the dot and the panel, so they are
  // always the same top-right corner. Called on drag and on (re)build.
  function applyWidgetPosition() {
    const pos = getWidgetPos();
    const right = `${pos.right}px`;
    const top = `${pos.top}px`;
    if (widgetPanelEl) {
      widgetPanelEl.style.right = right;
      widgetPanelEl.style.top = top;
      widgetPanelEl.style.left = '';
    }
    if (widgetDotEl) {
      widgetDotEl.style.right = right;
      widgetDotEl.style.top = top;
      widgetDotEl.style.left = '';
    }
    if (widgetDotBadgeEl) {
      // Sits just left of the dot, vertically centered on it.
      widgetDotBadgeEl.style.right = `${pos.right + 52}px`;
      widgetDotBadgeEl.style.top = `${pos.top + 12}px`;
      widgetDotBadgeEl.style.left = '';
    }
  }

  // Keeps the top-right corner on-screen (with a small margin) so the dot or
  // the panel's minimize/drag region can always be reached again, even if
  // the user drags it toward an edge or the window shrinks.
  function clampWidgetPos(right, top) {
    const m = 12;
    const maxRight = Math.max(m, window.innerWidth - m);
    const maxTop = Math.max(m, window.innerHeight - m);
    return {
      right: Math.min(Math.max(right, 0), maxRight),
      top: Math.min(Math.max(top, 0), maxTop)
    };
  }

  // Shared drag handler for the dot and the panel's grab handle. Both move
  // the SAME stored position (see applyWidgetPosition), so dragging either
  // keeps the two linked. A drag is distinguished from a tap by a small
  // movement threshold, so the dot can be both "drag to move" and "click to
  // open the panel".
  function makeDraggable(handleEl, onDragEnd, onTap) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let origRight = 0;
    let origTop = 0;
    let moved = false;

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointerId = e.pointerId;
      const pos = getWidgetPos();
      origRight = pos.right;
      origTop = pos.top;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      if (handleEl.setPointerCapture) {
        try {
          handleEl.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore - capture is best-effort */
        }
      }
    });

    handleEl.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      handleEl.style.cursor = 'grabbing';
      // Right-anchored: moving the pointer right decreases the distance to
      // the right edge, moving it left increases it.
      const pos = clampWidgetPos(origRight - dx, origTop + dy);
      setWidgetPos(pos.right, pos.top);
      applyWidgetPosition();
    });

    function end(e, cancelled) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      pointerId = null;
      handleEl.style.cursor = '';
      if (!moved) {
        if (onTap) onTap(e);
      } else if (onDragEnd && !cancelled) {
        onDragEnd();
      }
    }

    handleEl.addEventListener('pointerup', (e) => end(e, false));
    handleEl.addEventListener('pointercancel', (e) => end(e, true));
  }

  // Builds the API Configuration form (provider picker + per-provider fields
  // + Test/Help). Shared by the Options panel and the onboarding's "I know
  // what I'm doing" step so the two never drift. Returns { el, refresh,
  // providerSelect }; refresh() re-reads stored keys/provider into the fields.
  function createApiConfigForm() {
    const localBtnStyle =
      'padding:2px 6px;font-size:11px !important;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;text-align:left';

    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;gap:4px';

    const apiKeyLabel = document.createElement('div');
    apiKeyLabel.className = 'vorsum-label';
    apiKeyLabel.style.cssText = 'font-size:10px !important';
    apiKeyLabel.textContent =
      "Google's Gemini has free API access, and is the only provider that works with URL mode. Other providers or local endpoints are also available.";
    el.appendChild(apiKeyLabel);

    const llmProviderSelect = document.createElement('select');
    llmProviderSelect.className = 'vorsum-select';
    llmProviderSelect.setAttribute('aria-label', 'API provider for Caption mode');
    llmProviderSelect.style.cssText =
      'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;width:100%';
    Object.entries(LLM_PROVIDERS).forEach(([key, p]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.label;
      llmProviderSelect.appendChild(opt);
    });
    el.appendChild(llmProviderSelect);

    const llmFieldsWrap = document.createElement('div');
    llmFieldsWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px';
    el.appendChild(llmFieldsWrap);

    const geminiKeyInput = document.createElement('input');
    geminiKeyInput.type = 'password';
    geminiKeyInput.className = 'vorsum-search-input';
    geminiKeyInput.placeholder = 'Gemini API key';
    geminiKeyInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;width:100%';
    geminiKeyInput.addEventListener('change', () => {
      GM_setValue('gemini_api_key', geminiKeyInput.value);
      if (geminiKeyInput.value) setOnboarded(true);
      renderNoKeyNotice();
      log('Gemini API key updated');
    });

    const anthKeyRow = document.createElement('div');
    anthKeyRow.style.cssText = 'display:flex;gap:4px';
    const anthKeyInput = document.createElement('input');
    anthKeyInput.type = 'password';
    anthKeyInput.className = 'vorsum-search-input';
    anthKeyInput.placeholder = 'Anthropic API key';
    anthKeyInput.style.cssText = 'flex:1;font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px';
    anthKeyRow.appendChild(anthKeyInput);
    const anthModelInput = document.createElement('input');
    anthModelInput.type = 'text';
    anthModelInput.className = 'vorsum-search-input';
    anthModelInput.placeholder = LLM_PROVIDERS.anthropic.modelPlaceholder;
    anthModelInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;margin-top:4px;width:100%';

    const oaiKeyInput = document.createElement('input');
    oaiKeyInput.type = 'password';
    oaiKeyInput.className = 'vorsum-search-input';
    oaiKeyInput.placeholder = 'API key (often optional for local servers)';
    oaiKeyInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;width:100%';
    const oaiBaseUrlInput = document.createElement('input');
    oaiBaseUrlInput.type = 'text';
    oaiBaseUrlInput.className = 'vorsum-search-input';
    oaiBaseUrlInput.placeholder = LLM_PROVIDERS.openai_compatible.baseUrlPlaceholder;
    oaiBaseUrlInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;margin-top:4px;width:100%';
    const oaiModelInput = document.createElement('input');
    oaiModelInput.type = 'text';
    oaiModelInput.className = 'vorsum-search-input';
    oaiModelInput.placeholder = LLM_PROVIDERS.openai_compatible.modelPlaceholder;
    oaiModelInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;margin-top:4px;width:100%';

    llmFieldsWrap.appendChild(geminiKeyInput);
    llmFieldsWrap.appendChild(anthKeyRow);
    llmFieldsWrap.appendChild(anthModelInput);
    llmFieldsWrap.appendChild(oaiKeyInput);
    llmFieldsWrap.appendChild(oaiBaseUrlInput);
    llmFieldsWrap.appendChild(oaiModelInput);

    const llmTestRow = document.createElement('div');
    llmTestRow.style.cssText = 'display:flex;gap:4px;margin-top:4px';
    const llmTestBtn = document.createElement('button');
    llmTestBtn.className = 'vorsum-ctrl-btn';
    llmTestBtn.textContent = 'Test';
    llmTestBtn.style.cssText = localBtnStyle + ';flex:1;text-align:center';
    const llmHelpBtn = document.createElement('button');
    llmHelpBtn.className = 'vorsum-ctrl-btn';
    llmHelpBtn.textContent = 'Help';
    llmHelpBtn.title = 'New to API keys? Explains how they work and that Gemini has a free tier';
    llmHelpBtn.style.cssText = localBtnStyle + ';flex:1;text-align:center';
    llmHelpBtn.addEventListener('click', showApiKeyHelpModal);
    llmTestRow.appendChild(llmTestBtn);
    llmTestRow.appendChild(llmHelpBtn);
    el.appendChild(llmTestRow);

    function refresh() {
      const provider = getLlmProvider();
      llmProviderSelect.value = provider;
      geminiKeyInput.style.display = provider === 'gemini' ? 'block' : 'none';
      anthKeyRow.style.display = provider === 'anthropic' ? 'flex' : 'none';
      anthModelInput.style.display = provider === 'anthropic' ? 'block' : 'none';
      oaiKeyInput.style.display = provider === 'openai_compatible' ? 'block' : 'none';
      oaiBaseUrlInput.style.display = provider === 'openai_compatible' ? 'block' : 'none';
      oaiModelInput.style.display = provider === 'openai_compatible' ? 'block' : 'none';

      const creds = getProviderCredentials(provider);
      if (provider === 'gemini') geminiKeyInput.value = creds.apiKey;
      if (provider === 'anthropic') anthKeyInput.value = creds.apiKey;
      if (provider === 'openai_compatible') {
        oaiKeyInput.value = creds.apiKey;
        oaiBaseUrlInput.value = creds.baseUrl || '';
      }
      if (provider === 'anthropic') anthModelInput.value = creds.model || '';
      if (provider === 'openai_compatible') oaiModelInput.value = creds.model || '';
    }

    llmProviderSelect.addEventListener('change', () => {
      setLlmProvider(llmProviderSelect.value);
      refresh();
      log(`Caption mode LLM provider set to: ${llmProviderSelect.value}`);
    });
    anthKeyInput.addEventListener('change', () => {
      GM_setValue('vorsum_anthropic_key', anthKeyInput.value);
      if (anthKeyInput.value) setOnboarded(true);
      renderNoKeyNotice();
      log('Anthropic API key updated');
    });
    anthModelInput.addEventListener('change', () => {
      GM_setValue('vorsum_anthropic_model', anthModelInput.value.trim());
      log(`Anthropic model set to: ${anthModelInput.value.trim() || '(default)'}`);
    });
    oaiKeyInput.addEventListener('change', () => {
      GM_setValue('vorsum_openai_key', oaiKeyInput.value);
      if (oaiKeyInput.value) setOnboarded(true);
      renderNoKeyNotice();
      log('OpenAI-compatible API key updated');
    });
    oaiBaseUrlInput.addEventListener('change', () => {
      GM_setValue('vorsum_openai_base_url', oaiBaseUrlInput.value.trim());
      log(`OpenAI-compatible base URL set to: ${oaiBaseUrlInput.value.trim() || '(none)'}`);
    });
    oaiModelInput.addEventListener('change', () => {
      GM_setValue('vorsum_openai_model', oaiModelInput.value.trim());
      log(`OpenAI-compatible model set to: ${oaiModelInput.value.trim() || '(none)'}`);
    });

    llmTestBtn.addEventListener('click', () => {
      const provider = getLlmProvider();
      const adapter = LLM_PROVIDERS[provider];
      const creds = getProviderCredentials(provider);
      if (!creds.apiKey && provider !== 'openai_compatible') {
        llmTestBtn.textContent = 'No key set';
        setTimeout(() => (llmTestBtn.textContent = 'Test'), 2000);
        return;
      }
      if (adapter.needsBaseUrl && !creds.baseUrl) {
        llmTestBtn.textContent = 'No base URL set';
        setTimeout(() => (llmTestBtn.textContent = 'Test'), 2000);
        return;
      }
      llmTestBtn.textContent = 'Testing…';
      llmTestBtn.disabled = true;
      log(`Testing ${adapter.label}...`);
      const { url, headers, body } = adapter.buildRequest({
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        model: creds.model,
        promptText: 'Reply with only the word: OK'
      });
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        timeout: 15000,
        data: body,
        onload: (res) => {
          llmTestBtn.disabled = false;
          let data = null;
          try {
            data = JSON.parse(res.responseText);
          } catch (e) {
            /* handled below */
          }
          const result = data ? adapter.parseResponse(data) : { error: `HTTP ${res.status}, invalid JSON` };
          if (result.text) {
            llmTestBtn.textContent = '✓ Works';
            llmTestBtn.title = '';
            log(`${adapter.label} test succeeded`);
          } else {
            llmTestBtn.textContent = '✗ Failed';
            llmTestBtn.title = result.error || `HTTP ${res.status}`;
            log(`${adapter.label} test failed: ${result.error || res.status}`, 'warn');
          }
          setTimeout(() => {
            llmTestBtn.textContent = 'Test';
            llmTestBtn.title = '';
          }, 4000);
        },
        ontimeout: () => {
          llmTestBtn.disabled = false;
          llmTestBtn.textContent = '✗ Timeout';
          log(`${adapter.label} test timed out`, 'warn');
          setTimeout(() => (llmTestBtn.textContent = 'Test'), 4000);
        },
        onerror: () => {
          llmTestBtn.disabled = false;
          llmTestBtn.textContent = '✗ Error';
          log(`${adapter.label} test: network error`, 'warn');
          setTimeout(() => (llmTestBtn.textContent = 'Test'), 4000);
        }
      });
    });

    refresh();
    return { el, refresh, providerSelect: llmProviderSelect };
  }

  function buildWidget() {
    const dot = document.createElement('div');
    dot.id = 'vorsum-widget-dot';
    dot.className = 'vorsum-dot';
    dot.title = 'Open vorsum · drag to move';
    dot.textContent = 'V\u2211';
    dot.style.cssText = [
      'position:fixed',
      'right:20px', // default - corrected to the stored position by applyWidgetPosition()
      'top:100px',
      'z-index:2147483647',
      'width:44px',
      'height:44px',
      'border-radius:50%',
      'background:#f4f4f4',
      'color:#333333',
      'border:1px solid #cccccc',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-size:16px !important',
      'font-weight:bold',
      'font-family:sans-serif',
      'line-height:1',
      'cursor:pointer',
      'box-shadow:0 2px 6px rgba(0,0,0,0.35)',
      'user-select:none',
      'touch-action:none',
      'display:none'
    ].join(';');
    registerThemedEl(dot); // theme-reactive via the 'vorsum-dot' entry (light/dark)

    // "N new ✉" badge shown beside the dot when there are unread summaries.
    // Clicking it opens the panel with History and (for a single new entry)
    // shows that newest summary.
    const dotNewBadge = document.createElement('div');
    dotNewBadge.id = 'vorsum-dot-badge';
    dotNewBadge.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'display:none',
      'padding:3px 8px',
      'border-radius:12px',
      'background:#c0392b',
      'color:#ffffff',
      'font-size:10px !important',
      'font-weight:bold',
      'font-family:sans-serif',
      'line-height:1.2',
      'cursor:pointer',
      'box-shadow:0 2px 6px rgba(0,0,0,0.35)',
      'white-space:nowrap',
      'user-select:none',
      'transition:transform 0.12s ease'
    ].join(';');
    dotNewBadge.title = 'New summaries - open History';
    dotNewBadge.addEventListener('mouseenter', () => { dotNewBadge.style.transform = 'scale(1.06)'; });
    dotNewBadge.addEventListener('mouseleave', () => { dotNewBadge.style.transform = ''; });
    dotNewBadge.addEventListener('click', () => {
      const wasSingle = pendingNewHistoryCount === 1;
      expand();
      showHistoryPanel(wasSingle);
    });
    widgetDotBadgeEl = dotNewBadge;

    const panel = document.createElement('div');
    panel.id = 'vorsum-widget';
    panel.className = 'vorsum-widget-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:20px', // default - corrected to the stored position by applyWidgetPosition()
      'top:100px',
      'z-index:2147483647',
      'border-width:1px',
      'border-style:solid',
      'border-radius:6px',
      'padding:6px 8px 0', // bottom padding provided by the drag-handle strip
      'font-size:11px !important',
      'font-family:sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
      'display:flex',
      'flex-direction:column',
      'gap:4px',
      'width:400px',
      'max-height:90vh',
      // Scroll on the inner Options/History panels (below) instead of the
      // whole panel, so the title row and bottom drag strip never scroll and
      // no stray outer scrollbar appears.
      'overflow:hidden'
    ].join(';');

    // A slim "grab" strip at the bottom of the panel so the larger UI can
    // be dragged by the same shared position the dot uses (see
    // makeDraggable + applyWidgetPosition). Kept off the top so the title
    // row has full vertical space and "vorsum" isn't cut off.
    const dragHandle = document.createElement('div');
    dragHandle.className = 'vorsum-drag-handle';
    dragHandle.title = 'Drag to move';
    dragHandle.textContent = '\u283F';
    dragHandle.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'height:12px',
      'flex-shrink:0',
      // Static (not sticky): as the last flow child it takes its own space and
      // can never overlay the panel's last row (Load more / Stats & Data) when
      // the panel scrolls.
      'background:inherit',
      'border-top-width:1px',
      'border-top-style:solid',
      'border-top-color:rgba(128,128,128,0.35)',
      'cursor:grab',
      'user-select:none',
      'touch-action:none',
      'font-size:12px !important',
      'line-height:1',
      'opacity:0.55'
    ].join(';');

    const btnStyle = [
      'padding:2px 6px',
      'font-size:11px !important',
      'border-width:1px',
      'border-style:solid',
      'border-radius:3px',
      'cursor:pointer',
      'text-align:left'
    ].join(';');

    const squareBtnStyle =
      'border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;width:18px;line-height:14px;padding:0;font-size:11px !important;text-align:center';

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px';
    const title = document.createElement('span');
    title.textContent = `vorsum · v${getVersion()}`;
    title.style.cssText = 'font-weight:bold;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    // Inline SVG icons. stroke=currentColor inherits the button's themed
    // text color, so the icons follow the light/dark theme automatically.
    function makeSvgIcon(children) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      children.forEach(({ tag, attrs }) => {
        const el = document.createElementNS(NS, tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        svg.appendChild(el);
      });
      return svg;
    }

    // History and Options compressed to icon-only square buttons, matching
    // the footprint of the mode/help/min buttons. The Scroll (History) sits
    // leftmost of the button cluster, per the request.
    const iconBtnStyle =
      'border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;width:18px;height:16px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0';

    const historyBtn = document.createElement('button');
    historyBtn.className = 'vorsum-ctrl-btn';
    historyBtn.title = 'History';
    historyBtn.setAttribute('aria-label', 'History');
    historyBtn.style.cssText = iconBtnStyle;
    historyBtn.appendChild(
      makeSvgIcon([
        { tag: 'path', attrs: { d: 'M19 17V5a2 2 0 0 0-2-2H4' } },
        { tag: 'path', attrs: { d: 'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3' } }
      ])
    );

    const optionsBtn = document.createElement('button');
    optionsBtn.className = 'vorsum-ctrl-btn';
    optionsBtn.title = 'Options';
    optionsBtn.setAttribute('aria-label', 'Options');
    optionsBtn.style.cssText = iconBtnStyle;
    optionsBtn.appendChild(
      makeSvgIcon([
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
        { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' } }
      ])
    );

    // Theme becomes a small pill "slider" (a track with a knob that slides
    // left for light / right for dark) instead of a sun/moon glyph.
    const themeBtn = document.createElement('button');
    themeBtn.className = 'vorsum-theme-toggle';
    themeBtn.setAttribute('aria-label', 'Toggle theme');
    themeBtn.style.cssText = [
      'position:relative',
      'width:30px',
      'height:16px',
      'border-radius:8px',
      'border-width:1px',
      'border-style:solid',
      'padding:0',
      'cursor:pointer',
      'flex-shrink:0'
    ].join(';');
    const themeKnob = document.createElement('span');
    themeKnob.style.cssText = [
      'position:absolute',
      'top:2px',
      'width:10px',
      'height:10px',
      'border-radius:50%',
      'background:#ffffff',
      'box-shadow:0 0 2px rgba(0,0,0,0.4)',
      'transition:left 0.15s ease'
    ].join(';');
    themeBtn.appendChild(themeKnob);

    // Mode becomes a small two-position slider ("URL" | "Caption") instead
    // of a U/C letter button, matching the theme slider's look.
    const modeBtn = document.createElement('button');
    modeBtn.className = 'vorsum-mode-toggle';
    modeBtn.setAttribute('aria-label', 'Toggle mode');
    modeBtn.style.cssText = [
      'position:relative',
      'width:78px',
      'height:16px',
      'border-radius:8px',
      'border-width:1px',
      'border-style:solid',
      'padding:0',
      'cursor:pointer',
      'flex-shrink:0',
      'overflow:hidden'
    ].join(';');
    const modeKnob = document.createElement('span');
    modeKnob.style.cssText = [
      'position:absolute',
      'top:1px',
      'left:1px',
      'width:38px',
      'height:12px',
      'border-radius:6px',
      'background:#ffffff',
      'box-shadow:0 0 2px rgba(0,0,0,0.35)',
      'transition:left 0.15s ease',
      'pointer-events:none'
    ].join(';');
    const modeUrlLabel = document.createElement('span');
    modeUrlLabel.textContent = 'URL';
    modeUrlLabel.style.cssText = 'position:absolute;left:0;top:0;width:39px;line-height:14px;text-align:center;font-size:9px !important;font-weight:bold;pointer-events:none;z-index:1';
    const modeCapLabel = document.createElement('span');
    modeCapLabel.textContent = 'Caption';
    modeCapLabel.style.cssText = 'position:absolute;right:0;top:0;width:39px;line-height:14px;text-align:center;font-size:9px !important;font-weight:bold;pointer-events:none;z-index:1';
    modeBtn.appendChild(modeKnob);
    modeBtn.appendChild(modeUrlLabel);
    modeBtn.appendChild(modeCapLabel);

    const minBtn = document.createElement('button');
    minBtn.className = 'vorsum-ctrl-btn';
    minBtn.textContent = '–';
    minBtn.title = 'Minimize';
    minBtn.style.cssText = squareBtnStyle;

    const helpBtn = document.createElement('button');
    helpBtn.className = 'vorsum-ctrl-btn';
    helpBtn.textContent = '?';
    helpBtn.title = 'About vorsum / replay the intro';
    helpBtn.style.cssText = squareBtnStyle;
    helpBtn.addEventListener('click', () => showOnboarding(7));

    row1.appendChild(title);
    row1.appendChild(historyBtn);
    row1.appendChild(optionsBtn);
    row1.appendChild(themeBtn);
    row1.appendChild(helpBtn);
    row1.appendChild(minBtn);

    const debugBtn = document.createElement('button');
    debugBtn.className = 'vorsum-ctrl-btn';
    debugBtn.style.cssText = btnStyle;

    const historyNotice = document.createElement('div');
    historyNotice.className = 'vorsum-banner';
    historyNotice.style.cssText =
      'display:none;padding:3px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;text-align:center';
    historyNotice.title = 'Click to load the new entries';
    historyNoticeEl = historyNotice;

    const cacheWarningNotice = document.createElement('div');
    cacheWarningNotice.className = 'vorsum-banner';
    cacheWarningNotice.style.cssText =
      'display:none;padding:5px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px';
    cacheWarningNoticeEl = cacheWarningNotice;

    const rateLimitNotice = document.createElement('div');
    rateLimitNotice.className = 'vorsum-banner';
    rateLimitNotice.style.cssText =
      'display:none;padding:5px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px';
    rateLimitNoticeEl = rateLimitNotice;

    const updateNotice = document.createElement('div');
    updateNotice.className = 'vorsum-banner';
    updateNotice.style.cssText =
      'display:none;padding:5px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;text-align:center';
    updateNotice.title = 'Open the vorsum userscript install URL';
    updateNotice.addEventListener('click', () => window.open(REPO_PAGE_URL, '_blank'));
    updateNoticeEl = updateNotice;

    const whatsNewNotice = document.createElement('div');
    whatsNewNotice.className = 'vorsum-banner';
    whatsNewNotice.style.cssText =
      'display:none;align-items:center;gap:4px;padding:5px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px;text-align:left';
    whatsNewNoticeEl = whatsNewNotice;

    const noKeyNotice = document.createElement('div');
    noKeyNotice.className = 'vorsum-banner';
    noKeyNotice.style.cssText =
      'display:none;padding:5px 6px;font-size:10px !important;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;text-align:center';
    noKeyNotice.textContent = 'Vorsum features unavailable until key is added';
    noKeyNotice.title = 'Click to open API key settings';
    noKeyNotice.addEventListener('click', () => {
      if (openCaptionProviderSettings) openCaptionProviderSettings();
    });
    noKeyNoticeEl = noKeyNotice;

    // -- log panel --
    const logPanel = document.createElement('div');
    logPanel.id = 'vorsum-log-panel';
    logPanel.className = 'vorsum-log';
    logPanel.style.cssText = [
      'font-family:monospace',
      'font-size:10px !important',
      'line-height:1.35',
      'max-height:220px',
      'overflow-y:auto',
      'padding:4px',
      'border-radius:3px',
      'white-space:pre-wrap',
      'word-break:break-word'
    ].join(';');
    logPanelEl = logPanel;

    const logButtonsRow = document.createElement('div');
    logButtonsRow.style.cssText = 'display:flex;gap:4px';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'vorsum-ctrl-btn';
    clearBtn.textContent = 'Clear log';
    clearBtn.style.cssText = btnStyle + ';flex:1';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'vorsum-ctrl-btn';
    copyBtn.textContent = 'Copy log';
    copyBtn.style.cssText = btnStyle + ';flex:1';
    logButtonsRow.appendChild(clearBtn);
    logButtonsRow.appendChild(copyBtn);

    // -- history panel --
    const historyPanel = document.createElement('div');
    historyPanel.style.cssText = 'display:none;flex:1;min-height:0;overflow-y:auto;flex-direction:column;gap:4px';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'vorsum-search-input';
    searchInput.placeholder = 'Search history by title…';
    searchInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px';

    const historyList = document.createElement('div');
    historyList.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto';
    historyListEl = historyList;

    const loadMoreRow = document.createElement('div');
    loadMoreRow.style.cssText = 'display:flex;gap:4px';

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'vorsum-ctrl-btn';
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.style.cssText = btnStyle + ';flex:1';

    const statsBtn = document.createElement('button');
    statsBtn.className = 'vorsum-ctrl-btn';
    statsBtn.textContent = 'Stats & Data';
    statsBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    statsBtn.addEventListener('click', showHistoryStatsModal);

    loadMoreRow.appendChild(loadMoreBtn);
    loadMoreRow.appendChild(statsBtn);

    historyPanel.appendChild(searchInput);
    historyPanel.appendChild(historyList);
    historyPanel.appendChild(loadMoreRow);

    // -- options panel (accessibility + prompt customization) --
    const optionsPanel = document.createElement('div');
    optionsPanel.style.cssText = 'display:none;flex:1;min-height:0;overflow-y:auto;flex-direction:column;gap:6px';

    // Helper: Create collapsible section
    function createCollapsibleSection(title, initiallyOpen = false) {
      const section = document.createElement('div');
      section.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:8px';

      const bodyId = `vorsum-section-${Math.random().toString(36).slice(2, 8)}`;

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'vorsum-ctrl-btn';
      header.style.cssText = btnStyle + ';width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center';
      // Standard disclosure semantics: a real <button> that reports its
      // expanded state and points at the region it controls, so screen
      // readers announce "expanded/collapsed" and keyboard users can toggle
      // with Enter/Space.
      header.setAttribute('aria-expanded', String(initiallyOpen));
      header.setAttribute('aria-controls', bodyId);

      const headerText = document.createElement('span');
      headerText.textContent = title;

      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = initiallyOpen ? '▴' : '▾';
      arrow.style.cssText = 'font-size:10px !important';

      header.appendChild(headerText);
      header.appendChild(arrow);

      const body = document.createElement('div');
      body.id = bodyId;
      body.setAttribute('role', 'region');
      body.setAttribute('aria-label', title);
      body.style.cssText = `display:${initiallyOpen ? 'flex' : 'none'};flex-direction:column;gap:4px;margin-top:4px;padding-left:8px`;

      function setOpen(open) {
        body.style.display = open ? 'flex' : 'none';
        arrow.textContent = open ? '\u25b4' : '\u25be';
        header.setAttribute('aria-expanded', String(open));
      }

      header.addEventListener('click', () => {
        setOpen(body.style.display === 'none');
      });

      section.appendChild(header);
      section.appendChild(body);
      registerThemedEl(header);

      return { section, body, header, setOpen };
    }

    // -- API Configuration (shared form; see createApiConfigForm) --
    const apiForm = createApiConfigForm();
    const llmProviderSelect = apiForm.providerSelect;

    // (The API Configuration fields/Test now come from createApiConfigForm();
    // see apiForm above.)

    // -- Summary output language (explicit, not buried in prompt text) --
    const langLabel = document.createElement('div');
    langLabel.className = 'vorsum-label';
    langLabel.style.cssText = 'font-size:10px !important;margin-top:8px';
    langLabel.textContent = 'Summary language (blank = model default)';
    const langInput = document.createElement('input');
    langInput.type = 'text';
    langInput.className = 'vorsum-search-input';
    langInput.placeholder = 'English';
    langInput.value = getSummaryLanguage();
    langInput.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;width:100%';
    langInput.addEventListener('change', () => {
      setSummaryLanguage(langInput.value.trim());
      log(`Summary language set to: ${langInput.value.trim() || '(model default)'}`);
    });

    // -- Show transcript download button --
    const transcriptButtonRow = document.createElement('label');
    transcriptButtonRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;font-size:11px;cursor:pointer';
    const transcriptButtonCheckbox = document.createElement('input');
    transcriptButtonCheckbox.type = 'checkbox';
    transcriptButtonCheckbox.checked = getTranscriptButtonEnabled();
    transcriptButtonCheckbox.addEventListener('change', () => {
      setTranscriptButtonEnabled(transcriptButtonCheckbox.checked);
      log(`Show transcript download button: ${transcriptButtonCheckbox.checked}`);
      // Trigger a rescan to add/remove transcript buttons from all cards
      scanForCards();
    });
    const transcriptButtonText = document.createElement('span');
    // Small outlined glyph badges so the "T" and "\u2211" read as the actual
    // buttons rather than prose. border-color:currentColor makes them follow
    // the themed text color with no per-theme style entry of their own.
    const badgeStyle =
      'display:inline-block;border-width:1px;border-style:solid;border-color:currentColor;border-radius:3px;padding:0 3px;margin:0 2px;font-size:9px !important;line-height:11px;vertical-align:middle';
    const tBadge = document.createElement('span');
    tBadge.textContent = 'T';
    tBadge.style.cssText = badgeStyle;
    const sumBadge = document.createElement('span');
    sumBadge.textContent = '\u2211';
    sumBadge.style.cssText = badgeStyle;
    transcriptButtonText.appendChild(document.createTextNode('Show transcript download '));
    transcriptButtonText.appendChild(tBadge);
    transcriptButtonText.appendChild(document.createTextNode(' next to '));
    transcriptButtonText.appendChild(sumBadge);
    transcriptButtonRow.appendChild(transcriptButtonCheckbox);
    transcriptButtonRow.appendChild(transcriptButtonText);

    // -- Hover-reveal (DeArrow-style) --
    const hoverOnlyRow = document.createElement('label');
    hoverOnlyRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;font-size:11px;cursor:pointer';
    const hoverOnlyCheckbox = document.createElement('input');
    hoverOnlyCheckbox.type = 'checkbox';
    hoverOnlyCheckbox.checked = getHoverOnlyEnabled();
    hoverOnlyCheckbox.addEventListener('change', () => {
      setHoverOnlyEnabled(hoverOnlyCheckbox.checked);
      applyHoverOnlySetting();
      log(`Hover-reveal: ${hoverOnlyCheckbox.checked}`);
    });
    const hoverOnlyText = document.createElement('span');
    hoverOnlyText.textContent = 'Hide buttons until hovering the video';
    hoverOnlyRow.appendChild(hoverOnlyCheckbox);
    hoverOnlyRow.appendChild(hoverOnlyText);

    // -- ∑ button on embedded players --
    const embedButtonRow = document.createElement('label');
    embedButtonRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;font-size:11px;cursor:pointer';
    const embedButtonCheckbox = document.createElement('input');
    embedButtonCheckbox.type = 'checkbox';
    embedButtonCheckbox.checked = getEmbedButtonEnabled();
    embedButtonCheckbox.addEventListener('change', () => {
      setEmbedButtonEnabled(embedButtonCheckbox.checked);
      scanForCards(); // add/remove the embed button immediately
      log(`∑ on embed videos: ${embedButtonCheckbox.checked}`);
    });
    const embedButtonText = document.createElement('span');
    embedButtonText.textContent = '\u2211 appears on embed videos';
    embedButtonRow.appendChild(embedButtonCheckbox);
    embedButtonRow.appendChild(embedButtonText);

    // "Summary mode" heading (a simple label, not a collapsible subsection)
    // that groups the mode slider and the URL fallback toggle.
    const modeSectionLabel = document.createElement('div');
    modeSectionLabel.className = 'vorsum-label';
    modeSectionLabel.style.cssText = 'font-size:10px !important;font-weight:bold';
    modeSectionLabel.textContent = 'Summary mode';

    // -- Use URL method as fall-back --
    const fallbackUrlRow = document.createElement('label');
    fallbackUrlRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;font-size:11px;cursor:pointer';
    const fallbackUrlCheckbox = document.createElement('input');
    fallbackUrlCheckbox.type = 'checkbox';
    fallbackUrlCheckbox.checked = getFallbackToUrlEnabled();
    fallbackUrlCheckbox.addEventListener('change', () => {
      setFallbackToUrlEnabled(fallbackUrlCheckbox.checked);
      log(`Use URL method as fall-back: ${fallbackUrlCheckbox.checked}`);
    });
    const fallbackUrlText = document.createElement('span');
    fallbackUrlText.textContent = 'Use URL method as fall-back';
    fallbackUrlRow.appendChild(fallbackUrlCheckbox);
    fallbackUrlRow.appendChild(fallbackUrlText);

    const fontLabel = document.createElement('div');
    fontLabel.className = 'vorsum-label';
    fontLabel.style.cssText = 'font-size:10px !important;font-weight:bold';
    fontLabel.textContent = 'Summary text size';

    const fontRow = document.createElement('div');
    fontRow.style.cssText = 'display:flex;align-items:center;gap:4px';

    // A 1px-granularity slider instead of 5 named steps - finer control,
    // and there's no real value in naming the sizes in between. [-] / [+]
    // step buttons flank it, and the slider flexes to fill the space
    // between them (keeping the same total row width as before).
    const fontMinusBtn = document.createElement('button');
    fontMinusBtn.className = 'vorsum-ctrl-btn';
    fontMinusBtn.textContent = '\u2212';
    fontMinusBtn.title = 'Decrease summary text size';
    fontMinusBtn.style.cssText = squareBtnStyle;

    const fontSlider = document.createElement('input');
    fontSlider.type = 'range';
    fontSlider.min = String(MIN_FONT_SIZE_PX);
    fontSlider.max = String(MAX_FONT_SIZE_PX);
    fontSlider.step = '1';
    fontSlider.style.cssText = 'flex:1;min-width:0';

    const fontPlusBtn = document.createElement('button');
    fontPlusBtn.className = 'vorsum-ctrl-btn';
    fontPlusBtn.textContent = '+';
    fontPlusBtn.title = 'Increase summary text size';
    fontPlusBtn.style.cssText = squareBtnStyle;

    const fontCurrentLabel = document.createElement('span');
    fontCurrentLabel.style.cssText = 'width:36px;text-align:center;font-size:11px !important';

    fontRow.appendChild(fontMinusBtn);
    fontRow.appendChild(fontSlider);
    fontRow.appendChild(fontPlusBtn);
    fontRow.appendChild(fontCurrentLabel);

    // Live preview of the chosen size, sitting under the slider. Registered
    // as a scalable summary element so applyFontSize() stamps the same
    // inline 'important' font-size onto it that real inline + History
    // summaries get - the preview is literally the same mechanism. The
    // vorsum-history-row class adds the themed border color; the box's
    // width/style/radius/padding are inline since that class only themes color.
    const fontExampleText = document.createElement('div');
    fontExampleText.className = 'vorsum-history-summary vorsum-history-row';
    fontExampleText.textContent = "This is an example summary text you'd read on a page or in the History tab.";
    fontExampleText.style.cssText =
      'margin-top:6px;line-height:1.3;padding:5px 6px;border-width:1px;border-style:dashed;border-radius:4px;' +
      'box-shadow:0 0 0 1px rgba(0,0,0,0.12),0 3px 10px rgba(0,0,0,0.3)';
    registerScalableSummaryEl(fontExampleText);

    function renderFontRow() {
      const px = getFontSizePx();
      fontSlider.value = String(px);
      fontCurrentLabel.textContent = `${px}px`;
    }

    function adjustFontSize(delta) {
      const next = getFontSizePx() + delta;
      setFontSizePx(next); // clamps to [MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX]
      applyFontSize();
      renderFontRow();
      log(`Summary font size set to ${getFontSizePx()}px`);
    }

    fontMinusBtn.addEventListener('click', () => adjustFontSize(-1));
    fontPlusBtn.addEventListener('click', () => adjustFontSize(1));

    fontSlider.addEventListener('input', () => {
      setFontSizePx(Number(fontSlider.value));
      applyFontSize();
      renderFontRow();
    });
    fontSlider.addEventListener('change', () => {
      log(`Summary font size set to ${getFontSizePx()}px`);
    });

    // Shared two-column panel row: "Summary mode" (slider + URL fall-back,
    // stacked) on the left, "Summary text size" (slider + live example) on
    // the right. vorsum-history-row gives each box its themed border color;
    // the border-width/style/radius are inline since that class only themes
    // the color.
    const summarySettingsRow = document.createElement('div');
    summarySettingsRow.style.cssText = 'display:flex;gap:6px;align-items:stretch;margin-top:6px';

    const modePanel = document.createElement('div');
    modePanel.className = 'vorsum-history-row';
    modePanel.style.cssText =
      'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:6px;border-width:1px;border-style:solid;border-radius:4px';

    const textSizePanel = document.createElement('div');
    textSizePanel.className = 'vorsum-history-row';
    textSizePanel.style.cssText =
      'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:6px;border-width:1px;border-style:solid;border-radius:4px';

    modePanel.appendChild(modeSectionLabel);
    modePanel.appendChild(modeBtn);
    modePanel.appendChild(fallbackUrlRow);
    modePanel.appendChild(transcriptButtonRow);
    modePanel.appendChild(hoverOnlyRow);
    modePanel.appendChild(embedButtonRow);

    textSizePanel.appendChild(fontLabel);
    textSizePanel.appendChild(fontRow);
    textSizePanel.appendChild(fontExampleText);

    summarySettingsRow.appendChild(modePanel);
    summarySettingsRow.appendChild(textSizePanel);

    const promptLabel = document.createElement('div');
    promptLabel.className = 'vorsum-label';
    promptLabel.style.cssText = 'font-size:10px !important;margin-top:2px';
    promptLabel.textContent = 'Custom summarization prompt (prefilled with the default - edit freely)';

    const promptTextarea = document.createElement('textarea');
    promptTextarea.className = 'vorsum-textarea';
    // Prefill with a copy of the default so it can be used as a basis and
    // edited, rather than starting blank. Falls back to any saved custom prompt.
    promptTextarea.value = getCustomPrompt().trim() || SUMMARY_PROMPT;
    promptTextarea.rows = 4;
    promptTextarea.style.cssText = 'font-size:11px !important;padding:4px 5px;border-width:1px;border-style:solid;border-radius:3px;font-family:inherit;resize:vertical';

    const promptButtonsRow = document.createElement('div');
    promptButtonsRow.style.cssText = 'display:flex;gap:4px';

    const savePromptBtn = document.createElement('button');
    savePromptBtn.className = 'vorsum-ctrl-btn';
    savePromptBtn.textContent = 'Save prompt';
    savePromptBtn.style.cssText = btnStyle + ';flex:1';
    savePromptBtn.addEventListener('click', () => {
      const val = promptTextarea.value;
      setCustomPrompt(val);
      log('Custom prompt saved' + (val.trim() ? '' : ' (empty - using default)'));
      savePromptBtn.textContent = 'Saved!';
      setTimeout(() => (savePromptBtn.textContent = 'Save prompt'), 1000);
    });

    const resetPromptBtn = document.createElement('button');
    resetPromptBtn.className = 'vorsum-ctrl-btn';
    resetPromptBtn.textContent = 'Reset to default';
    resetPromptBtn.style.cssText = btnStyle + ';flex:1';
    resetPromptBtn.addEventListener('click', () => {
      // Regenerate the editable copy from the hard-coded default and drop the
      // saved custom prompt, so the effective prompt is the default again.
      promptTextarea.value = SUMMARY_PROMPT;
      setCustomPrompt('');
      log('Custom prompt reset to default');
    });

    promptButtonsRow.appendChild(savePromptBtn);
    promptButtonsRow.appendChild(resetPromptBtn);

    // -- data & privacy / cache size (created before Options panel reorganization) --
    const dataRow = document.createElement('div');
    dataRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:8px';

    const cacheSizeLine = document.createElement('span');
    cacheSizeLine.className = 'vorsum-label';
    cacheSizeLine.style.cssText = 'flex:1;font-size:10px !important';
    cacheSizeLine.textContent = 'Local cache: —';

    const statsDataBtn = document.createElement('button');
    statsDataBtn.className = 'vorsum-ctrl-btn';
    statsDataBtn.textContent = 'Stats & Data';
    statsDataBtn.style.cssText = btnStyle + ';text-align:center';
    statsDataBtn.addEventListener('click', showHistoryStatsModal);

    // FAQ sits next to Data & Privacy (same button styling/dimensions), with
    // Stats & Data to its left. All three share the cache-size row.
    const faqBtn = document.createElement('button');
    faqBtn.className = 'vorsum-ctrl-btn';
    faqBtn.textContent = 'FAQ';
    faqBtn.style.cssText = btnStyle + ';text-align:center';
    faqBtn.addEventListener('click', () => showOnboarding(7));

    const dataDesignBtn = document.createElement('button');
    dataDesignBtn.className = 'vorsum-ctrl-btn';
    dataDesignBtn.textContent = 'Data & Privacy';
    dataDesignBtn.style.cssText = btnStyle + ';text-align:center';
    dataDesignBtn.addEventListener('click', showDataDesignModal);

    async function refreshCacheSizeLine() {
      try {
        const info = await getCacheSizeInfo();
        cacheSizeLine.textContent = `Local cache: ${info.historyCount} video${info.historyCount === 1 ? '' : 's'} · ${formatBytes(info.totalBytes)}`;
      } catch (e) {
        cacheSizeLine.textContent = 'Local cache: (unavailable)';
      }
    }

    dataRow.appendChild(cacheSizeLine);
    dataRow.appendChild(statsDataBtn);
    dataRow.appendChild(faqBtn);
    dataRow.appendChild(dataDesignBtn);

    // Debugging label (for collapsible section later)
    const debugLabel = document.createElement('div');
    debugLabel.className = 'vorsum-label';
    debugLabel.style.cssText = 'font-size:10px !important;margin-bottom:4px';
    debugLabel.textContent = 'Debug log';

    // ---- OPTIONS PANEL ----
    // Summary Configuration is the most-used section, so it opens by default
    // (the same accordion widget as the others).
    const summarySection = createCollapsibleSection('Summary Configuration', true);
    summarySection.body.appendChild(summarySettingsRow);
    optionsPanel.appendChild(summarySection.section);

    // ---- COLLAPSIBLE SECTIONS ----

    // 1. API Configuration
    const apiSection = createCollapsibleSection('API Configuration', false);
    apiSection.body.appendChild(apiForm.el);
    optionsPanel.appendChild(apiSection.section);

    // 2. Prompt Configuration
    const promptSection = createCollapsibleSection('Prompt Configuration', false);
    promptSection.body.appendChild(langLabel);
    promptSection.body.appendChild(langInput);
    promptSection.body.appendChild(promptLabel);
    promptSection.body.appendChild(promptTextarea);
    promptSection.body.appendChild(promptButtonsRow);
    optionsPanel.appendChild(promptSection.section);

    // 3. Troubleshooting
    const troubleshootSection = createCollapsibleSection('Troubleshooting', false);

    // Developer Contact + Bug Report, side by side
    const devContactBtn = document.createElement('button');
    devContactBtn.className = 'vorsum-ctrl-btn';
    devContactBtn.textContent = '📧 Developer Contact';
    devContactBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    devContactBtn.addEventListener('click', showDeveloperContactModal);

    const bugReportBtn = document.createElement('button');
    bugReportBtn.className = 'vorsum-ctrl-btn';
    bugReportBtn.textContent = '🐞 Set up bug report';
    bugReportBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    bugReportBtn.addEventListener('click', showBugReportModal);

    const troubleshootBtnRow = document.createElement('div');
    troubleshootBtnRow.style.cssText = 'display:flex;gap:4px;margin-bottom:6px';
    troubleshootBtnRow.appendChild(devContactBtn);
    troubleshootBtnRow.appendChild(bugReportBtn);
    troubleshootSection.body.appendChild(troubleshootBtnRow);
    registerThemedEl(devContactBtn);
    registerThemedEl(bugReportBtn);

    // Permanent entry point for the changelog (also surfaced once per release
    // via the dismissible "What's new" banner).
    const whatsNewBtn = document.createElement('button');
    whatsNewBtn.className = 'vorsum-ctrl-btn';
    whatsNewBtn.textContent = "What's new";
    whatsNewBtn.style.cssText = btnStyle + ';width:100%;text-align:center;margin-bottom:6px';
    whatsNewBtn.addEventListener('click', () => openWhatsNew(getVersion()));
    troubleshootSection.body.appendChild(whatsNewBtn);
    registerThemedEl(whatsNewBtn);

    troubleshootSection.body.appendChild(debugLabel);
    troubleshootSection.body.appendChild(debugBtn);
    troubleshootSection.body.appendChild(logPanel);
    troubleshootSection.body.appendChild(logButtonsRow);
    optionsPanel.appendChild(troubleshootSection.section);

    // Bottom row: Local cache + Stats & Data / FAQ / Data & Privacy
    optionsPanel.appendChild(dataRow);


    function renderModeBtn() {
      const mode = getMode();
      const url = mode === 'url';
      const dark = getTheme() === 'dark';
      modeBtn.style.background = dark ? '#444444' : '#dddddd';
      modeBtn.style.borderColor = dark ? '#666666' : '#bbbbbb';
      modeKnob.style.left = url ? '1px' : '39px';
      const activeColor = '#333333';
      const inactiveColor = dark ? '#9a9a9a' : '#8a8a8a';
      modeUrlLabel.style.color = url ? activeColor : inactiveColor;
      modeCapLabel.style.color = url ? inactiveColor : activeColor;
      modeBtn.title =
        (url ? 'Mode: URL (Gemini watches the video)' : 'Mode: Captions (transcript, selectable LLM)') +
        ' - click to switch';

      // The URL fall-back only has meaning in Caption mode - it's the
      // "captions unavailable, use URL instead" escape hatch. In URL mode
      // there's nothing to fall back from, so grey it out and disable it.
      fallbackUrlCheckbox.disabled = url;
      fallbackUrlRow.style.opacity = url ? '0.5' : '1';
      fallbackUrlRow.style.cursor = url ? 'not-allowed' : 'pointer';
      fallbackUrlRow.title = url ? 'Only applies to Caption mode' : '';
    }

    function renderDebugBtn() {
      const on = getDebugOn();
      debugBtn.textContent = on ? 'Hide debug log' : 'Show debug log';
      logPanel.style.display = on ? 'block' : 'none';
      logButtonsRow.style.display = on ? 'flex' : 'none';
    }

    function renderHistoryEntry(entry) {
      const row = document.createElement('div');
      row.className = 'vorsum-history-row';
      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;border-bottom-width:1px;border-bottom-style:solid;padding-bottom:6px';

      const thumb = document.createElement('img');
      thumb.src = entry.thumbnailUrl;
      thumb.style.cssText = 'width:64px;height:36px;object-fit:cover;border-radius:2px;cursor:pointer;flex-shrink:0';
      thumb.addEventListener('click', () => window.open(entry.url, '_blank'));

      const col = document.createElement('div');
      col.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px';

      const titleEl = document.createElement('a');
      titleEl.className = 'vorsum-history-title';
      titleEl.href = entry.url;
      titleEl.target = '_blank';
      titleEl.textContent = entry.title;
      titleEl.style.cssText = 'font-size:11px !important;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block';

      const meta = document.createElement('div');
      meta.className = 'vorsum-history-meta';
      meta.style.cssText = 'font-size:10px !important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      meta.appendChild(document.createTextNode(codeToModeLabel(entry.mode)));
      if (entry.channelName) {
        meta.appendChild(document.createTextNode(' · '));
        if (entry.channelUrl) {
          const channelLink = document.createElement('a');
          channelLink.className = 'vorsum-history-title'; // reuse the link color, not the block/ellipsis layout
          channelLink.href = entry.channelUrl;
          channelLink.target = '_blank';
          channelLink.textContent = entry.channelName;
          channelLink.style.cssText = 'font-size:10px !important;text-decoration:none';
          meta.appendChild(channelLink);
        } else {
          meta.appendChild(document.createTextNode(entry.channelName));
        }
      }
      meta.appendChild(document.createTextNode(` · ${relativeTime(entry.createdAt)}`));

      const summaryEl = document.createElement('div');
      summaryEl.className = 'vorsum-history-summary';
      summaryEl.style.cssText = 'display:none;line-height:1.3';
      summaryEl.textContent = entry.summary;
      registerScalableSummaryEl(summaryEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display:flex;gap:4px;margin-top:2px';

      const viewBtn = document.createElement('button');
      viewBtn.className = 'vorsum-ctrl-btn vorsum-history-view-btn';
      viewBtn.textContent = 'View summary';
      viewBtn.style.cssText = btnStyle + ';font-size:10px !important;padding:1px 4px';
      viewBtn.addEventListener('click', () => {
        const showing = summaryEl.style.display !== 'none';
        summaryEl.style.display = showing ? 'none' : 'block';
        viewBtn.textContent = showing ? 'View summary' : 'Hide summary';
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'vorsum-ctrl-btn vorsum-danger-btn';
      delBtn.textContent = 'Delete';
      delBtn.style.cssText = btnStyle + ';font-size:10px !important;padding:1px 4px';

      // Click-to-arm confirm instead of a modifier-key gesture: the button
      // itself tells you what a second click will do, no hidden shortcut to
      // discover or document. Times out back to "Delete" if not confirmed.
      let deleteArmed = false;
      let deleteArmTimeout = null;
      delBtn.addEventListener('click', async () => {
        if (!deleteArmed) {
          deleteArmed = true;
          delBtn.textContent = 'Confirm?';
          delBtn.title = 'Click again to permanently delete this entry';
          deleteArmTimeout = setTimeout(() => {
            deleteArmed = false;
            delBtn.textContent = 'Delete';
            delBtn.title = '';
          }, 3000);
          return;
        }
        clearTimeout(deleteArmTimeout);
        await historyDelete(entry.id);
        refreshAllButtonCachedVisuals();
        row.remove();
        log(`History: deleted entry ${entry.id}`);
      });

      actionsRow.appendChild(viewBtn);
      actionsRow.appendChild(delBtn);

      // Buttons before the summary text (not after): with them below,
      // expanding the summary pushed "Hide summary"/"Delete" further down
      // the page, so reading it then closing it meant extra mouse travel
      // and often scrolling. Keeping the buttons in a fixed spot right
      // under the title means the summary just grows underneath them.
      col.appendChild(titleEl);
      col.appendChild(meta);
      col.appendChild(actionsRow);

      // Thumbnail + title/meta/actions on one row, with the summary text
      // expanded full-width below it (so long summaries use the whole panel
      // width instead of being squeezed into the column beside the thumb).
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;gap:6px';
      topRow.appendChild(thumb);
      topRow.appendChild(col);
      row.appendChild(topRow);
      row.appendChild(summaryEl);
      registerThemedSubtree(row);
      return row;
    }

    async function loadHistory(reset) {
      if (reset) {
        historyOffset = 0;
        historyList.replaceChildren();
      }
      let entries;
      if (historySearchQuery) {
        entries = await historySearch(historySearchQuery, 50);
        loadMoreBtn.style.display = 'none';
      } else {
        entries = await historyGetRecent(HISTORY_PAGE_SIZE, historyOffset);
        historyOffset += entries.length;
        loadMoreBtn.style.display = entries.length < HISTORY_PAGE_SIZE ? 'none' : 'block';
      }
      entries.forEach((e) => historyList.appendChild(renderHistoryEntry(e)));
      if (reset && entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'vorsum-empty';
        empty.style.cssText = 'font-size:11px !important;padding:8px 0;text-align:center';
        empty.textContent = historySearchQuery ? 'No matches.' : 'No summaries yet.';
        historyList.appendChild(empty);
        registerThemedEl(empty);
      }
    }

    loadHistoryRef = loadHistory;

    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        historySearchQuery = searchInput.value.trim();
        loadHistory(true);
      }, 250);
    });

    loadMoreBtn.addEventListener('click', () => loadHistory(false));

    function renderThemeBtn() {
      const theme = getTheme();
      const dark = theme === 'dark';
      themeBtn.style.background = dark ? '#444444' : '#dddddd';
      themeBtn.style.borderColor = dark ? '#666666' : '#bbbbbb';
      themeKnob.style.left = dark ? '16px' : '2px';
      themeBtn.title = `Theme: ${dark ? 'Dark' : 'Light'} - click to switch (widget + Summarize buttons)`;
    }

    themeBtn.addEventListener('click', () => {
      const newTheme = getTheme() === 'dark' ? 'light' : 'dark';
      setTheme(newTheme);
      applyTheme();
      renderThemeBtn();
      renderModeBtn();
      log(`Theme switched to: ${newTheme}`);
    });

    modeBtn.addEventListener('click', () => {
      const newMode = getMode() === 'url' ? 'transcript' : 'url';
      setMode(newMode);
      renderModeBtn();
      log(`Mode switched to: ${newMode}`);
      refreshAllButtonCachedVisuals(); // cache is per-mode, so the "already summarized" accent needs re-checking
    });

    debugBtn.addEventListener('click', () => {
      const newOn = !getDebugOn();
      setDebugOn(newOn);
      renderDebugBtn();
      if (newOn) renderFullLog();
    });

    // History and Options are mutually exclusive: opening one closes the
    // other, so the two sub-panels never stack. Centralized here so the
    // buttons, the history notice banner, and onboarding's jump-to-options
    // all enforce the same rule.
    // Expands the newest History row's summary. `reload` refreshes the list
    // first (needed when a new entry arrived while the list was already open).
    async function autoExpandNewestHistorySummary(reload) {
      if (reload) await loadHistory(true);
      const viewBtn = historyList.querySelector('.vorsum-history-view-btn');
      if (viewBtn) viewBtn.click();
    }
    revealNewestHistoryRef = () => autoExpandNewestHistorySummary(true);

    function showHistoryPanel(autoExpandNewest = false) {
      const single = pendingNewHistoryCount === 1;
      historyPanel.style.display = 'flex';
      historyPanelOpen = true;
      optionsPanel.style.display = 'none';
      pendingNewHistoryCount = 0;
      renderHistoryNotice();
      loadHistory(true).then(() => {
        if (autoExpandNewest && single) autoExpandNewestHistorySummary(false);
      });
    }
    function showOptionsPanel() {
      optionsPanel.style.display = 'flex';
      historyPanel.style.display = 'none';
      historyPanelOpen = false;
      refreshCacheSizeLine();
      apiForm.refresh(); // re-read stored keys each open (e.g. a key saved via onboarding since the panel was built)
    }

    historyBtn.addEventListener('click', () => {
      const showing = historyPanel.style.display !== 'none';
      if (showing) {
        historyPanel.style.display = 'none';
        historyPanelOpen = false;
      } else {
        showHistoryPanel(true);
      }
    });

    historyNotice.addEventListener('click', () => showHistoryPanel(true));

    optionsBtn.addEventListener('click', () => {
      const showing = optionsPanel.style.display !== 'none';
      if (showing) {
        optionsPanel.style.display = 'none';
      } else {
        showOptionsPanel();
      }
    });

    clearBtn.addEventListener('click', () => {
      logBuffer.length = 0;
      flushSharedLog(); // clear this tab's shared cache too, so it doesn't reappear
      renderFullLog();
    });

    copyBtn.addEventListener('click', async () => {
      const text = formatMergedLog();
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy log'), 1200);
      } catch (e) {
        console.log(text);
      }
    });

    function collapse() {
      setWidgetCollapsed(true);
      panel.style.display = 'none';
      dot.style.display = 'flex';
      renderHistoryNotice(); // update the dot's "N new" badge
    }
    function expand() {
      setWidgetCollapsed(false);
      panel.style.display = 'flex';
      dot.style.display = 'none';
      renderHistoryNotice(); // hide the dot's "N new" badge while expanded
    }
    minBtn.addEventListener('click', collapse);
    // The dot is both draggable (to move the shared position) and tappable
    // (to open the panel); makeDraggable's movement threshold tells the two
    // apart. The panel's drag handle reuses the same shared position.
    makeDraggable(dot, null, () => expand());
    makeDraggable(dragHandle, null, null);

    // Lets onboarding's "advanced/custom provider" path jump straight to
    // the real Options UI (dropdown + per-provider fields + Test button)
    // instead of duplicating that whole form inside the onboarding modal.
    openCaptionProviderSettings = () => {
      expand();
      showOptionsPanel();
      apiSection.setOpen(true); // reveal API Configuration (the fields live inside it)
      llmProviderSelect.scrollIntoView({ block: 'center' });
      llmProviderSelect.focus();
    };

    panel.appendChild(row1);
    panel.appendChild(historyNotice);
    panel.appendChild(cacheWarningNotice);
    panel.appendChild(rateLimitNotice);
    panel.appendChild(updateNotice);
    panel.appendChild(whatsNewNotice);
    panel.appendChild(noKeyNotice);
    panel.appendChild(historyPanel);
    panel.appendChild(optionsPanel);
    panel.appendChild(dragHandle);

    renderThemeBtn();
    renderModeBtn();
    renderDebugBtn();
    renderFontRow();
    apiForm.refresh();

    document.documentElement.appendChild(panel);
    document.documentElement.appendChild(dot);
    document.documentElement.appendChild(dotNewBadge);

    registerThemedSubtree(panel);

    widgetPanelEl = panel;
    widgetDotEl = dot;
    applyWidgetPosition();

    if (getWidgetCollapsed()) collapse();

    // ---- Fullscreen handling ----
    // The floating dot otherwise lingers over a fullscreen video. Hide the
    // whole widget while fullscreen is active and restore it on exit.
    //
    // Diagnosing "which layer" the fullscreen video is on: the real Fullscreen
    // API reports document.fullscreenElement (that element is promoted to the
    // browser's top layer). If that's the player/container, anything outside
    // it is hidden by the browser anyway - UNLESS the fullscreen element is
    // <html> itself, in which case our dot (a child of <html>) stays visible.
    // YouTube can also "fullscreen" purely with a CSS class (.ytp-fullscreen)
    // without the API, which never fires fullscreenchange. Both are covered
    // here, and the resolved element is written to the debug log.
    function fullscreenDescription() {
      const el = document.fullscreenElement || document.webkitFullscreenElement;
      if (el) {
        let z = '?';
        try {
          z = getComputedStyle(el).zIndex;
        } catch (e) {
          /* ignore */
        }
        const cls =
          el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';
        return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} (z-index ${z})`;
      }
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (player && player.classList.contains('ytp-fullscreen')) {
        return 'CSS class .ytp-fullscreen (no Fullscreen API element)';
      }
      return 'none';
    }
    function isFullscreenActive() {
      if (document.fullscreenElement || document.webkitFullscreenElement) return true;
      const player = document.querySelector('#movie_player, .html5-video-player');
      return !!(player && player.classList.contains('ytp-fullscreen'));
    }
    let lastFullscreenState = null;
    function applyFullscreenVisibility() {
      const fs = isFullscreenActive();
      if (fs === lastFullscreenState) return;
      lastFullscreenState = fs;
      if (fs) {
        panel.style.display = 'none';
        dot.style.display = 'none';
        if (widgetDotBadgeEl) widgetDotBadgeEl.style.display = 'none';
      } else {
        const collapsed = getWidgetCollapsed();
        panel.style.display = collapsed ? 'none' : 'flex';
        dot.style.display = collapsed ? 'flex' : 'none';
        renderHistoryNotice(); // restore the "N new" badge if there are unread entries
      }
    }
    document.addEventListener('fullscreenchange', () => {
      log(`Fullscreen: ${fullscreenDescription()}`);
      applyFullscreenVisibility();
    });
    document.addEventListener('webkitfullscreenchange', () => {
      log(`Fullscreen (webkit): ${fullscreenDescription()}`);
      applyFullscreenVisibility();
    });
    // Poll cheaply as well, to catch CSS-class fullscreen (and the player
    // element appearing a moment after load) that fullscreenchange misses.
    setInterval(applyFullscreenVisibility, 700);
    applyFullscreenVisibility();

    renderHistoryNotice();
    renderRateLimitNotice();
    renderUpdateNotice();
    renderNoKeyNotice();
    renderFullLog();
    log('Widget initialized');
  }

  let onboardingModalOpen = false;

  function showOnboarding(startScreen = 1) {
    if (onboardingModalOpen) return; // don't stack a second modal if already open
    onboardingModalOpen = true;

    let screen = Math.min(7, Math.max(1, startScreen));
    let advancedOpen = false;
    let countdownTimer = null;

    const backdrop = document.createElement('div');
    backdrop.className = 'vorsum-modal-backdrop';
    backdrop.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px';

    // Fixed modal bounds so the container never jumps between slides. The
    // dimensions are chosen to fit the largest slide (the wide horizontal
    // mode diagram, and the tallest text slide), and stay put for the whole
    // session regardless of which slide is showing.
    const modalWidth = Math.min(isWideLayout() ? 1180 : 480, window.innerWidth - 32);
    // Viewport-derived fixed height (no small hard cap) so the tallest slide
    // fits without an inner scrollbar while the container stays a fixed size
    // across slides. 85vh was the original ceiling before it was over-capped.
    const modalHeight = Math.round(window.innerHeight * 0.85);

    const modal = document.createElement('div');
    modal.className = 'vorsum-modal';
    modal.style.cssText =
      `display:flex;flex-direction:column;width:${modalWidth}px;max-width:100%;height:${modalHeight}px;max-height:85vh;` +
      'overflow:hidden;border-width:1px;border-style:solid;border-radius:6px;padding:16px;font-family:sans-serif;font-size:13px;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,0.35)';

    // Progress dots live above the scroll area (fixed, top-right) so they
    // never move when slide content scrolls or changes.
    const dotsEl = document.createElement('div');
    dotsEl.style.cssText =
      'display:flex;justify-content:flex-end;gap:3px;margin-bottom:8px;font-size:12px;line-height:1;flex:0 0 auto';
    dotsEl.setAttribute('role', 'img');

    // Scrolling slide area; each slide's content is wrapped and animated.
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-height:0;overflow-y:auto';

    // Fixed footer holding the step's buttons (Skip/Back/Next/Done) at the
    // same left/right positions on every slide, pinned to the modal's own
    // bottom margin rather than living inside the scrolling content.
    const footerEl = document.createElement('div');
    footerEl.style.cssText = 'flex:0 0 auto;margin-top:10px';

    modal.appendChild(dotsEl);
    modal.appendChild(body);
    modal.appendChild(footerEl);
    backdrop.appendChild(modal);
    document.documentElement.appendChild(backdrop);

    function close() {
      if (countdownTimer) clearInterval(countdownTimer);
      // Reaching the final screen (7) requires a saved key (screen 6's
      // "\u2192 How to use vorsum" button is gated on having one), so exiting
      // from screen 7 - by any means - is the actual finish condition.
      if (screen === 7) setOnboarded(true);
      backdrop.remove();
      onboardingModalOpen = false;
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      // Only allow Escape to close on the final screen, matching the click-outside behavior
      if (e.key === 'Escape' && screen === 7) close();
    }
    // Click-outside-to-close is intentionally absent on screens 1-6 (so a
    // stray click can't lose setup progress), but re-enabled specifically for
    // screen 7, since "clicking off" the final screen is the described way to
    // finish - and at that point there's nothing left to accidentally lose.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && screen === 7) close();
    });
    document.addEventListener('keydown', onKeydown);

    // ---- small DOM builder helpers (no innerHTML anywhere - YouTube's
    // Trusted Types CSP has been seen blocking that sink outright, and
    // textContent/createElement is what the rest of this file already
    // relies on) ----
    function heading(text, size) {
      const h = document.createElement(size === 'sub' ? 'div' : 'h2');
      h.textContent = text;
      h.style.cssText = size === 'sub' ? 'font-weight:bold;margin:0 0 10px;font-size:14px' : 'margin:0 0 4px;font-size:16px';
      return h;
    }
    function para(text, small) {
      const p = document.createElement('p');
      p.textContent = text;
      p.style.cssText = small ? 'margin:0 0 10px;font-size:11px;color:inherit;opacity:0.8' : 'margin:0 0 12px';
      return p;
    }
    // Like para(), but for paragraphs that embed inline elements (e.g. a ∑ chip).
    function paraNodes(parts, small) {
      const p = document.createElement('p');
      p.style.cssText = small ? 'margin:0 0 10px;font-size:11px;color:inherit;opacity:0.8' : 'margin:0 0 12px';
      parts.forEach((part) => p.appendChild(typeof part === 'string' ? document.createTextNode(part) : part));
      return p;
    }
    // Inline ∑ that looks like the real Summarize button - the same treatment
    // as the mock button on the last slide, standardized here so every
    // appearance of ∑ in the intro reads as a button.
    function makeSumChip(cached) {
      const el = document.createElement('span');
      // vorsum-btn-cached is the blue "already summarized" tint used on the
      // real buttons (its theme entry overrides the base vorsum-btn colors).
      el.className = cached ? 'vorsum-btn vorsum-btn-cached' : 'vorsum-btn';
      el.textContent = '\u2211';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:22px;padding:0 5px;border-width:1px;border-style:solid;border-radius:3px;font-size:13px !important;line-height:1;vertical-align:middle;margin:0 2px';
      registerThemedEl(el);
      return el;
    }
    // Same light/dark pill toggle as the widget's Options menu, reused on the
    // welcome slide. Toggling re-renders so the slide's fixed-color
    // illustration picks up the new palette immediately.
    function makeThemeToggle() {
      const dark = getTheme() === 'dark';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vorsum-ctrl-btn';
      btn.setAttribute('aria-label', 'Toggle light/dark theme');
      btn.style.cssText =
        'position:relative;width:40px;height:20px;border-radius:10px;border-width:1px;border-style:solid;padding:0;cursor:pointer;flex-shrink:0';
      btn.style.background = dark ? '#444444' : '#dddddd';
      btn.style.borderColor = dark ? '#666666' : '#bbbbbb';
      const knob = document.createElement('span');
      knob.style.cssText =
        'position:absolute;top:2px;width:14px;height:14px;border-radius:50%;background:#ffffff;box-shadow:0 0 2px rgba(0,0,0,0.4);transition:left 0.15s ease';
      knob.style.left = dark ? '22px' : '2px';
      btn.appendChild(knob);
      btn.addEventListener('click', () => {
        setTheme(getTheme() === 'dark' ? 'light' : 'dark');
        applyTheme();
        render();
      });
      return btn;
    }
    // Visual mock of Google AI Studio's primary "Create API key" button, so
    // the setup instructions match what people actually see on that page.
    function makeGoogleButtonMock() {
      const btn = document.createElement('span');
      btn.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;background:#ffffff;color:#202124;font-size:11px;font-weight:500;padding:2px 8px;border-radius:4px;border:1px solid #dadce0;vertical-align:middle;margin:0 3px;box-shadow:0 1px 2px rgba(0,0,0,0.15)';
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\ud83d\udd11';
      icon.style.cssText = 'font-size:10px;line-height:1';
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode('Create API key'));
      return btn;
    }
    // Interactive copy of the Options URL/Caption toggle + URL fall-back,
    // reused on the recap slide so a preference can be set inline.
    function makeModeSelector() {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px';

      const modeBtn = document.createElement('button');
      modeBtn.type = 'button';
      modeBtn.setAttribute('aria-label', 'Toggle URL / Caption mode');
      modeBtn.style.cssText =
        'position:relative;width:78px;height:16px;border-radius:8px;border-width:1px;border-style:solid;padding:0;cursor:pointer;flex-shrink:0;overflow:hidden';
      const knob = document.createElement('span');
      knob.style.cssText =
        'position:absolute;top:1px;width:38px;height:12px;border-radius:6px;background:#ffffff;box-shadow:0 0 2px rgba(0,0,0,0.35);transition:left 0.15s ease;pointer-events:none';
      const urlLabel = document.createElement('span');
      urlLabel.textContent = 'URL';
      urlLabel.style.cssText =
        'position:absolute;left:0;top:0;width:39px;line-height:14px;text-align:center;font-size:9px !important;font-weight:bold;pointer-events:none;z-index:1';
      const capLabel = document.createElement('span');
      capLabel.textContent = 'Caption';
      capLabel.style.cssText =
        'position:absolute;right:0;top:0;width:39px;line-height:14px;text-align:center;font-size:9px !important;font-weight:bold;pointer-events:none;z-index:1';
      modeBtn.append(knob, urlLabel, capLabel);

      const fallbackRow = document.createElement('label');
      fallbackRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer';
      const fallbackCheckbox = document.createElement('input');
      fallbackCheckbox.type = 'checkbox';
      fallbackCheckbox.checked = getFallbackToUrlEnabled();
      const fallbackText = document.createElement('span');
      fallbackText.textContent = 'Use URL method as fall-back';
      fallbackRow.append(fallbackCheckbox, fallbackText);

      function renderState() {
        const url = getMode() === 'url';
        const dark = getTheme() === 'dark';
        modeBtn.style.background = dark ? '#444444' : '#dddddd';
        modeBtn.style.borderColor = dark ? '#666666' : '#bbbbbb';
        knob.style.left = url ? '1px' : '39px';
        const active = '#333333';
        const inactive = dark ? '#9a9a9a' : '#8a8a8a';
        urlLabel.style.color = url ? active : inactive;
        capLabel.style.color = url ? inactive : active;
        fallbackCheckbox.disabled = url;
        fallbackRow.style.opacity = url ? '0.5' : '1';
        fallbackRow.style.cursor = url ? 'not-allowed' : 'pointer';
        fallbackRow.title = url ? 'Only applies to Caption mode' : '';
      }
      modeBtn.addEventListener('click', () => {
        setMode(getMode() === 'url' ? 'transcript' : 'url');
        renderState();
      });
      fallbackCheckbox.addEventListener('change', () => {
        setFallbackToUrlEnabled(fallbackCheckbox.checked);
        log(`Use URL method as fall-back: ${fallbackCheckbox.checked}`);
      });
      renderState();

      wrap.append(modeBtn, fallbackRow);
      return wrap;
    }
    // Static copy of the collapsed floating widget dot (V∑), for the recap slide.
    function makeWidgetDotMock() {
      const dot = document.createElement('div');
      // 'vorsum-dot' makes it pick up the same light/dark theme as the real
      // floating dot (registerThemedSubtree(backdrop) runs after each render).
      dot.className = 'vorsum-dot';
      dot.textContent = 'V\u2211';
      dot.setAttribute('aria-hidden', 'true');
      dot.style.cssText =
        'width:44px;height:44px;border-radius:50%;border-width:1px;border-style:solid;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:bold;font-family:sans-serif;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,0.35);user-select:none;flex:0 0 auto';
      return dot;
    }
    // Inline SVG helpers - Trusted Types CSP blocks innerHTML, so icons are
    // assembled node-by-node. Matches the icons in vorsum-how-it-works.html.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    }
    function makeGeminiIcon() {
      const svg = svgEl('svg', { width: '30', height: '30', viewBox: '0 0 34 34', fill: 'none' });
      svg.appendChild(
        svgEl('path', {
          d: 'M17 3 C17 10 20 13 27 13 C20 13 17 16 17 23 C17 16 14 13 7 13 C14 13 17 10 17 3 Z',
          fill: '#4A56C9'
        })
      );
      svg.appendChild(
        svgEl('circle', { cx: '17', cy: '13', r: '5.5', fill: '#FBFAF5', stroke: '#4A56C9', 'stroke-width': '1.4' })
      );
      svg.appendChild(svgEl('circle', { cx: '17', cy: '13', r: '2', fill: '#4A56C9' }));
      return svg;
    }
    function makeLlmIcon() {
      const svg = svgEl('svg', { width: '30', height: '30', viewBox: '0 0 34 34', fill: 'none' });
      svg.appendChild(svgEl('circle', { cx: '9', cy: '9', r: '3.4', fill: 'none', stroke: '#4A56C9', 'stroke-width': '1.6' }));
      svg.appendChild(svgEl('circle', { cx: '25', cy: '9', r: '3.4', fill: 'none', stroke: '#4A56C9', 'stroke-width': '1.6' }));
      svg.appendChild(svgEl('circle', { cx: '17', cy: '25', r: '3.4', fill: '#4A56C9' }));
      svg.appendChild(
        svgEl('path', { d: 'M11.5 11 L22 11 M10.5 12 L15.5 22 M23.5 12 L18.5 22', stroke: '#4A56C9', 'stroke-width': '1.4' })
      );
      return svg;
    }
    function btn(text, cls) {
      const b = document.createElement('button');
      b.className = cls || 'vorsum-ctrl-btn';
      b.textContent = text;
      b.style.cssText =
        'padding:6px 14px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important';
      return b;
    }

    // Progress dots (top-right, outside the scrolling slide area). The
    // current slide is counted, so slide 1 shows one filled
    // (● ○ ○ ○ ○ ○ ○) and each Next fills one more.
    const ONBOARDING_SCREENS = 7;
    function renderProgressDots() {
      dotsEl.replaceChildren();
      dotsEl.setAttribute('aria-label', `Step ${screen} of ${ONBOARDING_SCREENS}`);
      for (let i = 1; i <= ONBOARDING_SCREENS; i++) {
        const dot = document.createElement('span');
        const filled = i <= screen;
        dot.textContent = filled ? '\u25cf' : '\u25cb';
        dot.style.cssText = filled ? '' : 'opacity:0.55';
        dotsEl.appendChild(dot);
      }
    }

    // Desktop mode slides lay their diagram out left-to-right when the window
    // is wide enough to hold the row; otherwise they stack vertically.
    function isWideLayout() {
      return window.innerWidth >= 1100;
    }

    // Tracks the previous screen so render() can tell a real slide change
    // (animate) from an in-place state refresh (don't).
    let lastRenderedScreen = 0;

    function render() {
      const direction = screen === lastRenderedScreen ? 0 : screen > lastRenderedScreen ? 1 : -1;
      lastRenderedScreen = screen;

      // replaceChildren() (a real DOM API), not innerHTML='' - Trusted
      // Types CSP was blocking the innerHTML setter outright on at least
      // one real setup, which is exactly why this modal was rendering
      // completely empty: render() threw right here, before anything
      // below ever got a chance to append.
      body.replaceChildren();
      renderProgressDots();
      renderFooter();

      // Each slide's content is built into `body` as before, then moved into
      // this wrapper at the end - so the slide transition can translate/fade
      // one element without touching the (fixed-size) modal or the dots.
      const slide = document.createElement('div');
      slide.style.cssText = 'width:100%';
      // Text-heavy slides keep a comfortable reading measure inside the wide
      // fixed modal; the mode slides use the full width for their diagrams.
      if (screen !== 2 && screen !== 3) slide.style.cssText += ';max-width:640px;margin:0 auto';

      try {
        if (screen === 1) renderScreen1();
        else if (screen === 2) renderScreen2();
        else if (screen === 3) renderScreen3();
        else if (screen === 4) renderScreen4();
        else if (screen === 5) renderScreen5();
        else if (screen === 6) renderScreen6();
        else if (screen === 7) renderScreen7();
      } catch (e) {
        // A blank modal is the worst possible first impression for someone
        // who doesn't have an API key yet - if anything unexpected throws
        // here in the future, fall back to the one link that actually
        // matters rather than leaving nothing on screen at all.
        log(`Onboarding render failed: ${e.message}`, 'error');
        body.replaceChildren();
        body.appendChild(heading('Welcome to vorsum'));
        body.appendChild(
          para('Something went wrong showing the full setup screen. To get started: get a free Gemini API key, then paste it into Options \u2192 API key.')
        );
        const fallbackLinkBtn = btn('\ud83d\udd11 Get free Gemini key');
        fallbackLinkBtn.addEventListener('click', () => window.open('https://aistudio.google.com/app/apikey', '_blank'));
        body.appendChild(fallbackLinkBtn);
      }

      while (body.firstChild) slide.appendChild(body.firstChild);
      body.appendChild(slide);

      // Smooth slide/fade on a genuine step change (Web Animations API - the
      // same engine CSS transitions use, but it needs no pre-injected styles
      // and no rAF timing dance). Direction follows forward/back navigation.
      if (direction !== 0 && typeof slide.animate === 'function') {
        slide.animate(
          [
            { transform: `translateX(${direction * 28}px)`, opacity: 0 },
            { transform: 'translateX(0)', opacity: 1 }
          ],
          { duration: 220, easing: 'ease-out' }
        );
      }

      registerThemedSubtree(backdrop);
    }

    // ---- Screen 1: intro ----
    function renderScreen1() {
      body.appendChild(heading('Welcome to Vorsum'));

      const detectLine = document.createElement('div');
      detectLine.className = 'vorsum-label';
      detectLine.style.cssText = 'font-size:10px !important;margin-bottom:10px';
      detectLine.textContent = 'Checking for Project Vorapis...';
      body.appendChild(detectLine);

      const imgWrap = document.createElement('div');
      imgWrap.style.cssText = 'margin-bottom:12px;display:none';
      if (HOVER_SUMMARY_SCREENSHOT_URL) {
        const img = document.createElement('img');
        img.alt = 'Hovering a video to reveal the \u2211 button and the summary it produces';
        img.style.cssText = 'max-width:100%;border-radius:4px;display:block';
        img.addEventListener('load', () => (imgWrap.style.display = 'block'));
        img.addEventListener('error', () => (imgWrap.style.display = 'none'));
        img.src = HOVER_SUMMARY_SCREENSHOT_URL;
        imgWrap.appendChild(img);
      }
      body.appendChild(imgWrap);

      body.appendChild(
        paraNodes(['Vorsum is a YouTube summarizer that adds a ', makeSumChip(), " button on videos you don't have time to watch right now."])
      );
      body.appendChild(para("It's enough to decide whether it's worth coming back to, or enough on its own if it isn't."));
      body.appendChild(
        para("Let's get into two ways on how YouTube videos can be summarized, more info, and then set up Vorsum.")
      );

      const themeRow = document.createElement('div');
      themeRow.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin:2px 0 12px';
      const themeLabel = document.createElement('div');
      themeLabel.style.cssText = 'font-size:12px';
      themeLabel.textContent = 'By the way, light or dark mode?';
      themeRow.appendChild(themeLabel);
      themeRow.appendChild(makeThemeToggle());
      body.appendChild(themeRow);

      function vorapisDetected() {
        return !!document.querySelector(CARD_SELECTOR);
      }
      function renderDetectLine(found) {
        detectLine.textContent = found
          ? '\u2713 Project Vorapis (or a compatible layout) detected'
          : '\u26a0 Project Vorapis not detected - vorsum needs it (or a similarly dense YouTube layout) to find videos to summarize';
      }
      if (vorapisDetected()) {
        renderDetectLine(true);
      } else {
        setTimeout(() => renderDetectLine(vorapisDetected()), 3000);
      }
    }

    // ---- Shared visuals for the two mode slides, a compact inline-styled
    // nod to vorsum-how-it-works.html (no external CSS, no innerHTML - see
    // the Trusted Types notes above). Fixed illustration colors are
    // intentional: these are pictures of the concept, not themed UI. ----
    function makeOctopus(color, width, opacity) {
      const o = document.createElement('div');
      const h = Math.round(width * 0.74);
      o.style.cssText = `position:absolute;width:${width}px;height:${h}px;opacity:${opacity};pointer-events:none`;
      const head = document.createElement('div');
      head.style.cssText = `position:absolute;inset:0 0 40% 0;background:${color};border-radius:60% 60% 45% 45%`;
      o.appendChild(head);
      const legW = Math.max(2, Math.round(width / 6));
      const legH = Math.round(width * 0.5);
      for (let i = 0; i < 4; i++) {
        const leg = document.createElement('div');
        leg.style.cssText =
          `position:absolute;bottom:-2px;left:${Math.round((i + 0.5) * (width / 4) - legW / 2)}px;` +
          `width:${legW}px;height:${legH}px;background:${color};border-radius:0 0 4px 4px`;
        o.appendChild(leg);
      }
      return o;
    }

    function makeThumbArt() {
      const art = document.createElement('div');
      art.style.cssText =
        'position:relative;width:150px;height:84px;border-radius:10px;overflow:hidden;flex:0 0 auto;margin:0 auto;' +
        'background:linear-gradient(180deg,#BFE3D6 0%,#2C6E77 55%,#113A41 100%)';
      const rock = document.createElement('div');
      rock.style.cssText =
        'position:absolute;left:-10%;bottom:-18%;width:70%;height:55%;background:#7C5B45;border-radius:60% 40% 50% 50%/60% 50% 50% 40%;opacity:.9';
      const rock2 = document.createElement('div');
      rock2.style.cssText =
        'position:absolute;right:-14%;bottom:-22%;width:55%;height:45%;background:#6B4E3B;border-radius:50% 50% 40% 60%/50% 60% 40% 50%;opacity:.85';
      const hiddenO = makeOctopus('#8A6650', 18, 0.75);
      hiddenO.style.left = '12%';
      hiddenO.style.bottom = '8%';
      const ring = document.createElement('div');
      ring.style.cssText =
        'position:absolute;left:50%;top:44%;width:46px;height:38px;transform:translate(-50%,-50%);' +
        'border:2px solid #FF3B30;border-radius:50%;opacity:.85';
      const mainO = makeOctopus('#E8683A', 36, 1);
      mainO.style.left = '50%';
      mainO.style.top = '44%';
      mainO.style.transform = 'translate(-50%,-50%)';
      const dur = document.createElement('span');
      dur.textContent = '8:42';
      dur.style.cssText =
        'position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.78);color:#fff;font-size:9px;font-weight:500;padding:1px 4px;border-radius:3px';
      art.append(rock, rock2, hiddenO, ring, mainO, dur);
      return art;
    }

    // A jellyfish, shaped like makeOctopus() but as a bell + trailing tentacles.
    function makeJellyfish(color, width, opacity) {
      const j = document.createElement('div');
      const h = Math.round(width * 0.6);
      j.style.cssText = `position:absolute;width:${width}px;height:${Math.round(width * 1.5)}px;opacity:${opacity};pointer-events:none`;
      const bell = document.createElement('div');
      bell.style.cssText = `position:absolute;top:0;left:0;width:${width}px;height:${h}px;background:${color};border-radius:50% 50% 42% 42%`;
      j.appendChild(bell);
      for (let i = 0; i < 4; i++) {
        const t = document.createElement('div');
        t.style.cssText =
          `position:absolute;top:${h - 2}px;left:${Math.round((i + 0.5) * (width / 4) - 1)}px;` +
          `width:2px;height:${Math.round(width * 0.7)}px;background:${color};border-radius:0 0 2px 2px;opacity:0.85`;
        j.appendChild(t);
      }
      return j;
    }

    // Second faux video (a jellyfish), same visual language as makeThumbArt().
    function makeThumbArtJellyfish() {
      const art = document.createElement('div');
      art.style.cssText =
        'position:relative;width:150px;height:84px;border-radius:10px;overflow:hidden;flex:0 0 auto;margin:0 auto;' +
        'background:linear-gradient(180deg,#CFE6F5 0%,#2C5E77 55%,#0F2A40 100%)';
      const rock = document.createElement('div');
      rock.style.cssText =
        'position:absolute;left:-12%;bottom:-20%;width:72%;height:52%;background:#3C5A6B;border-radius:60% 40% 50% 50%/60% 50% 50% 40%;opacity:.9';
      const rock2 = document.createElement('div');
      rock2.style.cssText =
        'position:absolute;right:-14%;bottom:-24%;width:58%;height:44%;background:#324C5C;border-radius:50% 50% 40% 60%/50% 60% 40% 50%;opacity:.85';
      const hiddenJ = makeJellyfish('#6E93A8', 14, 0.7);
      hiddenJ.style.left = '12%';
      hiddenJ.style.top = '10%';
      const mainJ = makeJellyfish('#7FD8E8', 34, 1);
      mainJ.style.left = '50%';
      mainJ.style.top = '18%';
      mainJ.style.transform = 'translateX(-50%)';
      const dur = document.createElement('span');
      dur.textContent = '6:15';
      dur.style.cssText =
        'position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.78);color:#fff;font-size:9px;font-weight:500;padding:1px 4px;border-radius:3px';
      art.append(rock, rock2, hiddenJ, mainJ, dur);
      return art;
    }

    function makeUrlBar(withCC) {
      const bar = document.createElement('div');
      bar.className = 'vorsum-history-row';
      bar.style.cssText =
        'display:inline-flex;align-items:center;gap:6px;font-family:monospace;font-size:10px;' +
        'padding:5px 9px;border-radius:8px;border-width:1px;border-style:solid;margin-bottom:10px;max-width:100%;overflow:hidden';
      bar.appendChild(document.createTextNode('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
      if (withCC) {
        const tag = document.createElement('span');
        tag.textContent = 'CC';
        tag.style.cssText =
          'font-family:sans-serif;font-size:9px;font-weight:600;background:#1B2A22;color:#FBFAF5;padding:1px 5px;border-radius:3px;flex-shrink:0';
        bar.appendChild(tag);
      }
      return bar;
    }

    function makeDownArrow(labelText) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;margin:6px 0';
      if (labelText) {
        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText = 'font-size:10px;opacity:0.75';
        wrap.appendChild(label);
      }
      const shaft = document.createElement('div');
      shaft.style.cssText = 'width:2px;height:14px;background:#9aa39a;position:relative';
      const head = document.createElement('div');
      head.style.cssText =
        'position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);width:0;height:0;' +
        'border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid #9aa39a';
      shaft.appendChild(head);
      wrap.appendChild(shaft);
      return wrap;
    }

    function makeRightArrow(labelText) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;flex:0 0 auto;padding:0 2px';
      if (labelText) {
        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText = 'font-size:9px;opacity:0.75;white-space:nowrap';
        wrap.appendChild(label);
      }
      const shaft = document.createElement('div');
      shaft.style.cssText = 'width:30px;height:2px;background:#9aa39a;position:relative';
      const head = document.createElement('div');
      head.style.cssText =
        'position:absolute;right:-1px;top:50%;transform:translateY(-50%);width:0;height:0;' +
        'border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid #9aa39a';
      shaft.appendChild(head);
      wrap.appendChild(shaft);
      return wrap;
    }

    // Faux YouTube card: the illustration plus its title/channel/views, as in
    // vorsum-how-it-works.html.
    // cfg (optional): { art, title, channel, initials, views, cached, showButton }
    // Defaults describe the squid video used on the mode slides.
    function makeThumbCard(cfg) {
      cfg = cfg || {};
      const art = cfg.art || makeThumbArt();
      const titleText = cfg.title || 'Why This Octopus Just Vanished (Slow\u2011Mo)';
      const channelName = cfg.channel || 'Tide Line';
      const initials = cfg.initials || 'TL';
      const viewsText = cfg.views || '1.4M views \u2022 3 days ago';
      // Off-white card in light mode, black in dark mode - so the faux player
      // reads as "off-white" rather than a hard black slab in light theme.
      const dark = getTheme() === 'dark';
      const bg = dark ? '#000000' : '#F3F3F3';
      const titleColor = dark ? '#f0f0f0' : '#1B2A22';
      const metaColor = dark ? '#b9b9b9' : '#55655A';
      const wrap = document.createElement('div');
      wrap.style.cssText =
        `flex:0 0 auto;width:166px;background:${bg};border-radius:12px;padding:8px;box-shadow:0 4px 14px rgba(0,0,0,0.35)`;
      wrap.appendChild(art);
      const meta = document.createElement('div');
      meta.style.cssText = 'padding-top:7px;text-align:left';
      const title = document.createElement('p');
      title.textContent = titleText;
      title.style.cssText = `font-size:10px;font-weight:600;line-height:1.3;margin:0 0 4px;color:${titleColor}`;
      const channel = document.createElement('div');
      channel.style.cssText = 'display:flex;align-items:center;gap:5px';
      const avatar = document.createElement('span');
      avatar.textContent = initials;
      avatar.style.cssText =
        'width:16px;height:16px;border-radius:50%;background:#4A56C9;color:#fff;font-size:7px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:0 0 auto';
      const ctext = document.createElement('span');
      ctext.style.cssText = `font-size:9px;line-height:1.3;color:${metaColor}`;
      const strong = document.createElement('strong');
      strong.textContent = channelName;
      strong.style.cssText = `display:block;font-weight:500;font-size:9.5px;color:${titleColor}`;
      ctext.appendChild(strong);
      ctext.appendChild(document.createTextNode(viewsText));
      channel.appendChild(avatar);
      channel.appendChild(ctext);
      meta.appendChild(title);
      meta.appendChild(channel);
      wrap.appendChild(meta);
      if (cfg.showButton) {
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'position:relative;display:flex;justify-content:center;margin-top:7px';
        btnRow.appendChild(makeSumChip(!!cfg.cached));
        if (cfg.cursor) btnRow.appendChild(makeCursor());
        wrap.appendChild(btnRow);
      }
      return wrap;
    }

    // Small faux mouse-pointer, used to "point at" a button in a mockup.
    function makeCursor() {
      const wrap = document.createElement('div');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText =
        'position:absolute;left:50%;margin-left:6px;bottom:-6px;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.45))';
      const svg = svgEl('svg', { width: '16', height: '20', viewBox: '0 0 18 22' });
      svg.appendChild(
        svgEl('path', {
          d: 'M2 1 L2 17 L6 13 L9 20 L12 18.5 L9 12 L15 12 Z',
          fill: '#1B2A22',
          stroke: '#FBFAF5',
          'stroke-width': '1.2',
          'stroke-linejoin': 'round'
        })
      );
      wrap.appendChild(svg);
      return wrap;
    }

    // widthPx: fixed width for the horizontal desktop row; omit/0 for the
    // responsive full-width stacked layout. icon: optional factory for an
    // icon shown above the label (see makeGeminiIcon/makeLlmIcon).
    function makeNodeBox(labelText, subText, accent, widthPx, icon) {
      const node = document.createElement('div');
      node.className = 'vorsum-history-row';
      node.style.cssText = widthPx
        ? `border-width:1px;border-style:solid;border-radius:12px;padding:10px 12px;width:${widthPx}px;flex:0 0 auto;text-align:center`
        : 'border-width:1px;border-style:solid;border-radius:12px;padding:10px 12px;max-width:300px;margin:0 auto;width:100%;text-align:center';
      if (icon) {
        const iconWrap = document.createElement('div');
        iconWrap.style.cssText = 'display:flex;justify-content:center;margin-bottom:6px';
        iconWrap.appendChild(icon());
        node.appendChild(iconWrap);
      }
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.cssText = `font-size:12px;font-weight:600${accent ? `;color:${accent}` : ''}`;
      node.appendChild(label);
      if (subText) {
        const sub = document.createElement('div');
        sub.textContent = subText;
        sub.style.cssText = 'font-size:10px;opacity:0.75;margin-top:2px;line-height:1.4';
        node.appendChild(sub);
      }
      return node;
    }

    function makeSummaryBox(children, widthPx) {
      const box = document.createElement('div');
      box.className = 'vorsum-history-row';
      box.style.cssText = widthPx
        ? `border-width:1px;border-style:solid;border-radius:12px;padding:10px 12px;width:${widthPx}px;flex:0 0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.18)`
        : 'border-width:1px;border-style:solid;border-radius:12px;padding:10px 12px;max-width:340px;margin:0 auto;width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.18)';
      const label = document.createElement('div');
      label.textContent = 'Summary';
      label.style.cssText = 'font-size:10px;font-weight:600;opacity:0.7;margin-bottom:5px';
      box.appendChild(label);
      children.forEach((c) => box.appendChild(c));
      return box;
    }

    function makeBadge(text, kind) {
      const badge = document.createElement('span');
      badge.textContent = text;
      const styles = {
        accurate: 'background:#DCEBE1;color:#2E6B50',
        fast: 'background:#E4E5F7;color:#4A56C9'
      };
      badge.style.cssText =
        `display:inline-block;font-size:10px;font-weight:600;padding:3px 9px;border-radius:100px;margin-bottom:8px;${styles[kind] || ''}`;
      return badge;
    }

    // Fixed footer: the same button positions on every slide (Back bottom-left,
    // primary action bottom-right). Rebuilt per render so it always reflects
    // the current step, but it lives outside the scrolling slide content.
    function footerRow() {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px';
      return row;
    }
    function renderFooter() {
      footerEl.replaceChildren();
      if (screen === 1) {
        const row = footerRow();
        // Double-click-to-confirm, same pattern as History's Delete button -
        // deliberately harder to trigger by accident than a single click,
        // since this is the one action that leaves setup unfinished.
        const skipBtn = document.createElement('button');
        skipBtn.className = 'vorsum-ctrl-btn';
        skipBtn.textContent = 'Skip for now';
        skipBtn.style.cssText =
          'padding:4px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:10px !important';
        let skipArmed = false;
        let skipArmTimeout = null;
        skipBtn.addEventListener('click', () => {
          if (!skipArmed) {
            skipArmed = true;
            skipBtn.textContent = 'Click again to skip';
            skipArmTimeout = setTimeout(() => {
              skipArmed = false;
              skipBtn.textContent = 'Skip for now';
            }, 3000);
            return;
          }
          clearTimeout(skipArmTimeout);
          close(); // deliberately does NOT call setOnboarded(true) - reappears until a key exists
        });
        const nextBtn = btn('Next \u2192');
        nextBtn.addEventListener('click', () => {
          screen = 2;
          render();
        });
        row.appendChild(skipBtn);
        row.appendChild(nextBtn);
        footerEl.appendChild(row);
      } else if (screen >= 2 && screen <= 5) {
        const row = footerRow();
        const back = btn('\u2190 Back');
        back.addEventListener('click', () => {
          screen -= 1;
          render();
        });
        const next = btn('Next \u2192');
        next.addEventListener('click', () => {
          screen += 1;
          render();
        });
        row.appendChild(back);
        row.appendChild(next);
        footerEl.appendChild(row);
      } else if (screen === 6) {
        const row = footerRow();
        const back = btn('\u2190 Back');
        back.addEventListener('click', () => {
          screen = 5;
          render();
        });
        // Reaching the final screen (7) requires a real key.
        const next = btn('\u2192 How to use Vorsum');
        const hasKey = hasAnyApiKeyConfigured();
        next.disabled = !hasKey;
        next.style.opacity = hasKey ? '1' : '0.5';
        next.addEventListener('click', () => {
          if (!hasAnyApiKeyConfigured()) return;
          screen = 7;
          render();
        });
        row.appendChild(back);
        row.appendChild(next);
        footerEl.appendChild(row);

        const hint = document.createElement('div');
        hint.className = 'vorsum-label';
        hint.style.cssText = 'font-size:10px !important;text-align:right;margin-top:4px';
        hint.textContent = 'Save a key above first (Gemini, or Advanced \u2192 Test & Save)';
        hint.style.display = hasKey ? 'none' : 'block';
        footerEl.appendChild(hint);
      } else if (screen === 7) {
        const row = footerRow();
        const back = btn('\u2190 Back');
        back.addEventListener('click', () => {
          screen = 6;
          render();
        });
        const done = btn("Done, let's go!");
        done.addEventListener('click', close); // close() marks onboarded when screen === 7
        row.appendChild(back);
        row.appendChild(done);
        footerEl.appendChild(row);
      }
      registerThemedSubtree(footerEl);
    }

    // ---- Screen 2: URL / Gemini vision mode ----
    function renderScreen2() {
      body.appendChild(heading('Summary Mode 1: URL'));
      body.appendChild(makeBadge('More accurate \u2014 sees & hears', 'accurate'));
      body.appendChild(
        para(
          'Vorsum has two modes. The first sends the video link to Google Gemini, which watches every frame and hears the audio, then writes the summary. This is generally slower than Caption mode.'
        )
      );

      body.appendChild(makeUrlBar(false));

      const wide = isWideLayout();
      const flow = document.createElement('div');
      flow.style.cssText = wide
        ? 'display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;justify-content:center;gap:4px;margin:6px 0'
        : 'display:flex;flex-direction:column;align-items:center;margin:6px 0';

      const s1 = document.createElement('span');
      s1.textContent =
        'An octopus off Sulawesi camouflages in under a second, shifting color and skin texture to vanish into the coral. ';
      s1.style.cssText = 'font-size:12px;line-height:1.5';
      const dark = getTheme() === 'dark';
      const flag = document.createElement('span');
      flag.textContent = 'A second, smaller octopus is also hiding nearby';
      flag.style.cssText = dark
        ? 'background:#16301f;color:#5fae82;border-radius:6px;padding:0 4px'
        : 'background:#DCEBE1;color:#2E6B50;border-radius:6px;padding:0 4px';
      const s2 = document.createElement('span');
      s2.textContent =
        ', mimicking the same rock in the corner of the frame \u2014 visible on screen, though never mentioned out loud.';
      s2.style.cssText = 'font-size:12px;line-height:1.5';

      const geminiNode = makeNodeBox(
        'Google Gemini',
        'watches every frame & hears the audio',
        '#4A56C9',
        wide ? 150 : 0,
        makeGeminiIcon
      );
      const summaryBox = makeSummaryBox([s1, flag, s2], wide ? 300 : 0);
      if (wide) {
        flow.append(makeThumbCard(), makeRightArrow('Watch video'), geminiNode, makeRightArrow('Summarize'), summaryBox);
      } else {
        flow.append(makeThumbCard(), makeDownArrow('Watch video'), geminiNode, makeDownArrow('Summarize'), summaryBox);
      }
      body.appendChild(flow);
    }

    // ---- Screen 3: Captions / transcript mode ----
    function renderScreen3() {
      body.appendChild(heading('Summary Mode 2: Caption'));
      body.appendChild(makeBadge('Faster \u2014 text only', 'fast'));
      body.appendChild(
        para(
          "In the second mode, Vorsum asks YouTube for the video's transcript, then sends that text (and your prompt) to an LLM to summarize. This is generally faster than URL mode."
        )
      );

      body.appendChild(makeUrlBar(true));

      const wide = isWideLayout();
      const flow = document.createElement('div');
      flow.style.cssText = wide
        ? 'display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;justify-content:center;gap:4px;margin:6px 0'
        : 'display:flex;flex-direction:column;align-items:center;margin:6px 0';

      const tBox = document.createElement('div');
      tBox.className = 'vorsum-history-row';
      tBox.style.cssText = wide
        ? 'border-width:1px;border-style:solid;border-radius:12px;padding:10px 12px;width:230px;flex:0 0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.18)'
        : 'border-width:1px;border-style:solid;border-radius:12px;padding:10px 12px;max-width:340px;margin:0 auto;width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.18)';
      const tHead = document.createElement('div');
      tHead.textContent = 'Transcript (CC)';
      tHead.style.cssText = 'font-size:10px;font-weight:600;opacity:0.7;margin-bottom:5px';
      tBox.appendChild(tHead);
      [
        '00:04  Off the coast of Sulawesi, this reef looks perfectly still.',
        '00:41  In under a second, this octopus rewrites its own skin.',
        '04:33  Texture changes too \u2014 smooth skin turns to coral-like ridges.',
        '08:20  And just like that, the reef looks empty again.'
      ].forEach((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        row.style.cssText = 'font-family:monospace;font-size:9px;line-height:1.6;opacity:0.85';
        tBox.appendChild(row);
      });

      const s1 = document.createElement('span');
      s1.textContent =
        'An octopus off Sulawesi camouflages in under a second, shifting color and skin texture to vanish into the coral.';
      s1.style.cssText = 'font-size:12px;line-height:1.5';
      const missWrap = document.createElement('div');
      missWrap.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px dashed #9aa39a';
      const miss = document.createElement('span');
      miss.textContent = 'A second octopus is also hiding nearby.';
      miss.style.cssText = 'text-decoration:line-through;opacity:0.5;font-size:11px';
      const missTag = document.createElement('span');
      missTag.textContent = 'not in the transcript';
      missTag.style.cssText =
        getTheme() === 'dark'
          ? 'display:inline-block;margin-left:6px;font-size:9px;font-weight:600;color:#c9596e;background:#2c161b;border-radius:5px;padding:0 5px'
          : 'display:inline-block;margin-left:6px;font-size:9px;font-weight:600;color:#C63C58;background:#F6E1E5;border-radius:5px;padding:0 5px';
      missWrap.append(miss, document.createElement('br'), missTag);

      const llmNode = makeNodeBox('LLM', 'reads only the words that were spoken', '#4A56C9', wide ? 110 : 0, makeLlmIcon);
      const summaryBox = makeSummaryBox([s1, missWrap], wide ? 240 : 0);
      if (wide) {
        flow.append(makeThumbCard(), makeRightArrow('Get transcript'), tBox, makeRightArrow('Read transcript'), llmNode, makeRightArrow('Summarize'), summaryBox);
      } else {
        flow.append(makeThumbCard(), makeDownArrow('Get transcript'), tBox, makeDownArrow('Read transcript'), llmNode, makeDownArrow('Summarize'), summaryBox);
      }
      body.appendChild(flow);
    }

    // ---- Screen 4: recap of the two methods ----
    function renderScreen4() {
      body.appendChild(heading('Same video, two approaches'));
      body.appendChild(para('Putting that together, we can summarize the same video two different ways:'));

      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:0 0 12px;padding-left:20px';
      function bullet(text, lead) {
        const li = document.createElement('li');
        li.style.cssText = 'margin-bottom:8px;font-size:13px;line-height:1.5';
        if (lead) {
          const strong = document.createElement('strong');
          strong.textContent = lead;
          li.appendChild(strong);
          li.appendChild(document.createTextNode(' ' + text));
        } else {
          li.textContent = text;
        }
        return li;
      }
      ul.appendChild(
        bullet(
          'Watching (Gemini) takes in sight and sound together, so Vorsum can catch things that are on screen but never said out loud, like a second octopus camouflaged in the corner of the frame. This also enables summaries of music videos and art videos, or videos without captions or transcripts enabled.',
          'URL mode:'
        )
      );
      ul.appendChild(
        bullet(
          "Reading captions is quicker, but it only knows what was spoken, so if captions are unavailable, it won't work.",
          'Caption mode:'
        )
      );
      body.appendChild(ul);

      const preferLabel = document.createElement('div');
      preferLabel.style.cssText = 'text-align:center;font-size:13px;font-weight:600;margin:10px 0 6px';
      preferLabel.textContent = 'Which do you prefer to use?';
      body.appendChild(preferLabel);

      const selector = makeModeSelector();
      selector.style.marginBottom = '6px';
      body.appendChild(selector);

      const changedLine = document.createElement('div');
      changedLine.style.cssText = 'text-align:center;font-size:11px;opacity:0.8';
      changedLine.textContent = 'This can be changed any time later in Options.';
      body.appendChild(changedLine);
    }

    // ---- Screen 5: privacy / how the APIs are used ----
    function renderScreen5() {
      body.appendChild(heading('Privacy & your data'));
      body.appendChild(
        para(
          "Vorsum talks to two services on your behalf: YouTube, to fetch a video's captions/transcript, and an LLM, to write the summary. In the case of Gemini, Google Gemini and YouTube are both owned by Google and it's an internal process."
        )
      );
      body.appendChild(
        para(
          'Caption mode sends the transcript text and your prompt to the LLM you chose. URL mode sends the video link to Gemini, which processes the video itself.'
        )
      );
      body.appendChild(
        paraNodes([
          "Vorsum does not collect any of your data. Your API key stays in your browser's userscript storage, and nothing is sent anywhere until you actually click ",
          makeSumChip(),
          ' to summarize.'
        ])
      );
      body.appendChild(
        para(
          'If you would rather not send transcripts to Gemini, you can point Caption mode at a different endpoint or a fully local LLM (Ollama, LM Studio) in Options. This is considered an advanced feature, but is an option!'
        )
      );
    }

    // ---- Screen 6: instant setup ----
    function renderScreen6() {
      body.appendChild(heading('API Setup'));
      body.appendChild(heading('You can get started with a free Gemini key below!', 'sub'));

      const steps = document.createElement('ol');
      steps.style.cssText = 'margin:0 0 12px;padding-left:18px';
      [
        ['Open the link below.'],
        ['Click ', makeGoogleButtonMock(), ' in top right.'],
        ['Paste it into the box below.']
      ].forEach((parts) => {
        const li = document.createElement('li');
        li.style.cssText = 'margin-bottom:4px';
        parts.forEach((p) => li.appendChild(typeof p === 'string' ? document.createTextNode(p) : p));
        steps.appendChild(li);
      });
      body.appendChild(steps);

      const recommendedLine = document.createElement('div');
      recommendedLine.style.cssText = 'font-size:11px;margin-bottom:8px';
      recommendedLine.textContent = '\u25cf Recommended: free Gemini API key (fastest & simplest)';
      body.appendChild(recommendedLine);

      const linkBtn = document.createElement('button');
      linkBtn.className = 'vorsum-ctrl-btn';
      linkBtn.textContent = '\ud83d\udd11 Click to visit Google API page for generating & copying Gemini API key';
      linkBtn.style.cssText =
        'padding:6px 10px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:11px !important;width:100%;margin-bottom:6px';
      // Active accent color so it reads as this screen's primary action.
      linkBtn.style.setProperty('background', '#1a73e8', 'important');
      linkBtn.style.setProperty('color', '#ffffff', 'important');
      linkBtn.style.setProperty('border-color', '#1a73e8', 'important');
      linkBtn.addEventListener('click', () => window.open('https://aistudio.google.com/app/apikey', '_blank'));
      body.appendChild(linkBtn);

      const keyRow = document.createElement('div');
      keyRow.style.cssText = 'display:flex;gap:4px;margin-bottom:4px';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.className = 'vorsum-search-input';
      keyInput.placeholder = 'Paste key here';
      keyInput.value = GM_getValue('gemini_api_key', '');
      keyInput.style.cssText = 'flex:1;font-size:11px !important;padding:5px;border-width:1px;border-style:solid;border-radius:3px';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'vorsum-ctrl-btn';
      saveBtn.textContent = 'Test & Save';
      saveBtn.style.cssText = 'padding:5px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important';
      keyRow.appendChild(keyInput);
      keyRow.appendChild(saveBtn);
      body.appendChild(keyRow);

      const keyStatus = document.createElement('div');
      keyStatus.className = 'vorsum-label';
      keyStatus.style.cssText = 'font-size:10px !important;margin-bottom:10px;min-height:14px';
      body.appendChild(keyStatus);

      saveBtn.addEventListener('click', () => {
        const val = keyInput.value.trim();
        if (!val) {
          keyStatus.textContent = 'Paste a key first.';
          return;
        }
        GM_setValue('gemini_api_key', val);
        renderNoKeyNotice();
        saveBtn.textContent = 'Testing\u2026';
        saveBtn.disabled = true;
        GM_xmlhttpRequest({
          method: 'POST',
          url: `https://generativelanguage.googleapis.com/v1beta/interactions?key=${val}`,
          headers: { 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
          timeout: 15000,
          data: JSON.stringify({ model: MODEL, input: [{ type: 'text', text: 'Reply with only the word: OK' }] }),
          onload: (res) => {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Test & Save';
            let data = null;
            try {
              data = JSON.parse(res.responseText);
            } catch (e) {
              /* handled below */
            }
            // Same fix as the Options Gemini key test - requires real
            // generated text, not just an absent .error field.
            const result = data ? LLM_PROVIDERS.gemini.parseResponse(data) : { error: `HTTP ${res.status}, invalid JSON` };
            const ok = !!result.text;
            keyStatus.textContent = ok ? '\u2713 Saved and working.' : `Saved, but the test call failed: ${result.error || `HTTP ${res.status}`}`;
            log(ok ? 'Onboarding: Gemini key saved and verified' : 'Onboarding: Gemini key saved, test call failed', ok ? 'info' : 'warn');
            // Refresh the gated "How to use Vorsum" footer button after key validation
            renderFooter();
          },
          ontimeout: () => {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Test & Save';
            keyStatus.textContent = 'Saved, but the test call timed out.';
          },
          onerror: () => {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Test & Save';
            keyStatus.textContent = 'Saved, but the test call hit a network error.';
          }
        });
      });

      // -- advanced / custom provider --
      const advancedHeader = document.createElement('div');
      advancedHeader.className = 'vorsum-label';
      advancedHeader.style.cssText = 'font-size:11px !important;margin-bottom:4px';
      advancedHeader.textContent = '\u25cf Advanced: Custom API key';
      body.appendChild(advancedHeader);

      const advancedToggle = document.createElement('button');
      advancedToggle.className = 'vorsum-ctrl-btn';
      advancedToggle.style.cssText =
        'padding:5px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important;width:100%;text-align:left';
      advancedToggle.textContent = `Advanced / custom LLM (Claude, Ollama, LM Studio) ${advancedOpen ? '\u25b4' : '\u25be'}`;

      const advancedBody = document.createElement('div');
      advancedBody.style.cssText = `display:${advancedOpen ? 'flex' : 'none'};flex-direction:column;gap:8px;margin-top:8px;padding:8px;border-width:1px;border-style:solid;border-radius:4px`;
      advancedBody.className = 'vorsum-history-row'; // reuse for a subtle bordered box, themed already

      advancedToggle.addEventListener('click', () => {
        advancedOpen = !advancedOpen;
        render();
      });
      body.appendChild(advancedToggle);
      body.appendChild(advancedBody);

      if (advancedOpen) {
        // Embed the real API Configuration form inline so setup can finish
        // right here - no warning screen, no "cancel / I know" friction, and
        // no leaving the tutorial to open Options.
        advancedBody.appendChild(createApiConfigForm().el);
      }

      // -- technical details (nested popup) --
      const techBtn = document.createElement('button');
      techBtn.className = 'vorsum-ctrl-btn';
      techBtn.textContent = 'More info about APIs';
      techBtn.style.cssText =
        'margin-top:12px;padding:5px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important;width:100%;text-align:center';
      techBtn.addEventListener('click', showTechDetails);
      body.appendChild(techBtn);
    }

    // ---- Screen 7: how to use vorsum ----
    function renderScreen7() {
      body.appendChild(heading('Recap and how to use Vorsum'));

      // Two faux videos side by side: a new one, and the squid which already
      // has a saved summary (hence its blue-tinted ∑).
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:14px;margin:22px 0 8px';
      row.appendChild(
        makeThumbCard({
          art: makeThumbArtJellyfish(),
          title: 'How Jellyfish Glow Without a Brain',
          channel: 'Deep Current',
          initials: 'DC',
          views: '892K views \u2022 1 week ago',
          showButton: true,
          cursor: true
        })
      );
      row.appendChild(makeThumbCard({ showButton: true, cached: true }));
      body.appendChild(row);

      // margin-top nudges this down ~one line below the cards.
      const hoverLine = para(
        "Vorsum's summary button appears when you hover near a video card or its title, or can be changed to be always visible."
      );
      hoverLine.style.marginTop = '22px';
      body.appendChild(hoverLine);
      body.appendChild(para('Videos with previously saved summaries have a blue tint.'));

      const embedLine = para('Embeds on other sites also have a summary button.');
      embedLine.style.marginTop = '18px';
      embedLine.style.marginBottom = '18px';
      body.appendChild(embedLine);

      // Mini copy of the collapsed floating widget dot.
      const dotRow = document.createElement('div');
      dotRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin:10px 0 4px';
      dotRow.appendChild(makeWidgetDotMock());
      const dotText = document.createElement('div');
      dotText.style.cssText = 'font-size:12px';
      dotText.textContent = 'This is the options menu for Vorsum. You can drag it around!';
      dotRow.appendChild(dotText);
      body.appendChild(dotRow);

      body.appendChild(document.createElement('br'));
      body.appendChild(document.createElement('br'));
      body.appendChild(para('Have fun!'));
    }

    // ---- Screen 6: technical details (nested popup, stacked above) ----
    function showTechDetails() {
      const techBackdrop = document.createElement('div');
      techBackdrop.className = 'vorsum-modal-backdrop';
      techBackdrop.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px';

      const techModal = document.createElement('div');
      techModal.className = 'vorsum-modal';
      techModal.style.cssText =
        'max-width:440px;width:100%;max-height:80vh;overflow-y:auto;border-width:1px;border-style:solid;border-radius:6px;padding:16px;font-family:sans-serif;font-size:12px;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,0.35)';

      techModal.appendChild(heading('How the APIs work'));
      techModal.appendChild(
        para(
          'An API (Application Programming Interface) is a secure digital bridge that lets two applications talk to each other using a unique identification key.'
        )
      );

      const subHead = document.createElement('div');
      subHead.style.cssText = 'font-weight:bold;margin-bottom:4px';
      subHead.textContent = 'How vorsum uses APIs:';
      techModal.appendChild(subHead);

      const list = document.createElement('ul');
      list.style.cssText = 'margin:0 0 12px;padding-left:18px';
      [
        'Caption Requests: fetches video transcripts from YouTube and passes the text to your chosen LLM (Gemini, Claude, or a local model) for processing.',
        "Native Video Mode (Gemini): sends only the YouTube URL directly to Google's infrastructure, letting Gemini analyze video audio and visuals natively.",
        'Advanced Endpoints: custom providers like Claude or local instances (Ollama) can be configured manually if you prefer local or non-Google setups.'
      ].forEach((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        li.style.cssText = 'margin-bottom:6px';
        list.appendChild(li);
      });
      techModal.appendChild(list);

      const closeBtn = btn('Close');
      closeBtn.style.cssText += ';display:block;margin-left:auto';
      function closeTech() {
        techBackdrop.remove();
        document.removeEventListener('keydown', onTechKeydown);
      }
      function onTechKeydown(e) {
        if (e.key === 'Escape') closeTech();
      }
      closeBtn.addEventListener('click', closeTech);
      techBackdrop.addEventListener('click', (e) => {
        if (e.target === techBackdrop) closeTech();
      });
      document.addEventListener('keydown', onTechKeydown);

      techModal.appendChild(closeBtn);
      techBackdrop.appendChild(techModal);
      document.documentElement.appendChild(techBackdrop);
      registerThemedSubtree(techBackdrop);
    }

    render();
  }

  // ---- Embedded player support ----
  // Inside an embed iframe the floating widget would sit on top of the video
  // on the host page, so embeds get a single compact ∑ button overlaid on the
  // player instead of the dot/panel. Detection is by URL path, which is the
  // reliable signal (the script only ever runs on youtube.com).
  function getEmbedVideoId() {
    const m = location.pathname.match(/^\/embed\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function injectEmbedButton(videoId) {
    if (document.getElementById('vorsum-embed-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'vorsum-embed-btn';
    btn.type = 'button';
    btn.className = 'vorsum-btn';
    btn.dataset.vorsumVideoId = videoId; // so refreshAllButtonCachedVisuals() keeps its tint in sync
    btn.textContent = '\u2211';
    btn.setAttribute('aria-label', 'Summarize');
    btn.title = 'Summarize with Vorsum';
    // Opt out of the shared hover-only visibility system so it can't set
    // pointer-events:none on us (which made the button unclickable).
    btn.dataset.vorsumOwnVisibility = 'true';
    // min-width keeps it a circle at rest; width:auto lets it become a pill
    // while busy/erroring (setButtonState writes "∑ - …" labels).
    btn.style.cssText =
      'position:fixed;top:50px;right:10px;z-index:2147483647;min-width:32px;height:32px;border-radius:16px;' +
      'padding:0 9px;display:flex;align-items:center;justify-content:center;font-size:15px !important;font-weight:bold;' +
      'cursor:pointer;border-width:1px;border-style:solid;box-shadow:0 2px 6px rgba(0,0,0,0.4);' +
      'white-space:nowrap;overflow:hidden;opacity:0;pointer-events:none;' +
      'transition:opacity 0.15s ease,transform 0.12s ease';

    // Reveal on pointer movement, fade out after a short idle period; keep it
    // pinned visible (sticky) while a request is running.
    let hideTimer = null;
    function showBtn(sticky) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      clearTimeout(hideTimer);
      // Stay put while a request is running (setButtonState marks it active).
      if (!sticky && btn.dataset.vorsumActive !== 'true') hideTimer = setTimeout(hideBtn, 2200);
    }
    function hideBtn() {
      btn.style.opacity = '0';
      btn.style.pointerEvents = 'none';
    }
    document.addEventListener('mousemove', () => showBtn(false), { passive: true });
    btn.addEventListener('mouseenter', () => showBtn(false));

    // Resolve the video at click time so playlist/loop embeds summarize the
    // video that's actually playing rather than only the one in the URL.
    function currentVideoId() {
      try {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const fromPlayer = win?.ytInitialPlayerResponse?.videoDetails?.videoId;
        if (fromPlayer) return fromPlayer;
        const player = document.querySelector('#movie_player');
        const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
        if (data && data.video_id) return data.video_id;
      } catch (e) {
        /* fall through to the URL-derived id */
      }
      return videoId;
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = currentVideoId();
      log(`Embed: summarize clicked for ${id}`);
      showBtn(true);
      try {
        Promise.resolve(handleClick(id, document, btn)).catch((err) =>
          log(`Embed: summarize failed: ${err && err.message ? err.message : err}`, 'error')
        );
      } catch (err) {
        log(`Embed: summarize failed: ${err && err.message ? err.message : err}`, 'error');
      }
    });
    document.documentElement.appendChild(btn);
    registerThemedEl(btn);
    refreshButtonCachedVisual(btn, videoId);
  }

  function ensureWidget() {
    if (getEmbedVideoId()) return; // embeds get the compact ∑ button, not the floating widget
    if (!document.getElementById('vorsum-widget')) {
      buildWidget();
    }
  }

  // ---- UI injection ----
  function refreshButtonCachedVisual(btn, videoId) {
    const cached = hasCachedSummary(videoId, getMode());
    btn.classList.toggle('vorsum-btn-cached', cached);
    applyThemeToElement(btn);
    applyBtnHoverVisibility(btn); // cached state changes the hidden-state opacity (dim vs fully invisible)
    btn.title = cached
      ? `Cached summary available - click to view instantly. Summaries used today: ${getUsageCount()}`
      : `Summaries used today: ${getUsageCount()}`;
  }

  function refreshAllButtonCachedVisuals() {
    document.querySelectorAll('.vorsum-btn').forEach((btn) => {
      const vid = btn.dataset.vorsumVideoId;
      if (vid) refreshButtonCachedVisual(btn, vid);
    });
  }

  function injectButton(card) {
    if (card.querySelector('.vorsum-btn')) return;

    const videoId = extractVideoId(card);
    if (!videoId) return;

    const contentArea = getContentArea(card);

    // Container for both buttons (side-by-side)
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display:flex;gap:4px;margin-top:4px';

    // Summarize button (\u03a3)
    const btn = document.createElement('button');
    btn.className = 'vorsum-btn';
    btn.dataset.vorsumVideoId = videoId;
    btn.textContent = '\u2211';
    btn.setAttribute('aria-label', 'Summarize');
    btn.style.cssText = [
      'padding:2px 8px',
      'font-size:11px !important',
      'border-width:1px',
      'border-style:solid',
      'border-radius:3px',
      'cursor:pointer'
    ].join(';');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleClick(videoId, card, btn);
    });

    btnContainer.appendChild(btn);
    registerThemedEl(btn);
    refreshButtonCachedVisual(btn, videoId);

    // Transcript download button (T) - only if enabled
    if (getTranscriptButtonEnabled()) {
      const transcriptBtn = document.createElement('button');
      transcriptBtn.className = 'vorsum-btn vorsum-transcript-btn';
      transcriptBtn.dataset.vorsumVideoId = videoId;
      transcriptBtn.textContent = 'T';
      transcriptBtn.setAttribute('aria-label', 'Download transcript');
      transcriptBtn.style.cssText = [
        'padding:2px 8px',
        'font-size:11px !important',
        'border-width:1px',
        'border-style:solid',
        'border-radius:3px',
        'cursor:pointer'
      ].join(';');

      transcriptBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleTranscriptDownload(videoId, card, transcriptBtn);
      });

      btnContainer.appendChild(transcriptBtn);
      registerThemedEl(transcriptBtn);

      // Share hover state with the transcript button
      transcriptBtn.dataset.vorsumHovered = 'false';
      card.addEventListener('mouseenter', () => {
        transcriptBtn.dataset.vorsumHovered = 'true';
        applyBtnHoverVisibility(transcriptBtn);
      });
      card.addEventListener('mouseleave', () => {
        transcriptBtn.dataset.vorsumHovered = 'false';
        applyBtnHoverVisibility(transcriptBtn);
      });
      transcriptBtn.addEventListener('focus', () => {
        transcriptBtn.dataset.vorsumHovered = 'true';
        applyBtnHoverVisibility(transcriptBtn);
      });
      transcriptBtn.addEventListener('blur', () => {
        transcriptBtn.dataset.vorsumHovered = 'false';
        applyBtnHoverVisibility(transcriptBtn);
      });
      applyBtnHoverVisibility(transcriptBtn);
    }

    contentArea.appendChild(btnContainer);

    // Hover-reveal listens on the CARD (not just the button, which is
    // invisible when hidden and hard to "discover" by hovering it
    // specifically) so the whole card is the reveal trigger. focus/blur
    // on the button itself covers keyboard navigation, which has no
    // hover equivalent.
    btn.dataset.vorsumHovered = 'false';
    card.addEventListener('mouseenter', () => {
      btn.dataset.vorsumHovered = 'true';
      applyBtnHoverVisibility(btn);
    });
    card.addEventListener('mouseleave', () => {
      btn.dataset.vorsumHovered = 'false';
      applyBtnHoverVisibility(btn);
    });
    btn.addEventListener('focus', () => {
      btn.dataset.vorsumHovered = 'true';
      applyBtnHoverVisibility(btn);
    });
    btn.addEventListener('blur', () => {
      btn.dataset.vorsumHovered = 'false';
      applyBtnHoverVisibility(btn);
    });
    applyBtnHoverVisibility(btn);
  }

  // ---- Watch-page toolbar injection ----
  // Unlike the grid-card path (injectButton), the watch page has no "card"
  // to discover - the video IS the page. Instead, the \u2211 button is
  // inserted directly into the watch page's own action toolbar, immediately
  // to the left of an existing button group on that page:
  //   - Modern YouTube: ytd-menu-renderer inside ytd-watch-metadata
  //   - Vorapis / classic UI: .yt-uix-button-group
  // Both use the same button factory and wire up to the same handleClick the
  // grid-card buttons do, just with the current page's videoId/URL (there's
  // no link to extract it from on the watch page) and a host element taken
  // from the watch page itself for title/channel extraction. The button is
  // not hover-revealed here - it lives in a persistent toolbar, so it stays
  // visible the same way YouTube's own Like/Share buttons do.
  //
  // Returns the button element when it inserted (or already had one) so the
  // caller can refresh its cached-state visual after a mode switch.
  function injectWatchPageButton(anchor) {
    const host = anchor.parentElement;
    if (!host) return null;

    const urlObj = parseWatchUrl();
    if (!urlObj) return null;
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) return null;

    // Reuse an existing button under this anchor when present (SPA navigation
    // can re-run this before the old toolbar is torn down), BUT rebind it to
    // the current page's video: YouTube reuses the ytd-watch-metadata /
    // button-group container across navigations, so a button injected for
    // video A would otherwise still carry A's id after the user navigates to
    // B - clicking it would summarize the wrong video, and the "Saved" tint
    // would reflect A's cache state instead of B's. The click handler below
    // reads the id from the dataset at click time (not from a closure), so
    // just updating the dataset here is enough to retarget it.
    let btn = host.querySelector(':scope > .vorsum-btn');
    if (btn) {
      if (btn.dataset.vorsumVideoId === videoId) return btn; // already bound to this video
      btn.dataset.vorsumVideoId = videoId;
      // Close any overlay the stale button had open - it was anchored to the
      // old video's summary and would now be pointing at the wrong one.
      if (btn.__vorsumOverlay) closeSummaryOverlay(btn.__vorsumOverlay);
      setButtonState(btn, 'Summarize', false);
      refreshButtonCachedVisual(btn, videoId);
      return btn;
    }

    // document as the "card" context: handleClick's extractVideoTitle /
    // extractChannelInfo now have watch-page selectors, and a watch-page
    // button has no card to pass otherwise. Equivalent to what grid cards
    // provide - a scope to find the title/channel within.
    const pageContext = document;

    btn = document.createElement('button');
    btn.className = 'vorsum-btn vorsum-watch-btn';
    btn.dataset.vorsumVideoId = videoId;
    btn.textContent = '\u2211';
    btn.setAttribute('aria-label', 'Summarize');
    // Inline toolbar styling: sits in a real action bar, so it takes the
    // bar's height/flow like YouTube's own buttons rather than the small
    // feed-card styling the grid buttons use.
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'padding:0 10px',
      'height:36px',
      'margin-right:8px',
      'font-size:14px !important',
      'font-weight:bold',
      'border-width:1px',
      'border-style:solid',
      'border-radius:18px',
      'cursor:pointer',
      'flex-shrink:0'
    ].join(';');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Read the id from the dataset at click time rather than from the
      // closure: the same button element is retargeted across SPA
      // navigations (see the reuse branch above), so the closure-captured
      // videoId would be stale. The dataset is the source of truth.
      handleClick(btn.dataset.vorsumVideoId, pageContext, btn);
    });

    anchor.parentElement.insertBefore(btn, anchor);
    registerThemedEl(btn);
    // Persistently visible (no hover-reveal) in a real toolbar, same as the
    // grid buttons when hover-only is off. Set before refreshButtonCachedVisual
    // so its internal applyBtnHoverVisibility call already sees the visible state.
    btn.dataset.vorsumActive = 'false';
    btn.dataset.vorsumHovered = 'true';
    refreshButtonCachedVisual(btn, videoId);
    return btn;
  }

  // Parse the current watch URL into a URL object, or null when not on a
  // watch page. Kept here rather than reaching into handleClick's own
  // watchUrl construction because the watch-page toolbar path is the one
  // place the video identity comes from the page itself instead of a card
  // link - and YouTube's watch URLs vary (/?v=, /watch?v=, embed, shorts),
  // so centralizing it keeps injectWatchPageButton and any future caller
  // from each re-deriving the same logic.
  function parseWatchUrl() {
    let path = location.pathname;
    let search = location.search;
    // /embed/ID and /shorts/ID put the id in the path, not a ?v= param -
    // normalize to a /watch?v=ID URL object so the existing searchParams
    // read below works uniformly. URL mode still sends the real original
    // href to Gemini (via handleClick's watchUrl), so the provider sees the
    // actual video, not the normalized form.
    const shortsMatch = path.match(/^\/shorts\/([\w-]{6,})/);
    if (shortsMatch) {
      path = '/watch';
      search = `?v=${shortsMatch[1]}`;
    } else if (path.startsWith('/embed/')) {
      const id = path.slice('/embed/'.length).split('/')[0];
      if (id) {
        path = '/watch';
        search = `?v=${id}`;
      }
    } else if (path !== '/watch') {
      return null;
    }
    try {
      return new URL(`${location.origin}${path}${search}`);
    } catch (e) {
      return null;
    }
  }

  // Overlay instead of inline insertion: appending a summary directly
  // under a grid card breaks the grid's own vertical flow (pushes only
  // the card below it, distorts the row, leaves orphaned whitespace once
  // closed). Portalled to document.documentElement with position:fixed,
  // same pattern already used for the widget and modals, so it can't be
  // clipped by a card ancestor's overflow:hidden (common for thumbnail
  // clipping/hover effects) the way an absolutely-positioned child of the
  // card itself could be. Recreated fresh on every open rather than
  // reused/repositioned, which keeps positioning logic simple and lets
  // stale trackedSummaryEls/trackedThemedEls entries prune themselves via
  // the existing isConnected filter once removed.
  let currentOpenSummaryOverlay = null;

  function isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  function closeSummaryOverlay(overlay) {
    if (!overlay) return;
    overlay.remove();
    if (currentOpenSummaryOverlay === overlay) currentOpenSummaryOverlay = null;
    if (overlay.__ownerBtn) {
      overlay.__ownerBtn.__vorsumOverlay = null;
      // Scroll/outside-click/Escape close the overlay without going
      // through the button's own click handler, so the label needs
      // resetting here too - otherwise it's stuck reading "Hide summary"
      // for an overlay that's no longer on screen.
      setButtonState(overlay.__ownerBtn, 'Summarize', false);
    }
    document.removeEventListener('keydown', overlay.__keydownHandler);
    document.removeEventListener('mousedown', overlay.__outsideClickHandler, true);
  }

  // Returns true if now shown, false if now hidden - same contract the
  // old togglePanel had, so callers didn't need to change.
  // Shared by initial placement and every scroll-reposition, so both
  // stay in sync with the exact same clamping/flip logic.
  function positionOverlay(overlay, btn) {
    // Document coordinates (viewport rect + current scroll offset), not
    // viewport coordinates - this is what lets the overlay scroll along
    // with the page naturally (position:absolute below) instead of
    // needing a scroll listener to repeatedly re-anchor a position:fixed
    // element, which was the source of it visibly disappearing/jumping
    // while still fully within the visible page.
    const rect = btn.getBoundingClientRect();
    const maxWidth = 360;
    let left = rect.left + window.scrollX;
    if (rect.left + maxWidth > window.innerWidth - 8) {
      left = Math.max(8 + window.scrollX, window.innerWidth - maxWidth - 8 + window.scrollX);
    }
    // Flip above the button when it's near the bottom of the viewport,
    // rather than letting the popup hang off-screen below the fold. Uses
    // the overlay's OWN current height once it exists (accurate, unlike
    // the estimate used before first paint), falling back to an estimate
    // only on the very first call before anything has rendered yet.
    const knownHeight = overlay.isConnected ? overlay.getBoundingClientRect().height : 0;
    const estimatedHeight = knownHeight || Math.min(window.innerHeight * 0.5, 200);
    const opensBelow = rect.bottom + 6 + estimatedHeight <= window.innerHeight - 8;
    const top = (opensBelow ? rect.bottom + 6 : Math.max(8, rect.top - estimatedHeight - 6)) + window.scrollY;
    overlay.style.setProperty('left', `${left}px`, 'important');
    overlay.style.setProperty('top', `${top}px`, 'important');
  }

  function toggleSummaryOverlay(btn, text) {
    if (btn.__vorsumOverlay) {
      closeSummaryOverlay(btn.__vorsumOverlay);
      return false;
    }

    // One open at a time: floating popups scattered across a long scroll
    // get messy fast.
    if (currentOpenSummaryOverlay) closeSummaryOverlay(currentOpenSummaryOverlay);

    const overlay = document.createElement('div');
    overlay.className = 'vorsum-summary-panel vorsum-summary-overlay';
    overlay.textContent = text;
    overlay.__ownerBtn = btn;

    const maxWidth = 360;
    overlay.style.cssText = [
      'position:absolute', // document-relative, so it scrolls with the page instead of needing to be re-anchored
      `max-width:${maxWidth}px`,
      'max-height:50vh',
      'overflow-y:auto',
      'padding:8px 10px',
      'border-width:1px',
      'border-style:solid',
      'border-radius:6px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.3)',
      'line-height:1.4',
      // Deliberately NOT max z-index - see getOverlayZIndex - so the
      // fixed header correctly covers this if it's scrolled up to that
      // region, same as any ordinary page content would be.
      `z-index:${getOverlayZIndex()}`
    ].join(';');

    document.documentElement.appendChild(overlay);
    registerScalableSummaryEl(overlay);
    registerThemedEl(overlay);
    positionOverlay(overlay, btn);

    // No scroll listener at all now (see positionOverlay comment) -
    // document-relative absolute positioning means the browser's own
    // scrolling keeps it correctly anchored to the button for free, with
    // no JS involved and nothing that can misfire.
    const onKeydown = (e) => {
      if (e.key === 'Escape') closeSummaryOverlay(overlay);
    };
    const onOutsideClick = (e) => {
      if (!overlay.contains(e.target) && e.target !== btn) closeSummaryOverlay(overlay);
    };
    overlay.__keydownHandler = onKeydown;
    overlay.__outsideClickHandler = onOutsideClick;
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('mousedown', onOutsideClick, true);

    btn.__vorsumOverlay = overlay;
    currentOpenSummaryOverlay = overlay;
    return true;
  }

  // Centralized so every one of the many labels used across handleClick
  // (Summarizing, Hide summary, rate-limited, every error string, etc.)
  // automatically gets the sigma treatment without touching each call
  // site individually - idle state is just the glyph, everything else
  // gets it as a prefix. aria-label always carries the full text
  // regardless of what's visually shown, since the glyph alone reads as
  // nothing meaningful to a screen reader.
  function setButtonState(btn, label, disabled) {
    const isTranscriptBtn = btn.classList.contains('vorsum-transcript-btn');
    const idleLabel = isTranscriptBtn ? 'T' : 'Summarize';
    const idleGlyph = isTranscriptBtn ? 'T' : '\u2211';

    const isIdle = label === idleLabel;
    btn.textContent = isIdle ? idleGlyph : `${idleGlyph} - ${label}`;
    btn.setAttribute('aria-label', label);
    btn.disabled = !!disabled;
    btn.dataset.vorsumActive = isIdle ? 'false' : 'true';
    applyBtnHoverVisibility(btn);
  }

  // ---- Core logic ----
  async function handleTranscriptDownload(videoId, card, btn) {
    const cardTitle = extractVideoTitle(card);

    log(`Transcript download: video=${videoId}`);

    // Check if we have a cached transcript first
    let transcript = getCachedTranscript(videoId);

    if (!transcript) {
      setButtonState(btn, 'Fetching...', true);
      try {
        transcript = await getTranscript(videoId);
      } catch (e) {
        log(`Transcript fetch threw: ${e.message}`, 'error');
        setButtonState(btn, 'No captions', false);
        setTimeout(() => setButtonState(btn, 'T', false), 2000);
        return;
      }

      if (!transcript) {
        log('Transcript: none available for this video', 'warn');
        setButtonState(btn, 'No captions', false);
        setTimeout(() => setButtonState(btn, 'T', false), 2000);
        return;
      }

      setCachedTranscript(videoId, transcript);
    } else {
      log('Transcript: using cached transcript');
    }

    // Download the transcript
    downloadFile(`${sanitizeFilename(cardTitle || videoId)}_transcript.txt`, transcript, 'text/plain');
    log('Transcript: downloaded locally');
    setButtonState(btn, 'Downloaded ✓', false);
    setTimeout(() => setButtonState(btn, 'T', false), 2000);
  }

  async function handleClick(videoId, card, btn, attempt = 1, modeOverride = null) {
    const mode = modeOverride || getMode();
    const cached = await getCachedSummary(videoId, mode);
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const cardTitle = extractVideoTitle(card);
    const channelInfo = extractChannelInfo(card);

    // A fresh user click (no override) starts a clean slate, so a previous
    // URL-mode-permission fallback can't linger into this attempt.
    if (!modeOverride && attempt === 1) urlModePermissionRejected = false;

    log(`Click: video=${videoId} mode=${mode} attempt=${attempt}`);

    if (cached) {
      log('Click: cache hit, showing cached summary');
      const visible = toggleSummaryOverlay(btn, cached);
      setButtonState(btn, visible ? 'Hide summary' : 'Summarize', false);
      refreshButtonCachedVisual(btn, videoId);
      historyRecordSummary({ videoId, mode, title: cardTitle, url: watchUrl, channelName: channelInfo.name, channelUrl: channelInfo.url, summary: cached });
      return;
    }

    // URL mode is always Gemini (the one thing it can uniquely do). This
    // includes the Caption -> URL fall-back: even when Claude / an
    // OpenAI-compatible or local endpoint is the primary Caption provider,
    // the fallback is forced to Gemini here (and so uses the Gemini key).
    const provider = mode === 'url' ? 'gemini' : getLlmProvider();
    const adapter = LLM_PROVIDERS[provider];
    const creds = getProviderCredentials(provider);

    if (!creds.apiKey && provider !== 'openai_compatible') {
      // The Caption -> URL fall-back needs a Gemini key specifically. If the
      // only configured provider was, say, Claude or a local endpoint, say so
      // explicitly instead of the generic "set a key" - the fix is different.
      if (modeOverride === 'url') {
        log('Fallback: URL mode needs a Gemini key, but none is configured - cannot fall back to URL mode', 'warn');
        setButtonState(btn, 'URL fall-back needs a Gemini key', false);
        return;
      }
      log(`Click: no API key set for provider=${provider}, aborting`, 'warn');
      setButtonState(btn, 'Set API key in Options', false);
      return;
    }
    if (adapter.needsBaseUrl && !creds.baseUrl) {
      log(`Click: no base URL configured for provider=${provider}, aborting`, 'warn');
      setButtonState(btn, 'Set base URL in Options', false);
      return;
    }

    if (isRateLimited()) {
      const minsLeft = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
      log(`Click: still in rate-limit cooldown (~${minsLeft}m left) - not calling the API`, 'warn');
      setButtonState(btn, `Rate-limited - wait ~${minsLeft}m`, false);
      renderRateLimitNotice();
      return;
    }

    let promptText;
    let videoUri;

    if (mode === 'transcript') {
      let transcript = getCachedTranscript(videoId);
      if (!transcript) {
        setButtonState(btn, 'Fetching transcript…', true);
        try {
          transcript = await getTranscript(videoId);
        } catch (e) {
          log(`Transcript fetch threw: ${e.message}`, 'error');
          if (getFallbackToUrlEnabled() && !urlModePermissionRejected) {
            log('Fallback: captions failed, retrying via URL mode (Gemini)', 'info');
            return handleClick(videoId, card, btn, 1, 'url');
          }
          setButtonState(btn, 'Captions blocked - try URL mode', false);
          return;
        }
        if (!transcript) {
          log('Transcript: none available for this video', 'warn');
          if (getFallbackToUrlEnabled() && !urlModePermissionRejected) {
            log('Fallback: no captions available, retrying via URL mode (Gemini)', 'info');
            return handleClick(videoId, card, btn, 1, 'url');
          }
          setButtonState(btn, 'No captions available', false);
          return;
        }
        setCachedTranscript(videoId, transcript);
      } else {
        log('Transcript: using cached transcript from a previous attempt');
      }

      promptText = `${buildSummaryPrompt(mode)}\n\nTranscript:\n${transcript}`;
    } else {
      promptText = buildSummaryPrompt(mode);
      videoUri = watchUrl;
      log(`URL mode: will send ${watchUrl} directly to Gemini, no local scraping`);
    }

    const label = attempt === 1 ? 'Summarizing…' : `Retrying (${attempt}/${MAX_ATTEMPTS})…`;
    setButtonState(btn, label, true);

    const timeoutMs = TIMEOUT_MS[mode];
    const backoffBase = BACKOFF_BASE_MS[mode];

    function retryOrFail(reasonLabel, isTransient) {
      if (isTransient && attempt < MAX_ATTEMPTS) {
        const delayMs = attempt * backoffBase;
        log(`Scheduling retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delayMs}ms`);
        setTimeout(() => handleClick(videoId, card, btn, attempt + 1, modeOverride), delayMs);
      } else {
        log(`Giving up: ${reasonLabel}`, 'error');
        clearPendingJob(videoId, mode);
        setButtonState(btn, reasonLabel, false);
      }
    }

    addPendingJob(videoId, mode); // recorded so a tab close mid-request doesn't lose the work

    const { url: reqUrl, headers: reqHeaders, body: payload } = adapter.buildRequest({
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      model: creds.model,
      promptText,
      videoUri
    });
    log(`Sending request to ${adapter.label} (payload=${payload.length} bytes, timeout=${timeoutMs}ms)`);
    const startedAt = performance.now();

    const heartbeat = setInterval(() => {
      const elapsedS = Math.round((performance.now() - startedAt) / 1000);
      log(`Still waiting on ${adapter.label}... ${elapsedS}s elapsed (timeout at ${Math.round(timeoutMs / 1000)}s)`);
    }, 15000);
    function stopHeartbeat() {
      clearInterval(heartbeat);
    }

    // The request is wrapped in a promise and (when available) held under a
    // Web Lock named for this job, so another tab's resume pass can tell a
    // live job from an abandoned one and skip duplicate work. The lock is
    // released when the promise settles (load/timeout/error) and automatically
    // by the browser if this tab dies.
    const runRequest = () =>
      new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: reqUrl,
          headers: reqHeaders,
          timeout: timeoutMs,
          data: payload,
          onload: (res) => {
            try {
              stopHeartbeat();
        const elapsedS = Math.round((performance.now() - startedAt) / 1000);
        log(`Response received after ${elapsedS}s: HTTP ${res.status}`);

        let data;
        try {
          data = JSON.parse(res.responseText);
        } catch (e) {
          log(`Response body was not valid JSON: ${e.message}`, 'error');
          console.log('[vorsum] raw response:', res.responseText);
          clearPendingJob(videoId, mode);
          setButtonState(btn, 'Bad response - see console', false);
          return;
        }

        const result = adapter.parseResponse(data);

        if (result.error) {
          log(`API error: HTTP ${res.status} - ${result.error}`, 'error');

          // URL mode sends the video URI as a {type:'video'} input alongside
          // the text. Some Google accounts/API keys are NOT allowed to use
          // that video input (403 "caller does not have permission") even
          // though the same key works fine for text-only requests (which is
          // why the onboarding/Options "Test" passes). Retrying the exact
          // same URL-mode request 3x just re-fails in ~0s, so instead fall
          // back to caption mode for this click - it only sends text, which
          // the key already proved it accepts.
          if (mode === 'url' && res.status === 403) {
            urlModePermissionRejected = true;
            clearPendingJob(videoId, mode); // this URL job is done; the caption retry records its own
            log('URL mode: API rejected the video input (403 permission) - retrying in caption mode', 'warn');
            return handleClick(videoId, card, btn, 1, 'transcript');
          }

          // Quota/rate-limit gets its own path, checked BEFORE the general
          // transient-retry logic below: retrying a 429 a few seconds later
          // wastes more of an already-exhausted quota for no benefit, so
          // instead we stop immediately, start a cooldown so further clicks
          // don't hit the API again either, and say so clearly in the
          // notification area instead of just failing on the button itself.
          const isQuotaOrRateLimit = res.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED';
          if (isQuotaOrRateLimit) {
            rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            renderRateLimitNotice();
            clearPendingJob(videoId, mode);
            setButtonState(btn, 'Rate-limited - see notice above', false);
            log('API quota/rate limit hit - pausing further attempts for a cooldown period', 'warn');
            return;
          }

          const isTransient = adapter.isTransient(res, data);
          if (isTransient && attempt < MAX_ATTEMPTS) {
            retryOrFail(null, true);
            return;
          }

          const short = result.error.slice(0, 40);
          clearPendingJob(videoId, mode);
          setButtonState(btn, isTransient ? 'Server busy - try later' : `Err: ${short}`, false);
          btn.title = result.error;
          return;
        }

        const text = result.text;
        if (!text) {
          log('Response had no text - see console for full payload', 'warn');
          console.warn('[vorsum] No text in response:', data);
          clearPendingJob(videoId, mode);
          setButtonState(btn, 'No summary - see console', false);
          return;
        }

        // Caption mode can flag the transcript as unusable (music/art video,
        // lyrics, etc.). With the URL fall-back on, treat that as a soft
        // failure and retry in URL mode; otherwise show a friendly message
        // instead of the raw marker, and don't cache it.
        if (mode === 'transcript' && CAPTION_UNUSABLE_RE.test(text)) {
          log('Caption mode: model flagged the transcript as unusable (likely music/art)', 'warn');
          clearPendingJob(videoId, mode);
          if (getFallbackToUrlEnabled() && !urlModePermissionRejected) {
            setButtonState(btn, 'Unusable captions - retrying via URL…', true);
            Promise.resolve(handleClick(videoId, card, btn, 1, 'url')).catch((err) =>
              log(`Fallback failed: ${err && err.message ? err.message : err}`, 'error')
            );
            return;
          }
          log('Caption mode: transcript unusable and URL fall-back is off', 'warn');
          const friendly = "This looks like it may be a music or art video - the captions aren't usable for a summary.";
          toggleSummaryOverlay(btn, friendly);
          setButtonState(btn, 'Hide summary', false);
          return;
        }

        log(`Summary received (${text.length} chars), caching`);
        // History (written below) is the source of truth; keep the sync tint
        // index in step immediately so the button reflects "saved" right away.
        savedSummaryIndex.add(savedSummaryId(videoId, mode));
        clearPendingJob(videoId, mode);
        bumpUsageCount();
        refreshButtonCachedVisual(btn, videoId);

        // Viewport-aware display: if the button is actually on screen (and
        // this tab is the visible one), the person is presumably still
        // looking at it, so show the overlay directly - no need to also
        // flash a notification about something they can already see. If
        // they've scrolled away, switched tabs, or (SPA navigation) the
        // card isn't even in the DOM anymore, showing an overlay anchored
        // to an invisible button would be pointless - notify instead, same
        // as the History "N new" banner already does. This matters most for
        // URL mode's 20-120s jobs, where scrolling on while waiting is the
        // normal thing to do.
        const btnOnScreen = btn.isConnected && document.visibilityState === 'visible' && isElementInViewport(btn);
        if (btnOnScreen) {
          toggleSummaryOverlay(btn, text);
          setButtonState(btn, 'Hide summary', false);
        } else {
          setButtonState(btn, 'Summarize', false);
          notifyNewHistoryEntry(false, { videoId, mode });
          log('Summary ready but the button is off-screen - notifying instead of auto-showing', 'info');
        }

        historyRecordSummary({ videoId, mode, title: cardTitle, url: watchUrl, channelName: channelInfo.name, channelUrl: channelInfo.url, summary: text });
            } finally {
              resolve();
            }
          },
          ontimeout: () => {
            stopHeartbeat();
            const elapsedS = Math.round((performance.now() - startedAt) / 1000);
            log(`Request timed out after ${elapsedS}s (limit ${Math.round(timeoutMs / 1000)}s, mode=${mode})`, 'error');
            retryOrFail('Timed out - see console', true);
            resolve();
          },
          onerror: (err) => {
            stopHeartbeat();
            log(`Network/transport error: ${JSON.stringify(err)}`, 'error');
            retryOrFail('Failed - see console', true);
            resolve();
          }
        });
      });

    const jobLockName = `vorsum-job-${mode}_${videoId}`;
    const locksAvailable =
      typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
    if (locksAvailable) {
      await navigator.locks.request(jobLockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          log(`Job lock: ${jobLockName} held by another tab - skipping duplicate work`, 'warn');
          setButtonState(btn, 'Summarizing in another tab…', false);
          return;
        }
        await runRequest();
      });
    } else {
      await runRequest();
    }
  }

  // ---- Watch for grid cards being added ----
  function scanForCards() {
    // Embeds have no cards/watch toolbar - just the compact ∑ button, and
    // only when enabled in Options.
    const embedId = getEmbedVideoId();
    if (embedId) {
      if (getEmbedButtonEnabled()) {
        injectEmbedButton(embedId);
      } else {
        const existing = document.getElementById('vorsum-embed-btn');
        if (existing) existing.remove();
      }
      return;
    }
    document.querySelectorAll(CARD_SELECTOR).forEach(injectButton);
    // Watch-page action toolbar (the \u2211 button that summarizes the page's
    // own video, as opposed to grid-card buttons). Both selectors are tried
    // each scan - they're mutually exclusive across the two UI variants
    // (modern YouTube vs. Vorapis / classic), and on a non-watch page
    // neither matches, so this is a cheap no-op everywhere else.
    document
      .querySelectorAll('ytd-menu-renderer.style-scope.ytd-watch-metadata #top-level-buttons-computed, #watch7-secondary-actions .yt-uix-button-group')
      .forEach((anchor) => injectWatchPageButton(anchor));
    ensureWidget();
  }

  // Debounced rather than firing scanForCards() on every single mutation
  // batch: YouTube's own DOM churns constantly (recommendations loading,
  // live chat, ad slots, etc.), and each one of those was triggering a
  // full document.querySelectorAll(CARD_SELECTOR) scan - four selectors,
  // whole-document, however often YouTube's own script touches the page.
  // Waiting for a short quiet period instead collapses a burst of mutations
  // into a single scan, without meaningfully delaying when a button
  // actually appears (new cards still show a Summarize button within
  // ~150ms of the page settling, not per-mutation).
  let scanDebounceTimeout = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanDebounceTimeout);
    scanDebounceTimeout = setTimeout(scanForCards, 150);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  injectGlobalStyles();
  applyTheme();
  applyFontSize();
  applyHoverOnlySetting();
  ensureWidget(); // no-op on embed players - they get the compact ∑ button via scanForCards()
  scanForCards();
  runMigrationIfNeeded().then(() => cleanupLegacyStorage());
  // History (IndexedDB) is the single source of truth for summaries; load the
  // sync "Saved" tint index from it, then fold in any legacy video-cache rows.
  loadSavedSummaryIndex().then(() => migrateVideoCacheToHistory());
  checkCacheThreshold(); // in case the cache was already over threshold from a prior session
  checkForUpdate(); // throttled internally to once/day, harmless to call every load

  if (!getOnboarded() && !getEmbedVideoId()) {
    // Small delay so the modal doesn't compete with the page's own
    // first-paint/layout settling, and so the Vorapis detection check
    // (which reads whatever card elements exist right now) has a fair
    // chance of finding them already rendered. Skipped on embeds (a modal
    // inside a small player iframe would be nonsense).
    setTimeout(() => showOnboarding(), 1500);
  }

  // Resume any summary that was interrupted (typically a tab closed while its
  // request was in flight). Delayed so it doesn't compete with page load.
  if (!getEmbedVideoId()) setTimeout(resumePendingJobs, 4000);

  // One-time "What's new" banner when the version changed (deferred so it can
  // respect onboarding / the update notice). Skipped on embeds.
  if (!getEmbedVideoId()) setTimeout(checkWhatsNew, 3000);
})();
