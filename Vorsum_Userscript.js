// ==UserScript==
// @name         Vorsum - Youtube Summary Button
// @namespace    https://github.com/PipettingBeaver/Vorsum
// @version      1.0.6
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
// @connect      *
// @connect      raw.githubusercontent.com
// @updateURL   https://raw.githubusercontent.com/PipettingBeaver/Vorsum/refs/heads/main/Vorsum_Userscript.js
// @downloadURL https://raw.githubusercontent.com/PipettingBeaver/Vorsum/refs/heads/main/Vorsum_Userscript.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config ----
  const MODEL = 'gemini-3.5-flash-lite'; // free-tier lightweight model on the Interactions API
  const SUMMARY_PROMPT =
    'Summarize this video in 3-4 sentences for someone deciding whether to watch it, and give in Standard Technical English. ' +
    'Focus on the concrete points/conclusions, not vague teasers. Remove any preamble, only reply with summary itself. If caption returns repetitive or nonsensical content, suggest that video may be a music or art video.';

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

  function getDownloadCaptionsEnabled() {
    return GM_getValue('vorsum_download_captions', false);
  }
  function setDownloadCaptionsEnabled(v) {
    GM_setValue('vorsum_download_captions', v);
  }

  function getTranscriptButtonEnabled() {
    return GM_getValue('vorsum_transcript_button', false);
  }
  function setTranscriptButtonEnabled(v) {
    GM_setValue('vorsum_transcript_button', v);
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
    return GM_getValue('vorsum_widget_collapsed', false);
  }
  function setWidgetCollapsed(collapsed) {
    GM_setValue('vorsum_widget_collapsed', collapsed);
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
  const REPO_RAW_URL = 'https://raw.githubusercontent.com/PipettingBeaver/Vorsum/refs/heads/main/Vorsum_Userscript.js';
  const REPO_PAGE_URL = 'https://github.com/PipettingBeaver/Vorsum';
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
    updateNoticeEl.textContent = `v${latestKnownVersion} available (you're on v${getVersion()}) - click to open the repo`;
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
      light: { background: '#888888' },
      dark: { background: '#666666' }
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
  const DEFAULT_FONT_SIZE_PX = 13;

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
    `;
    document.head.appendChild(style);
  }

  // ---- Debug log ----
  const logBuffer = [];
  let logPanelEl = null;

  function fmtTime() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function log(msg, level = 'info') {
    const line = `[${fmtTime()}] ${msg}`;
    logBuffer.push({ line, level });
    if (logBuffer.length > 500) logBuffer.shift();

    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(`[vorsum] ${msg}`);

    if (getDebugOn() && logPanelEl) {
      renderLogLine(line, level);
    }
  }

  function renderLogLine(line, level) {
    const row = document.createElement('div');
    row.textContent = line;
    row.className = level === 'error' ? 'vorsum-log-error' : level === 'warn' ? 'vorsum-log-warn' : 'vorsum-log-info';
    logPanelEl.appendChild(row);
    logPanelEl.scrollTop = logPanelEl.scrollHeight;
    registerThemedEl(row);
  }

  function renderFullLog() {
    if (!logPanelEl) return;
    logPanelEl.replaceChildren();
    logBuffer.forEach((entry) => renderLogLine(entry.line, entry.level));
  }

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
  // full-word records written before this existed, so History Stats
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
    return new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  async function historyClearAll() {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    return new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  // Deletes the N oldest entries by createdAt and returns which ones, so
  // the caller can also clean up the corresponding vorsum_video_cache
  // entries (keyed by videoId, not by this store's composite id).
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

  // Single consolidated GM key instead of one per video+mode
  // (vorsum_cache_url_377V9A_0ECc, vorsum_cache_transcript_377V9A_0ECc,
  // vorsum_transcript_377V9A_0ECc, ...), each of which duplicated the
  // videoId into the key name itself. Holds ONLY the generated summary text
  // (a few hundred chars each) - see below for why the raw transcript,
  // which can be up to 20,000 chars, deliberately does NOT live here.
  function getVideoCache() {
    return GM_getValue('vorsum_video_cache', {});
  }
  function getCachedSummary(videoId, mode) {
    const entry = getVideoCache()[videoId]?.summaries?.[mode];
    // Backward-compat: entries cached before this field existed are a plain
    // string rather than {text, cachedAt} - both read out fine here.
    return (typeof entry === 'string' ? entry : entry?.text) || '';
  }
  function getCachedSummaryCachedAt(videoId, mode) {
    const entry = getVideoCache()[videoId]?.summaries?.[mode];
    return typeof entry === 'object' && entry ? entry.cachedAt || null : null;
  }
  function hasCachedSummary(videoId, mode) {
    return !!getCachedSummary(videoId, mode);
  }
  function setCachedSummary(videoId, mode, text) {
    const cache = getVideoCache();
    if (!cache[videoId]) cache[videoId] = {};
    if (!cache[videoId].summaries) cache[videoId].summaries = {};
    cache[videoId].summaries[mode] = { text, cachedAt: Date.now() };
    GM_setValue('vorsum_video_cache', cache);
  }

  // Raw scraped transcripts are intentionally NOT persisted to GM storage.
  // They can run up to MAX_TRANSCRIPT_CHARS (20,000) each, versus a summary
  // at maybe a few hundred - persisting them at scale (a few hundred
  // videos) would turn vorsum_video_cache into a multi-megabyte blob that
  // gets fully re-serialized and rewritten on every single write, which is
  // exactly the "one big JSON blob" cost we specifically avoided for
  // History by using IndexedDB instead. A transcript is only ever useful
  // again within the same click-to-retry chain (a failed summarize attempt
  // retrying moments later) - once a summary exists, the cache-hit check
  // above short-circuits before the transcript is ever touched again. A
  // plain in-memory Map covers that need without persisting anything to
  // disk: gone on page reload, and never grows the on-disk cache at all.
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
    const videoCache = getVideoCache();
    const videoCacheCount = Object.keys(videoCache).length;
    const videoCacheBytes = new Blob([JSON.stringify(videoCache)]).size;

    let historyEntries = [];
    try {
      historyEntries = await historyGetAll();
    } catch (e) {
      log(`Cache size: failed to read history: ${e.message}`, 'warn');
    }
    const historyBytes = historyEntries.reduce((sum, e) => sum + new Blob([JSON.stringify(e)]).size, 0);

    return {
      videoCacheCount,
      videoCacheBytes,
      historyCount: historyEntries.length,
      historyBytes,
      totalBytes: videoCacheBytes + historyBytes,
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
  async function getPlayerResponseViaInnerTube(videoId) {
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
      videoId
    };

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

  // Fallback only - used when the InnerTube path can't even be attempted
  // (no ytcfg/apiKey available for some reason), not as a redundant
  // re-check when InnerTube successfully reports zero captions.
  async function getPlayerResponseViaWatchPage(videoId) {
    log(`Transcript: fetching watch page for ${videoId} (fallback path)`);
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'same-origin' });
    if (!res.ok) {
      log(`Transcript: watch page fetch failed: HTTP ${res.status}`, 'warn');
      return null;
    }
    const html = await res.text();
    log(`Transcript: watch page fetched (${html.length} chars), extracting player response`);

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

  async function getTranscript(videoId) {
    let playerResponse = await getPlayerResponseViaInnerTube(videoId);
    if (playerResponse) {
      log('Transcript: got player response via InnerTube (real session context)');
    } else {
      log('Transcript: InnerTube path unavailable, falling back to watch-page HTML', 'warn');
      playerResponse = await getPlayerResponseViaWatchPage(videoId);
    }
    if (!playerResponse) {
      log('Transcript: could not obtain a player response via any method', 'error');
      return null;
    }

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || !tracks.length) {
      log('Transcript: no captionTracks in player response (video may have no captions)', 'warn');
      return null;
    }

    const track = tracks.find((t) => t.languageCode === 'en') || tracks[0];
    log(`Transcript: found ${tracks.length} track(s), using languageCode=${track.languageCode}`);

    // YouTube has been rolling out a PoToken (proof-of-origin token)
    // requirement on caption track URLs, signaled by an exp=xpe parameter
    // in the baseUrl. When present, the endpoint returns HTTP 200 with an
    // EMPTY body for any request lacking a valid token - not an error
    // status, an empty success - which is exactly what was making this
    // fail silently with no useful log line. Generating a valid PoToken
    // means replicating YouTube's internal BotGuard JS; even
    // youtube-transcript-api (the most widely used library for this)
    // documents no client-side workaround as of 2026. Flagging it up
    // front turns that silent failure into a specific, actionable one.
    const requiresPoToken = /[?&]exp=xpe(&|$)/.test(track.baseUrl);
    if (requiresPoToken) {
      log(
        'Transcript: this caption track requires a PoToken (YouTube anti-bot measure) - direct fetch will likely return an empty response. No client-side fix exists for this; URL mode is the reliable path for this video.',
        'warn'
      );
    }

    // fmt=json3 is what YouTube's own player actually requests and is far
    // more robust to parse than the default XML/TTML response.
    const trackUrl = track.baseUrl.includes('fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;

    const captionRes = await fetch(trackUrl, { credentials: 'same-origin' });
    const bodyText = await captionRes.text();
    log(
      `Transcript: caption fetch HTTP ${captionRes.status}, content-type=${captionRes.headers.get('content-type') || 'unknown'}, body length=${bodyText.length}`
    );

    if (!captionRes.ok) {
      throw new Error(
        `Caption track fetch failed: HTTP ${captionRes.status}${requiresPoToken ? ' (PoToken required - try URL mode)' : ' (likely blocked - try URL mode)'}`
      );
    }

    if (!bodyText.trim()) {
      // The actual PoToken failure mode: HTTP 200, empty body, nothing to
      // throw on. This is the specific case that used to vanish into "no
      // captions available" with no trace of why.
      const reason = requiresPoToken
        ? 'PoToken required by this track - YouTube returned an empty response. No client-side workaround exists; try URL mode for this video.'
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
      // Fall back to XML parsing in case fmt=json3 wasn't honored for this
      // particular track - some auto-generated tracks have been seen
      // ignoring the fmt param and returning XML regardless.
      log(`Transcript: response wasn't valid JSON (${e.message}), trying XML fallback`, 'warn');
      const lines = [...bodyText.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => decodeEntities(m[1]));
      transcript = lines.join(' ').replace(/\s+/g, ' ').trim();
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
    const el =
      card.querySelector('#video-title') ||
      card.querySelector('.yt-lockup-title a') ||
      card.querySelector('.yt-lockup-title') ||
      card.querySelector('.lohp-video-link') || // homepage featured shelf
      card.querySelector('.title[title]') || // watch-page sidebar (span, not the <a>)
      card.querySelector('.ytLockupMetadataViewModelHeadingReset') || // vanilla YouTube -
        // the h3's own title/aria-label is the clean title text; the <a>
        // itself carries a duration-suffixed aria-label instead
      card.querySelector('h1.ytd-watch-metadata yt-formatted-string') || // modern watch-page title
        // (the <h1> holds a yt-formatted-string child whose textContent is
        // the real title)
      card.querySelector('a.yt-uix-sessionlink.spf-link[title]') || // Vorapis watch-page title
        // (the title link carries the clean title in its title attr)
      card.querySelector('a[href*="watch?v="]');
    const text = (el?.getAttribute('aria-label') || el?.getAttribute('title') || el?.textContent || '').trim();
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
        notifyNewHistoryEntry(true);
      }
    };
  } else {
    log('BroadcastChannel unavailable - History notice will only work within this tab', 'warn');
  }

  function notifyNewHistoryEntry(fromRemote = false) {
    pendingNewHistoryCount++;
    renderHistoryNotice();
    if (!fromRemote && historyChannel) {
      try {
        historyChannel.postMessage({ type: 'new-entry' });
      } catch (e) {
        log(`BroadcastChannel postMessage failed: ${e.message}`, 'warn');
      }
    }
    if (!fromRemote) checkCacheThreshold(); // only the tab that actually grew the cache needs to check
  }

  function renderHistoryNotice() {
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

  // ---- Generic small modal (Data & Privacy, History Stats) ----
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
      addModalParagraph(
        body,
        "If you've never done this before: Gemini is the easiest starting point. Go to aistudio.google.com, sign in with a Google account, click 'Get API key', copy the string it gives you, and paste it into vorsum's Gemini API key field above. That's the whole process - no payment details needed for the free tier."
      );
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
        'Generated summaries are cached in two places: a lightweight local key/value store (just the summary text itself, a few hundred characters each) so re-clicking Summarize on a video you already summarized is instant, and a searchable History log in your browser\'s IndexedDB, which also holds the title, channel, and timestamp for each one.'
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
        sizeLine.textContent = `Currently storing ${info.historyCount} summar${info.historyCount === 1 ? 'y' : 'ies'} in History (${formatBytes(info.totalBytes)} total, across the summary cache and History combined).`;
      } catch (e) {
        sizeLine.textContent = 'Could not read cache size right now - see Debugging log.';
      }
    });
  }

  function showHistoryStatsModal() {
    showSimpleModal('History Stats', async (body) => {
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
        addModalParagraph(body, `Total size: ${formatBytes(info.totalBytes)}`);
        if (info.entries.length) {
          const oldest = Math.min(...info.entries.map((e) => e.createdAt));
          const newest = Math.max(...info.entries.map((e) => e.createdAt));
          addModalParagraph(body, `Oldest: ${new Date(oldest).toLocaleDateString()}`);
          addModalParagraph(body, `Newest: ${new Date(newest).toLocaleDateString()}`);
        }
      } catch (e) {
        loading.textContent = 'Could not load stats - see Debugging log.';
      }
    });
  }

  function showDeveloperContactModal() {
    showSimpleModal('Developer Contact', (body) => {
      addModalParagraph(
        body,
        'If you encounter a bug or have a feature request, here\'s what helps the developer diagnose and fix issues quickly:'
      );

      const infoList = document.createElement('div');
      infoList.style.cssText = 'margin:0 0 12px;padding-left:18px';

      const infoItems = [
        'Browser and version (e.g., Chrome 126, Firefox 128)',
        'Userscript manager and version (e.g., Tampermonkey 5.1.1)',
        'Which mode you were using (URL or Caption)',
        'The exact error message or behavior you saw',
        'Steps to reproduce (what you clicked, what happened)',
        'Check the Debug Log (Options → Troubleshooting) and include relevant errors'
      ];

      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:0;padding-left:20px';
      infoItems.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        li.style.cssText = 'margin-bottom:4px;font-size:12px';
        ul.appendChild(li);
      });
      infoList.appendChild(ul);
      body.appendChild(infoList);

      addModalParagraph(
        body,
        'Email: [Your email here - update this before deploying]'
      );

      addModalParagraph(
        body,
        'GitHub: https://github.com/PipettingBeaver/Vorsum'
      );
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
      const cache = getVideoCache();
      deleted.forEach(({ videoId, mode }) => {
        if (cache[videoId]?.summaries) {
          delete cache[videoId].summaries[codeToModeKey(mode)];
          if (Object.keys(cache[videoId].summaries).length === 0) delete cache[videoId];
        }
      });
      GM_setValue('vorsum_video_cache', cache);
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

  function getMastheadOffsetPx() {
    const el = findMastheadEl();
    if (!el) return 8;
    const rect = el.getBoundingClientRect();
    return Math.max(8, Math.round(rect.bottom) + 8);
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

  function applyWidgetTopOffset() {
    const top = `${getMastheadOffsetPx()}px`;
    if (widgetPanelEl) widgetPanelEl.style.top = top;
    if (widgetDotEl) widgetDotEl.style.top = top;
  }

  // A few bounded, one-shot rechecks (not a poll) to catch Vorapis/YouTube
  // still finishing their own masthead layout after our first measurement -
  // this is what "one element too high" turned out to be: we measured
  // before the real masthead height was settled, then nothing ever
  // corrected it since resize doesn't fire on its own. Each timeout clears
  // itself; nothing here runs indefinitely.
  function scheduleTopOffsetRechecks() {
    [300, 800, 1500, 3000, 6000].forEach((delay) => setTimeout(applyWidgetTopOffset, delay));
  }

  // Registered once, not per buildWidget() call, since buildWidget can
  // rerun if YouTube's SPA churn removes the widget - re-adding a listener
  // each time would leak one per rebuild. It always reads the CURRENT
  // widgetPanelEl/widgetDotEl, so it stays correct regardless of rebuilds.
  window.addEventListener('resize', applyWidgetTopOffset);

  function buildWidget() {
    const dot = document.createElement('div');
    dot.id = 'vorsum-widget-dot';
    dot.className = 'vorsum-dot';
    dot.title = 'Show vorsum controls';
    dot.textContent = 'V\u2211';
    dot.style.cssText = [
      'position:fixed',
      'top:8px', // corrected to the real masthead offset below, once known
      'right:8px',
      'z-index:2147483647',
      'padding:2px 6px',
      'font-size:11px !important',
      'font-weight:bold',
      'font-family:sans-serif',
      'line-height:1.2',
      'border-radius:10px',
      'cursor:pointer',
      'box-shadow:0 1px 3px rgba(0,0,0,0.4)',
      'display:none'
    ].join(';');

    const panel = document.createElement('div');
    panel.id = 'vorsum-widget';
    panel.className = 'vorsum-widget-panel';
    panel.style.cssText = [
      'position:fixed',
      'top:8px', // corrected to the real masthead offset below, once known
      'right:8px',
      'z-index:2147483647',
      'border-width:1px',
      'border-style:solid',
      'border-radius:4px',
      'padding:6px 8px',
      'font-size:11px !important',
      'font-family:sans-serif',
      'box-shadow:0 1px 3px rgba(0,0,0,0.25)',
      'display:flex',
      'flex-direction:column',
      'gap:4px',
      'width:260px',
      'max-height:80vh',
      'overflow-y:auto'
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

    // Theme and Mode compacted down to single glyph/letter buttons living
    // in the title row itself, rather than a whole extra row each -
    // tooltips still carry the full description for anyone unsure what
    // the glyph means.
    const themeBtn = document.createElement('button');
    themeBtn.className = 'vorsum-ctrl-btn';
    themeBtn.style.cssText = squareBtnStyle;

    const modeBtn = document.createElement('button');
    modeBtn.className = 'vorsum-ctrl-btn';
    modeBtn.style.cssText = squareBtnStyle;

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
    helpBtn.addEventListener('click', () => showOnboarding());

    row1.appendChild(title);
    row1.appendChild(themeBtn);
    row1.appendChild(modeBtn);
    row1.appendChild(helpBtn);
    row1.appendChild(minBtn);

    const debugBtn = document.createElement('button');
    debugBtn.className = 'vorsum-ctrl-btn';
    debugBtn.style.cssText = btnStyle;

    const historyOptionsRow = document.createElement('div');
    historyOptionsRow.style.cssText = 'display:flex;gap:4px';

    const historyBtn = document.createElement('button');
    historyBtn.className = 'vorsum-ctrl-btn';
    historyBtn.style.cssText = btnStyle + ';flex:1';
    historyBtn.textContent = 'History';

    const optionsBtn = document.createElement('button');
    optionsBtn.className = 'vorsum-ctrl-btn';
    optionsBtn.style.cssText = btnStyle + ';flex:1';
    optionsBtn.textContent = 'Options';

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
    updateNotice.title = 'Open the vorsum repo on GitHub';
    updateNotice.addEventListener('click', () => window.open(REPO_PAGE_URL, '_blank'));
    updateNoticeEl = updateNotice;

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

    historyOptionsRow.appendChild(historyBtn);
    historyOptionsRow.appendChild(optionsBtn);

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
    historyPanel.style.cssText = 'display:none;flex-direction:column;gap:4px';

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
    statsBtn.textContent = 'Stats';
    statsBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    statsBtn.addEventListener('click', showHistoryStatsModal);

    loadMoreRow.appendChild(loadMoreBtn);
    loadMoreRow.appendChild(statsBtn);

    const clearHistoryBtn = document.createElement('button');
    clearHistoryBtn.className = 'vorsum-ctrl-btn vorsum-danger-btn';
    clearHistoryBtn.textContent = 'Clear all history';
    clearHistoryBtn.style.cssText = btnStyle;

    const exportRow = document.createElement('div');
    exportRow.style.cssText = 'display:flex;gap:4px';

    const exportJsonBtn = document.createElement('button');
    exportJsonBtn.className = 'vorsum-ctrl-btn';
    exportJsonBtn.textContent = 'Export JSON';
    exportJsonBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    exportJsonBtn.addEventListener('click', () => exportHistory('json'));

    const exportCsvBtn = document.createElement('button');
    exportCsvBtn.className = 'vorsum-ctrl-btn';
    exportCsvBtn.textContent = 'Export CSV';
    exportCsvBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    exportCsvBtn.addEventListener('click', () => exportHistory('csv'));

    exportRow.appendChild(exportJsonBtn);
    exportRow.appendChild(exportCsvBtn);

    historyPanel.appendChild(searchInput);
    historyPanel.appendChild(historyList);
    historyPanel.appendChild(loadMoreRow);
    historyPanel.appendChild(exportRow);
    historyPanel.appendChild(clearHistoryBtn);

    // -- options panel (accessibility + prompt customization) --
    const optionsPanel = document.createElement('div');
    optionsPanel.style.cssText = 'display:none;flex-direction:column;gap:6px';

    // Helper: Create collapsible section
    function createCollapsibleSection(title, initiallyOpen = false) {
      const section = document.createElement('div');
      section.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:8px';

      const header = document.createElement('button');
      header.className = 'vorsum-ctrl-btn';
      header.style.cssText = btnStyle + ';width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center';

      const headerText = document.createElement('span');
      headerText.textContent = title;

      const arrow = document.createElement('span');
      arrow.textContent = initiallyOpen ? '▴' : '▾';
      arrow.style.cssText = 'font-size:10px !important';

      header.appendChild(headerText);
      header.appendChild(arrow);

      const body = document.createElement('div');
      body.style.cssText = `display:${initiallyOpen ? 'flex' : 'none'};flex-direction:column;gap:4px;margin-top:4px;padding-left:8px`;

      header.addEventListener('click', () => {
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'flex';
        arrow.textContent = isOpen ? '▾' : '▴';
      });

      section.appendChild(header);
      section.appendChild(body);
      registerThemedEl(header);

      return { section, body };
    }

    // -- API key (view/test/change) --
    const apiKeyLabel = document.createElement('div');
    apiKeyLabel.className = 'vorsum-label';
    apiKeyLabel.style.cssText = 'font-size:10px !important';
    apiKeyLabel.textContent = "API provider selected here. Google's Gemini has free API access, and is the only provider that works with URL mode.";

    const apiKeyRow = document.createElement('div');
    apiKeyRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:8px';

    const apiKeyValue = document.createElement('span');
    apiKeyValue.style.cssText = 'flex:1;font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const apiKeyTestBtn = document.createElement('button');
    apiKeyTestBtn.className = 'vorsum-ctrl-btn';
    apiKeyTestBtn.textContent = 'Test';
    apiKeyTestBtn.style.cssText = btnStyle + ';padding:2px 8px;text-align:center';

    const apiKeyChangeBtn = document.createElement('button');
    apiKeyChangeBtn.className = 'vorsum-ctrl-btn';
    apiKeyChangeBtn.textContent = 'Change';
    apiKeyChangeBtn.style.cssText = btnStyle + ';padding:2px 8px;text-align:center';

    function maskApiKey(key) {
      if (!key) return '(not set)';
      if (key.length <= 8) return '•'.repeat(key.length);
      return `${key.slice(0, 4)}${'•'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
    }
    function renderApiKeyValue() {
      apiKeyValue.textContent = maskApiKey(GM_getValue('gemini_api_key', ''));
    }

    apiKeyChangeBtn.addEventListener('click', () => {
      const next = prompt('Enter your Gemini API key (from aistudio.google.com):', '') || '';
      if (next) {
        GM_setValue('gemini_api_key', next);
        setOnboarded(true); // a real key now exists somewhere - stop nagging on every load
        renderNoKeyNotice();
        renderApiKeyValue();
        log('API key updated');
      }
    });

    apiKeyTestBtn.addEventListener('click', () => {
      const key = GM_getValue('gemini_api_key', '');
      if (!key) {
        apiKeyTestBtn.textContent = 'No key set';
        setTimeout(() => (apiKeyTestBtn.textContent = 'Test'), 2000);
        return;
      }
      apiKeyTestBtn.textContent = 'Testing…';
      apiKeyTestBtn.disabled = true;
      log('Testing API key...');
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/interactions?key=${key}`,
        headers: { 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
        timeout: 15000,
        data: JSON.stringify({ model: MODEL, input: [{ type: 'text', text: 'Reply with only the word: OK' }] }),
        onload: (res) => {
          apiKeyTestBtn.disabled = false;
          let data = null;
          try {
            data = JSON.parse(res.responseText);
          } catch (e) {
            /* leave data null, handled below */
          }
          // Same check as the Options/Caption-mode LLM test and
          // onboarding's own Test & Save - requires actual generated
          // text, not just the absence of an .error field. A malformed
          // key can come back as a 200 with no error object AND no real
          // text, which read as "success" before this fix.
          const result = data ? LLM_PROVIDERS.gemini.parseResponse(data) : { error: `HTTP ${res.status}, invalid JSON` };
          if (result.text) {
            apiKeyTestBtn.textContent = '✓ Works';
            apiKeyTestBtn.title = '';
            log('API key test succeeded');
          } else {
            const msg = result.error || `HTTP ${res.status}`;
            apiKeyTestBtn.textContent = '✗ Failed';
            apiKeyTestBtn.title = msg;
            log(`API key test failed: ${msg}`, 'warn');
          }
          setTimeout(() => {
            apiKeyTestBtn.textContent = 'Test';
            apiKeyTestBtn.title = '';
          }, 4000);
        },
        ontimeout: () => {
          apiKeyTestBtn.disabled = false;
          apiKeyTestBtn.textContent = '✗ Timeout';
          log('API key test timed out', 'warn');
          setTimeout(() => (apiKeyTestBtn.textContent = 'Test'), 4000);
        },
        onerror: () => {
          apiKeyTestBtn.disabled = false;
          apiKeyTestBtn.textContent = '✗ Error';
          log('API key test: network error', 'warn');
          setTimeout(() => (apiKeyTestBtn.textContent = 'Test'), 4000);
        }
      });
    });

    apiKeyRow.appendChild(apiKeyValue);
    apiKeyRow.appendChild(apiKeyTestBtn);
    apiKeyRow.appendChild(apiKeyChangeBtn);


    // -- Caption mode LLM provider (URL mode stays Gemini-only, see the
    // comment on LLM_PROVIDERS for why) --
    const llmLabel = document.createElement('div');
    llmLabel.className = 'vorsum-label';
    llmLabel.style.cssText = 'font-size:10px !important;margin-top:8px';
    llmLabel.textContent = 'Caption mode LLM provider';

    const llmDisclaimer = document.createElement('div');
    llmDisclaimer.className = 'vorsum-label';
    llmDisclaimer.style.cssText = 'font-size:10px !important;line-height:1.3;margin-bottom:4px';
    llmDisclaimer.textContent =
      'Caption mode only ever sees the video\'s transcript text - no visuals, tone, on-screen text, or audio beyond speech. URL mode (Gemini only) watches the actual video and is more capable, at the cost of being slower.';

    const llmProviderSelect = document.createElement('select');
    llmProviderSelect.className = 'vorsum-select';
    llmProviderSelect.style.cssText = 'font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px;width:100%';
    Object.entries(LLM_PROVIDERS).forEach(([key, p]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.label;
      llmProviderSelect.appendChild(opt);
    });

    const llmFieldsWrap = document.createElement('div');
    llmFieldsWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px';

    const anthKeyRow = document.createElement('div');
    anthKeyRow.style.cssText = 'display:flex;gap:4px';
    const anthKeyInput = document.createElement('input');
    anthKeyInput.type = 'password';
    anthKeyInput.className = 'vorsum-search-input';
    anthKeyInput.placeholder = 'Anthropic API key';
    anthKeyInput.style.cssText = 'flex:1;font-size:11px !important;padding:3px 5px;border-width:1px;border-style:solid;border-radius:3px';
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

    const geminiNote = document.createElement('div');
    geminiNote.className = 'vorsum-label';
    geminiNote.style.cssText = 'font-size:10px !important';
    geminiNote.textContent = 'Uses the Gemini API key above.';

    anthKeyRow.appendChild(anthKeyInput);
    llmFieldsWrap.appendChild(geminiNote);
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
    llmTestBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    const llmHelpBtn = document.createElement('button');
    llmHelpBtn.className = 'vorsum-ctrl-btn';
    llmHelpBtn.textContent = 'Help';
    llmHelpBtn.title = 'New to API keys? Explains how they work and that Gemini has a free tier';
    llmHelpBtn.style.cssText = btnStyle + ';flex:1;text-align:center';
    llmHelpBtn.addEventListener('click', showApiKeyHelpModal);
    llmTestRow.appendChild(llmTestBtn);
    llmTestRow.appendChild(llmHelpBtn);

    function renderLlmFields() {
      const provider = getLlmProvider();
      llmProviderSelect.value = provider;
      geminiNote.style.display = provider === 'gemini' ? 'block' : 'none';
      anthKeyRow.style.display = provider === 'anthropic' ? 'flex' : 'none';
      anthModelInput.style.display = provider === 'anthropic' ? 'block' : 'none';
      oaiKeyInput.style.display = provider === 'openai_compatible' ? 'block' : 'none';
      oaiBaseUrlInput.style.display = provider === 'openai_compatible' ? 'block' : 'none';
      oaiModelInput.style.display = provider === 'openai_compatible' ? 'block' : 'none';

      const creds = getProviderCredentials(provider);
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
      renderLlmFields();
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

    // -- Download captions instead of summarizing --
    const downloadCaptionsRow = document.createElement('label');
    downloadCaptionsRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;cursor:pointer';
    const downloadCaptionsCheckbox = document.createElement('input');
    downloadCaptionsCheckbox.type = 'checkbox';
    downloadCaptionsCheckbox.checked = getDownloadCaptionsEnabled();
    downloadCaptionsCheckbox.addEventListener('change', () => {
      setDownloadCaptionsEnabled(downloadCaptionsCheckbox.checked);
      log(`Download captions instead of summarizing: ${downloadCaptionsCheckbox.checked}`);
    });
    const downloadCaptionsText = document.createElement('span');
    downloadCaptionsText.textContent = 'Download captions instead of summarizing (Caption mode; skips the LLM call entirely)';
    downloadCaptionsRow.appendChild(downloadCaptionsCheckbox);
    downloadCaptionsRow.appendChild(downloadCaptionsText);

    // -- Show transcript download button --
    const transcriptButtonRow = document.createElement('label');
    transcriptButtonRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;cursor:pointer';
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
    transcriptButtonText.textContent = 'Show transcript download button (T) next to summarize button';
    transcriptButtonRow.appendChild(transcriptButtonCheckbox);
    transcriptButtonRow.appendChild(transcriptButtonText);

    // -- Hover-reveal (DeArrow-style) --
    const hoverOnlyRow = document.createElement('label');
    hoverOnlyRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;cursor:pointer';
    const hoverOnlyCheckbox = document.createElement('input');
    hoverOnlyCheckbox.type = 'checkbox';
    hoverOnlyCheckbox.checked = getHoverOnlyEnabled();
    hoverOnlyCheckbox.addEventListener('change', () => {
      setHoverOnlyEnabled(hoverOnlyCheckbox.checked);
      applyHoverOnlySetting();
      log(`Hover-reveal: ${hoverOnlyCheckbox.checked}`);
    });
    const hoverOnlyText = document.createElement('span');
    hoverOnlyText.textContent = `Hide \u2211 until hovering the video (auto-detected: ${isMobileDevice() ? 'touch device, off by default' : 'has hover, on by default'})`;
    hoverOnlyRow.appendChild(hoverOnlyCheckbox);
    hoverOnlyRow.appendChild(hoverOnlyText);

    const fontLabel = document.createElement('div');
    fontLabel.className = 'vorsum-label';
    fontLabel.style.cssText = 'font-size:10px !important';
    fontLabel.textContent = 'Summary text size (inline + History)';

    const fontRow = document.createElement('div');
    fontRow.style.cssText = 'display:flex;align-items:center;gap:4px';

    // A 1px-granularity slider instead of 5 named steps - finer control,
    // and there's no real value in naming the sizes in between.
    const fontSlider = document.createElement('input');
    fontSlider.type = 'range';
    fontSlider.min = String(MIN_FONT_SIZE_PX);
    fontSlider.max = String(MAX_FONT_SIZE_PX);
    fontSlider.step = '1';
    fontSlider.style.cssText = 'flex:1';

    const fontCurrentLabel = document.createElement('span');
    fontCurrentLabel.style.cssText = 'width:36px;text-align:center;font-size:11px !important';

    const fontResetBtn = document.createElement('button');
    fontResetBtn.className = 'vorsum-ctrl-btn';
    fontResetBtn.textContent = 'Reset';
    fontResetBtn.style.cssText = btnStyle + ';text-align:center';

    fontRow.appendChild(fontSlider);
    fontRow.appendChild(fontCurrentLabel);
    fontRow.appendChild(fontResetBtn);

    function renderFontRow() {
      const px = getFontSizePx();
      fontSlider.value = String(px);
      fontCurrentLabel.textContent = `${px}px`;
    }

    fontSlider.addEventListener('input', () => {
      setFontSizePx(Number(fontSlider.value));
      applyFontSize();
      renderFontRow();
    });
    fontSlider.addEventListener('change', () => {
      log(`Summary font size set to ${getFontSizePx()}px`);
    });

    fontResetBtn.addEventListener('click', () => {
      setFontSizePx(DEFAULT_FONT_SIZE_PX);
      applyFontSize();
      renderFontRow();
      log('Summary font size reset to default');
    });

    const promptLabel = document.createElement('div');
    promptLabel.className = 'vorsum-label';
    promptLabel.style.cssText = 'font-size:10px !important;margin-top:2px';
    promptLabel.textContent = 'Custom summarization prompt (blank = default)';

    const promptTextarea = document.createElement('textarea');
    promptTextarea.className = 'vorsum-textarea';
    promptTextarea.placeholder = SUMMARY_PROMPT;
    promptTextarea.value = getCustomPrompt();
    promptTextarea.rows = 4;
    promptTextarea.style.cssText = 'font-size:11px !important;padding:4px 5px;border-width:1px;border-style:solid;border-radius:3px;font-family:inherit;resize:vertical';

    const promptButtonsRow = document.createElement('div');
    promptButtonsRow.style.cssText = 'display:flex;gap:4px';

    const savePromptBtn = document.createElement('button');
    savePromptBtn.className = 'vorsum-ctrl-btn';
    savePromptBtn.textContent = 'Save prompt';
    savePromptBtn.style.cssText = btnStyle + ';flex:1';
    savePromptBtn.addEventListener('click', () => {
      setCustomPrompt(promptTextarea.value);
      log('Custom prompt saved' + (promptTextarea.value.trim() ? '' : ' (empty - using default)'));
      savePromptBtn.textContent = 'Saved!';
      setTimeout(() => (savePromptBtn.textContent = 'Save prompt'), 1000);
    });

    const resetPromptBtn = document.createElement('button');
    resetPromptBtn.className = 'vorsum-ctrl-btn';
    resetPromptBtn.textContent = 'Reset to default';
    resetPromptBtn.style.cssText = btnStyle + ';flex:1';
    resetPromptBtn.addEventListener('click', () => {
      promptTextarea.value = '';
      setCustomPrompt('');
      log('Custom prompt cleared - using default');
    });

    promptButtonsRow.appendChild(savePromptBtn);
    promptButtonsRow.appendChild(resetPromptBtn);

    // -- data & privacy / cache size (created before Options panel reorganization) --
    const dataRow = document.createElement('div');
    dataRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:8px';

    const cacheSizeLine = document.createElement('span');
    cacheSizeLine.className = 'vorsum-label';
    cacheSizeLine.style.cssText = 'flex:1;font-size:10px !important';
    cacheSizeLine.textContent = 'Cache: —';

    const dataDesignBtn = document.createElement('button');
    dataDesignBtn.className = 'vorsum-ctrl-btn';
    dataDesignBtn.textContent = 'Data & Privacy';
    dataDesignBtn.style.cssText = btnStyle + ';text-align:center';
    dataDesignBtn.addEventListener('click', showDataDesignModal);

    async function refreshCacheSizeLine() {
      try {
        const info = await getCacheSizeInfo();
        cacheSizeLine.textContent = `Cache: ${info.historyCount} video${info.historyCount === 1 ? '' : 's'} · ${formatBytes(info.totalBytes)}`;
      } catch (e) {
        cacheSizeLine.textContent = 'Cache: (unavailable)';
      }
    }

    dataRow.appendChild(cacheSizeLine);
    dataRow.appendChild(dataDesignBtn);

    // Debugging label (for collapsible section later)
    const debugLabel = document.createElement('div');
    debugLabel.className = 'vorsum-label';
    debugLabel.style.cssText = 'font-size:10px !important;margin-bottom:4px';
    debugLabel.textContent = 'Debug log';

    // ---- REORGANIZED OPTIONS PANEL ----
    // Easy access items at the top
    optionsPanel.appendChild(fontLabel);
    optionsPanel.appendChild(fontRow);
    optionsPanel.appendChild(downloadCaptionsRow);
    optionsPanel.appendChild(transcriptButtonRow);
    optionsPanel.appendChild(hoverOnlyRow);

    // FAQ/Help button (links to onboarding)
    const faqBtn = document.createElement('button');
    faqBtn.className = 'vorsum-ctrl-btn';
    faqBtn.textContent = '❓ FAQ / Show intro again';
    faqBtn.style.cssText = btnStyle + ';width:100%;text-align:center;margin-top:6px';
    faqBtn.addEventListener('click', () => showOnboarding());
    optionsPanel.appendChild(faqBtn);
    registerThemedEl(faqBtn);

    // Data & Privacy at top
    optionsPanel.appendChild(dataRow);

    // ---- COLLAPSIBLE SECTIONS ----

    // 1. API Configuration
    const apiSection = createCollapsibleSection('API Configuration', false);
    apiSection.body.appendChild(apiKeyLabel);
    apiSection.body.appendChild(apiKeyRow);
    apiSection.body.appendChild(llmLabel);
    apiSection.body.appendChild(llmDisclaimer);
    apiSection.body.appendChild(llmProviderSelect);
    apiSection.body.appendChild(llmFieldsWrap);
    apiSection.body.appendChild(llmTestRow);
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

    // Developer Contact button
    const devContactBtn = document.createElement('button');
    devContactBtn.className = 'vorsum-ctrl-btn';
    devContactBtn.textContent = '📧 Developer Contact';
    devContactBtn.style.cssText = btnStyle + ';width:100%;text-align:center;margin-bottom:6px';
    devContactBtn.addEventListener('click', showDeveloperContactModal);
    troubleshootSection.body.appendChild(devContactBtn);
    registerThemedEl(devContactBtn);

    troubleshootSection.body.appendChild(debugLabel);
    troubleshootSection.body.appendChild(debugBtn);
    troubleshootSection.body.appendChild(logPanel);
    troubleshootSection.body.appendChild(logButtonsRow);
    optionsPanel.appendChild(troubleshootSection.section);


    function renderModeBtn() {
      const mode = getMode();
      modeBtn.textContent = mode === 'url' ? 'U' : 'C';
      modeBtn.title =
        (mode === 'url' ? 'Mode: URL (Gemini watches the video)' : 'Mode: Captions (transcript, selectable LLM)') +
        ' - click to switch';
    }

    function renderDebugBtn() {
      const on = getDebugOn();
      debugBtn.textContent = on ? 'Debug: ON' : 'Debug: off';
      logPanel.style.display = on ? 'block' : 'none';
      logButtonsRow.style.display = on ? 'flex' : 'none';
    }

    function renderHistoryEntry(entry) {
      const row = document.createElement('div');
      row.className = 'vorsum-history-row';
      row.style.cssText = 'display:flex;gap:6px;border-bottom-width:1px;border-bottom-style:solid;padding-bottom:6px';

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
      summaryEl.style.cssText = 'display:none;margin-top:2px;line-height:1.3';
      summaryEl.textContent = entry.summary;
      registerScalableSummaryEl(summaryEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display:flex;gap:4px;margin-top:2px';

      const viewBtn = document.createElement('button');
      viewBtn.className = 'vorsum-ctrl-btn';
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
      col.appendChild(summaryEl);

      row.appendChild(thumb);
      row.appendChild(col);
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

    clearHistoryBtn.addEventListener('click', async () => {
      if (!confirm('Delete all vorsum summary history? This cannot be undone.')) return;
      await historyClearAll();
      historyList.replaceChildren();
      log('History: cleared all entries', 'warn');
      loadHistory(true);
    });

    function renderThemeBtn() {
      const theme = getTheme();
      themeBtn.textContent = theme === 'dark' ? '\u263E' : '\u2600';
      themeBtn.title = `Theme: ${theme === 'dark' ? 'Dark' : 'Light'} - click to switch (widget + Summarize buttons)`;
    }

    themeBtn.addEventListener('click', () => {
      const newTheme = getTheme() === 'dark' ? 'light' : 'dark';
      setTheme(newTheme);
      applyTheme();
      renderThemeBtn();
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

    historyBtn.addEventListener('click', () => {
      const showing = historyPanel.style.display !== 'none';
      historyPanel.style.display = showing ? 'none' : 'flex';
      historyPanelOpen = !showing;
      if (!showing) {
        loadHistory(true);
        pendingNewHistoryCount = 0;
        renderHistoryNotice();
      }
    });

    historyNotice.addEventListener('click', () => {
      historyPanel.style.display = 'flex';
      historyPanelOpen = true;
      loadHistory(true);
      pendingNewHistoryCount = 0;
      renderHistoryNotice();
    });

    optionsBtn.addEventListener('click', () => {
      const showing = optionsPanel.style.display !== 'none';
      optionsPanel.style.display = showing ? 'none' : 'flex';
      if (!showing) refreshCacheSizeLine();
    });

    clearBtn.addEventListener('click', () => {
      logBuffer.length = 0;
      renderFullLog();
    });

    copyBtn.addEventListener('click', async () => {
      const text = logBuffer.map((e) => e.line).join('\n');
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
      dot.style.display = 'block';
    }
    function expand() {
      setWidgetCollapsed(false);
      panel.style.display = 'flex';
      dot.style.display = 'none';
    }
    minBtn.addEventListener('click', collapse);
    dot.addEventListener('click', expand);

    // Lets onboarding's "advanced/custom provider" path jump straight to
    // the real Options UI (dropdown + per-provider fields + Test button)
    // instead of duplicating that whole form inside the onboarding modal.
    openCaptionProviderSettings = () => {
      expand();
      optionsPanel.style.display = 'flex';
      refreshCacheSizeLine();
      llmProviderSelect.scrollIntoView({ block: 'center' });
      llmProviderSelect.focus();
    };

    panel.appendChild(row1);
    panel.appendChild(historyOptionsRow);
    panel.appendChild(historyNotice);
    panel.appendChild(cacheWarningNotice);
    panel.appendChild(rateLimitNotice);
    panel.appendChild(updateNotice);
    panel.appendChild(noKeyNotice);
    panel.appendChild(historyPanel);
    panel.appendChild(optionsPanel);

    renderThemeBtn();
    renderModeBtn();
    renderDebugBtn();
    renderFontRow();
    renderApiKeyValue();
    renderLlmFields();

    document.documentElement.appendChild(panel);
    document.documentElement.appendChild(dot);

    registerThemedSubtree(panel);
    registerThemedEl(dot);

    widgetPanelEl = panel;
    widgetDotEl = dot;
    applyWidgetTopOffset();

    if (getWidgetCollapsed()) collapse();

    renderHistoryNotice();
    renderRateLimitNotice();
    renderUpdateNotice();
    renderNoKeyNotice();
    renderFullLog();
    log('Widget initialized');
  }

  let onboardingModalOpen = false;

  function showOnboarding() {
    if (onboardingModalOpen) return; // don't stack a second modal if already open
    onboardingModalOpen = true;

    let screen = 1;
    let advancedOpen = false;
    let countdownTimer = null;

    const backdrop = document.createElement('div');
    backdrop.className = 'vorsum-modal-backdrop';
    backdrop.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px';

    const modal = document.createElement('div');
    modal.className = 'vorsum-modal';
    modal.style.cssText =
      'max-width:480px;width:100%;max-height:85vh;overflow-y:auto;border-width:1px;border-style:solid;border-radius:6px;padding:16px;font-family:sans-serif;font-size:13px;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,0.35)';

    const body = document.createElement('div');
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.documentElement.appendChild(backdrop);

    function close() {
      if (countdownTimer) clearInterval(countdownTimer);
      // Reaching screen 3 requires a saved key (gated on screen 2's "\u2192
      // How to use vorsum" button), so exiting from screen 3 - by any
      // means - is the actual finish condition, not just opening the modal
      // or saving a key on screen 2.
      if (screen === 3) setOnboarded(true);
      backdrop.remove();
      onboardingModalOpen = false;
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      // Only allow Escape to close on screen 3, matching the click-outside behavior
      if (e.key === 'Escape' && screen === 3) close();
    }
    // Click-outside-to-close is intentionally absent on screens 1-2 (see
    // the comment above), but re-enabled specifically for screen 3, since
    // "clicking off" the final screen is the described way to finish -
    // and at that point there's nothing left to accidentally lose.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && screen === 3) close();
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
    function btn(text, cls) {
      const b = document.createElement('button');
      b.className = cls || 'vorsum-ctrl-btn';
      b.textContent = text;
      b.style.cssText =
        'padding:6px 14px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important';
      return b;
    }

    function render() {
      // replaceChildren() (a real DOM API), not innerHTML='' - Trusted
      // Types CSP was blocking the innerHTML setter outright on at least
      // one real setup, which is exactly why this modal was rendering
      // completely empty: render() threw right here, before anything
      // below ever got a chance to append.
      body.replaceChildren();
      try {
        if (screen === 1) renderScreen1();
        else if (screen === 2) renderScreen2();
        else if (screen === 3) renderScreen3();
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
      registerThemedSubtree(backdrop);
    }

    // ---- Screen 1: intro ----
    function renderScreen1() {
      body.appendChild(heading('Welcome to vorsum'));

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
        para(
          "vorsum drops a \u2211 button on videos you don't have time to watch right now. Hover a video, click \u2211, get a few sentences back - enough to decide whether it's worth coming back to, or enough on its own if it isn't."
        )
      );
      body.appendChild(para('One thing before you start: summarizing needs an API key - a free one takes about a minute to set up on the next screen.'));

      const nextRow = document.createElement('div');
      nextRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:4px';

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

      const nextBtn = btn('Set up API key \u2192');
      nextBtn.addEventListener('click', () => {
        screen = 2;
        render();
      });
      nextRow.appendChild(skipBtn);
      nextRow.appendChild(nextBtn);
      body.appendChild(nextRow);

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

    // ---- Screen 2: instant setup ----
    function renderScreen2() {
      // Declare references for elements we need to update dynamically
      let nextToScreen3, hint;

      function updateNextButtonState() {
        const hasKey = hasAnyApiKeyConfigured();
        if (nextToScreen3) {
          nextToScreen3.disabled = !hasKey;
          nextToScreen3.style.opacity = hasKey ? '1' : '0.5';
        }
        if (hint) {
          hint.style.display = hasKey ? 'none' : 'block';
        }
      }

      body.appendChild(heading('Instant setup'));
      body.appendChild(heading('Get fast summaries with a free Gemini key', 'sub'));

      const steps = document.createElement('ol');
      steps.style.cssText = 'margin:0 0 12px;padding-left:18px';
      const step1 = document.createElement('li');
      step1.style.cssText = 'margin-bottom:4px';
      step1.textContent = 'Open the link below, click "Create API key," then paste it into the box here.';
      steps.appendChild(step1);
      body.appendChild(steps);

      const recommendedLine = document.createElement('div');
      recommendedLine.style.cssText = 'font-size:11px;margin-bottom:8px';
      recommendedLine.textContent = '\u25cf Recommended: free Gemini API key (fastest & simplest)';
      body.appendChild(recommendedLine);

      const linkBtn = document.createElement('button');
      linkBtn.className = 'vorsum-ctrl-btn';
      linkBtn.textContent = '\ud83d\udd11 Get free Gemini key';
      linkBtn.style.cssText =
        'padding:6px 10px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:11px !important;width:100%;margin-bottom:6px';
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
            // Update the "\u2192 How to use Vorsum" button state after key validation
            updateNextButtonState();
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
        advancedBody.appendChild(
          para(
            "Warning! Advanced models require setting up custom API endpoints, base URLs, or local CORS settings. If you haven't used API tools before, I recommend starting with the default Gemini setup.",
            true
          )
        );
        const choiceRow = document.createElement('div');
        choiceRow.style.cssText = 'display:flex;gap:6px';
        const backBtn = document.createElement('button');
        backBtn.className = 'vorsum-ctrl-btn';
        backBtn.textContent = 'Take me back for now';
        backBtn.style.cssText = 'flex:1;padding:5px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important';
        backBtn.addEventListener('click', () => {
          advancedOpen = false;
          render();
        });

        const knowBtn = document.createElement('button');
        knowBtn.className = 'vorsum-ctrl-btn';
        knowBtn.disabled = true;
        let remaining = 5;
        knowBtn.textContent = `I know what I'm doing (${remaining})`;
        knowBtn.style.cssText = 'flex:1;padding:5px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important';
        countdownTimer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            knowBtn.disabled = false;
            knowBtn.textContent = "I know what I'm doing";
          } else {
            knowBtn.textContent = `I know what I'm doing (${remaining})`;
          }
        }, 1000);
        knowBtn.addEventListener('click', () => {
          close();
          if (openCaptionProviderSettings) openCaptionProviderSettings();
        });

        choiceRow.appendChild(backBtn);
        choiceRow.appendChild(knowBtn);
        advancedBody.appendChild(choiceRow);
      }

      // -- technical details (nested popup) --
      const techBtn = document.createElement('button');
      techBtn.className = 'vorsum-ctrl-btn';
      techBtn.textContent = "\ud83e\udd13 I want to know the technical details!";
      techBtn.style.cssText =
        'margin-top:12px;padding:5px 8px;border-width:1px;border-style:solid;border-radius:3px;cursor:pointer;font-size:11px !important;width:100%;text-align:center';
      techBtn.addEventListener('click', showTechDetails);
      body.appendChild(techBtn);

      const backRow = document.createElement('div');
      backRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:14px';
      const backAndNextRow = document.createElement('div');
      backAndNextRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
      const backToIntro = document.createElement('button');
      backToIntro.className = 'vorsum-ctrl-btn';
      backToIntro.textContent = '\u2190 Back';
      backToIntro.style.cssText = 'padding:6px 14px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important';
      backToIntro.addEventListener('click', () => {
        screen = 1;
        render();
      });
      // Reaching screen 3 requires a real key - that's what makes it the
      // actual finish condition (see close()) instead of this screen.
      nextToScreen3 = btn('\u2192 How to use Vorsum');
      nextToScreen3.addEventListener('click', () => {
        if (!hasAnyApiKeyConfigured()) return;
        screen = 3;
        render();
      });
      backAndNextRow.appendChild(backToIntro);
      backAndNextRow.appendChild(nextToScreen3);
      backRow.appendChild(backAndNextRow);

      // Always create hint element, control visibility via updateNextButtonState()
      hint = document.createElement('div');
      hint.className = 'vorsum-label';
      hint.style.cssText = 'font-size:10px !important;text-align:right';
      hint.textContent = 'Save a key above first (Gemini, or Advanced \u2192 Test & Save)';
      backRow.appendChild(hint);

      body.appendChild(backRow);

      // Initialize button state based on current key availability
      updateNextButtonState();
    }

    // ---- Screen 3: how to use vorsum ----
    function renderScreen3() {
      body.appendChild(heading('How to use vorsum'));

      const demoWrap = document.createElement('div');
      demoWrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px';
      const demoBtn = document.createElement('div'); // illustrative only, not a real button
      demoBtn.className = 'vorsum-btn';
      demoBtn.textContent = '\u2211';
      demoBtn.setAttribute('aria-hidden', 'true');
      demoBtn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;border-width:1px;border-style:solid;border-radius:3px;font-size:14px !important;flex-shrink:0';
      const demoText = document.createElement('div');
      demoText.style.cssText = 'font-size:12px';
      demoText.textContent = 'This appears when you hover near a video card or its title. Click it to get a summary.';
      demoWrap.appendChild(demoBtn);
      demoWrap.appendChild(demoText);
      body.appendChild(demoWrap);
      registerThemedEl(demoBtn); // themed like a real button, even though it's just a mockup here

      body.appendChild(para('\u2211 can work one of two ways:'));

      const modesBox = document.createElement('div');
      modesBox.className = 'vorsum-history-row'; // reuse for a subtle bordered box, already themed
      modesBox.style.cssText = 'border-width:1px;border-style:solid;border-radius:4px;padding:8px;margin-bottom:12px;font-size:11px;line-height:1.5';
      const urlLine = document.createElement('div');
      urlLine.textContent = 'URL \u2014 slower, but works for every video';
      urlLine.style.cssText = 'margin-bottom:4px';
      const capLine = document.createElement('div');
      capLine.textContent = "Caption \u2014 faster, but doesn't work for music or when captions are disabled";
      modesBox.appendChild(urlLine);
      modesBox.appendChild(capLine);
      body.appendChild(modesBox);

      const optionsPara = document.createElement('p');
      optionsPara.style.cssText = 'margin:0 0 12px';
      optionsPara.appendChild(document.createTextNode('In Options: switch light/dark theme ('));
      optionsPara.appendChild(document.createTextNode('\u2600/\u263e'));
      optionsPara.appendChild(document.createTextNode(' at the top), replay this intro any time ('));
      const qMark = document.createElement('span');
      qMark.textContent = '?';
      optionsPara.appendChild(qMark);
      optionsPara.appendChild(
        document.createTextNode(
          '), resize summary text, or set \u2211 to skip the LLM entirely and just download the transcript.'
        )
      );
      body.appendChild(optionsPara);

      body.appendChild(para('Have fun!'));

      const finishRow = document.createElement('div');
      finishRow.style.cssText = 'display:flex;justify-content:space-between;margin-top:4px';
      const backToTwo = document.createElement('button');
      backToTwo.className = 'vorsum-ctrl-btn';
      backToTwo.textContent = '\u2190 Back';
      backToTwo.style.cssText = 'padding:6px 14px;border-width:1px;border-style:solid;border-radius:4px;cursor:pointer;font-size:12px !important';
      backToTwo.addEventListener('click', () => {
        screen = 2;
        render();
      });
      const finishBtn = btn("Done, let's go!");
      finishBtn.addEventListener('click', close); // close() marks onboarded when screen === 3, see below
      finishRow.appendChild(backToTwo);
      finishRow.appendChild(finishBtn);
      body.appendChild(finishRow);
    }

    // ---- Screen 3: technical details (nested popup, stacked above) ----
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

  function ensureWidget() {
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

  async function handleClick(videoId, card, btn, attempt = 1) {
    const mode = getMode();
    const cached = getCachedSummary(videoId, mode);
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const cardTitle = extractVideoTitle(card);
    const channelInfo = extractChannelInfo(card);

    log(`Click: video=${videoId} mode=${mode} attempt=${attempt}`);

    if (cached) {
      log('Click: cache hit, showing cached summary');
      const visible = toggleSummaryOverlay(btn, cached);
      setButtonState(btn, visible ? 'Hide summary' : 'Summarize', false);
      refreshButtonCachedVisual(btn, videoId);
      historyRecordSummary({ videoId, mode, title: cardTitle, url: watchUrl, channelName: channelInfo.name, channelUrl: channelInfo.url, summary: cached });
      return;
    }

    // URL mode is always Gemini (the one thing it can uniquely do); Caption
    // mode routes through whichever provider is selected in Options.
    const provider = mode === 'url' ? 'gemini' : getLlmProvider();
    const adapter = LLM_PROVIDERS[provider];
    const creds = getProviderCredentials(provider);

    if (!creds.apiKey && provider !== 'openai_compatible') {
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

    const langSuffix = getSummaryLanguage().trim() ? ` Respond in ${getSummaryLanguage().trim()}.` : '';

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
          setButtonState(btn, 'Captions blocked - try URL mode', false);
          return;
        }
        if (!transcript) {
          log('Transcript: none available for this video', 'warn');
          setButtonState(btn, 'No captions available', false);
          return;
        }
        setCachedTranscript(videoId, transcript);
      } else {
        log('Transcript: using cached transcript from a previous attempt');
      }

      // "Download captions" short-circuits here: the whole point is to use
      // this as a plain transcript-downloader when checked, skipping the
      // LLM call (and the summary cache/History, since there's no summary
      // to record) entirely.
      if (getDownloadCaptionsEnabled()) {
        downloadFile(`${sanitizeFilename(cardTitle || videoId)}_transcript.txt`, transcript, 'text/plain');
        log('Transcript: downloaded locally per "Download captions" option, skipping LLM call');
        setButtonState(btn, 'Downloaded ✓', false);
        setTimeout(() => setButtonState(btn, 'Summarize', false), 2000);
        return;
      }

      promptText = `${getEffectivePrompt()}${langSuffix}\n\nTranscript:\n${transcript}`;
    } else {
      promptText = `${getEffectivePrompt()}${langSuffix}`;
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
        setTimeout(() => handleClick(videoId, card, btn, attempt + 1), delayMs);
      } else {
        log(`Giving up: ${reasonLabel}`, 'error');
        setButtonState(btn, reasonLabel, false);
      }
    }

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

    GM_xmlhttpRequest({
      method: 'POST',
      url: reqUrl,
      headers: reqHeaders,
      timeout: timeoutMs,
      data: payload,
      onload: (res) => {
        stopHeartbeat();
        const elapsedS = Math.round((performance.now() - startedAt) / 1000);
        log(`Response received after ${elapsedS}s: HTTP ${res.status}`);

        let data;
        try {
          data = JSON.parse(res.responseText);
        } catch (e) {
          log(`Response body was not valid JSON: ${e.message}`, 'error');
          console.log('[vorsum] raw response:', res.responseText);
          setButtonState(btn, 'Bad response - see console', false);
          return;
        }

        const result = adapter.parseResponse(data);

        if (result.error) {
          log(`API error: HTTP ${res.status} - ${result.error}`, 'error');

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
          setButtonState(btn, isTransient ? 'Server busy - try later' : `Err: ${short}`, false);
          btn.title = result.error;
          return;
        }

        const text = result.text;
        if (!text) {
          log('Response had no text - see console for full payload', 'warn');
          console.warn('[vorsum] No text in response:', data);
          setButtonState(btn, 'No summary - see console', false);
          return;
        }

        log(`Summary received (${text.length} chars), caching`);
        setCachedSummary(videoId, mode, text);
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
          notifyNewHistoryEntry();
          log('Summary ready but the button is off-screen - notifying instead of auto-showing', 'info');
        }

        historyRecordSummary({ videoId, mode, title: cardTitle, url: watchUrl, channelName: channelInfo.name, channelUrl: channelInfo.url, summary: text });
      },
      ontimeout: () => {
        stopHeartbeat();
        const elapsedS = Math.round((performance.now() - startedAt) / 1000);
        log(`Request timed out after ${elapsedS}s (limit ${Math.round(timeoutMs / 1000)}s, mode=${mode})`, 'error');
        retryOrFail('Timed out - see console', true);
      },
      onerror: (err) => {
        stopHeartbeat();
        log(`Network/transport error: ${JSON.stringify(err)}`, 'error');
        retryOrFail('Failed - see console', true);
      }
    });
  }

  // ---- Watch for grid cards being added ----
  function scanForCards() {
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
  buildWidget();
  scanForCards();
  scheduleTopOffsetRechecks();
  runMigrationIfNeeded().then(() => cleanupLegacyStorage());
  checkCacheThreshold(); // in case the cache was already over threshold from a prior session
  checkForUpdate(); // throttled internally to once/day, harmless to call every load

  if (!getOnboarded()) {
    // Small delay so the modal doesn't compete with the page's own
    // first-paint/layout settling, and so the Vorapis detection check
    // (which reads whatever card elements exist right now) has a fair
    // chance of finding them already rendered.
    setTimeout(() => showOnboarding(), 1500);
  }
})();