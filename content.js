(() => {
  'use strict';

  const PROBLEM_PATH_PATTERN = /^\/problems\/[^/]+/;
  const ROUTE_POLL_INTERVAL_MS = 1000;
  const EDITOR_WAIT_TIMEOUT_MS = 5000;

  // How long transient toasts stay up before returning to the idle "Save" button
  const PASTED_TOAST_MS = 2200;
  const SAVE_SUCCESS_TOAST_MS = 3000;
  const ERROR_TOAST_MS = 5000;

  const state = {
    lastProblemPath: location.pathname,
    // 'idle' | 'checking' | 'found' | 'pasted' | 'not-found' | 'saving' | 'save-success' | 'error' | 'ready'
    status: 'idle',
    savedSolution: null,
    errorMessage: '',
    lastAction: null, // 'lookup' | 'save' — used to know what "Retry" should do
    uiHost: null,
    uiRoot: null,
    navigationWatcherInstalled: false,
    autoCloseTimer: null,
    lookupRequestId: 0
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isLeetCodeProblemPage() {
    return PROBLEM_PATH_PATTERN.test(location.pathname);
  }

  function getNormalizedProblemPath() {
    return location.pathname.replace(/\/+$/, '');
  }

  function getProblemTitle() {
    const titleSelectors = [
      '[data-cy="question-title"]',
      '[data-cy="question-title-wrapper"] h1',
      'main h1',
      'h1'
    ];

    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text) {
        return text;
      }
    }

    const documentTitle = document.title
      .replace(/\s*\|\s*LeetCode.*$/i, '')
      .replace(/\s*-\s*LeetCode.*$/i, '')
      .trim();

    return documentTitle || 'LeetCode-Solution';
  }

  function getProblemSlug() {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const problemIndex = pathParts.indexOf('problems');

    if (problemIndex >= 0 && pathParts[problemIndex + 1]) {
      return pathParts[problemIndex + 1];
    }

    return pathParts[pathParts.length - 1] || '';
  }

  function normalizeLanguageLabel(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, ' ')
      .trim();
  }

  function mapLanguageToExtension(languageIdOrLabel) {
    const normalized = normalizeLanguageLabel(languageIdOrLabel);

    const extensionMap = {
      'c': 'c',
      'c++': 'cpp',
      'cpp': 'cpp',
      'cpp17': 'cpp',
      'cpp20': 'cpp',
      'c#': 'cs',
      'csharp': 'cs',
      'cs': 'cs',
      'dart': 'dart',
      'golang': 'go',
      'go': 'go',
      'java': 'java',
      'javascript': 'js',
      'js': 'js',
      'kotlin': 'kt',
      'kt': 'kt',
      'mysql': 'sql',
      'postgresql': 'sql',
      'php': 'php',
      'python': 'py',
      'python 3': 'py',
      'python3': 'py',
      'py': 'py',
      'rb': 'rb',
      'ruby': 'rb',
      'rust': 'rs',
      'rs': 'rs',
      'scala': 'scala',
      'swift': 'swift',
      'typescript': 'ts',
      'ts': 'ts',
      'text': 'txt',
      'plaintext': 'txt'
    };

    if (extensionMap[normalized]) {
      return extensionMap[normalized];
    }

    if (normalized.includes('python')) return 'py';
    if (normalized.includes('javascript')) return 'js';
    if (normalized.includes('typescript')) return 'ts';
    if (normalized.includes('c++')) return 'cpp';
    if (normalized.includes('c#')) return 'cs';
    if (normalized.includes('golang') || normalized.includes('go')) return 'go';
    if (normalized.includes('java')) return 'java';
    if (normalized.includes('rust')) return 'rs';

    return 'txt';
  }

  function getEditorModel() {
    const models = window.monaco?.editor?.getModels?.() || [];
    if (!models.length) {
      return null;
    }

    return models.find((model) => typeof model?.getValue === 'function' && model.getValue().trim().length > 0) || models[0];
  }

  function getSourceCode() {
    const model = getEditorModel();
    if (model) {
      const value = model.getValue?.();
      if (typeof value === 'string') {
        return value;
      }
    }

    const textareaCandidates = [
      'textarea[aria-label*="code" i]',
      'textarea'
    ];

    for (const selector of textareaCandidates) {
      const element = document.querySelector(selector);
      const value = element?.value;
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    return '';
  }

  // Writes code into the active Monaco model, i.e. pastes it into the LeetCode editor.
  function setEditorCode(code) {
    const model = getEditorModel();
    if (!model || typeof model.setValue !== 'function') {
      throw new Error('Could not access the LeetCode editor to paste the saved solution.');
    }
    model.setValue(code);
  }

  function getLanguageInfo() {
    const model = getEditorModel();
    const languageId = model?.getLanguageId?.() || '';

    if (languageId) {
      return {
        languageId,
        extension: mapLanguageToExtension(languageId),
        label: languageId
      };
    }

    const languageSelectors = [
      '[data-cy="lang-select"]',
      'button[aria-label*="language" i]',
      'button'
    ];

    for (const selector of languageSelectors) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text && /c\+\+|cpp|python|java|javascript|typescript|c#|csharp|go|golang|rust|swift|kotlin|scala|php|ruby|dart|sql/i.test(text)) {
        return {
          languageId: text,
          extension: mapLanguageToExtension(text),
          label: text
        };
      }
    }

    return {
      languageId: '',
      extension: 'txt',
      label: ''
    };
  }

  function buildLookupPayload() {
    const problemTitle = getProblemTitle();
    const languageInfo = getLanguageInfo();

    return {
      problemTitle,
      problemSlug: getProblemSlug(),
      problemPath: getNormalizedProblemPath(),
      language: languageInfo.label || languageInfo.languageId || '',
      preferredExtension: languageInfo.extension || 'txt'
    };
  }

  // Used right before an explicit Save click — waits briefly for the editor to be readable.
  async function waitForEditorData(timeoutMs = EDITOR_WAIT_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const title = getProblemTitle();
      const code = getSourceCode();
      const languageInfo = getLanguageInfo();

      if (title && code.trim().length > 0 && languageInfo.extension) {
        return {
          problemTitle: title,
          problemPath: getNormalizedProblemPath(),
          language: languageInfo.label || languageInfo.languageId,
          extension: languageInfo.extension,
          code
        };
      }

      await wait(200);
    }

    throw new Error('Could not read your code from the editor. Make sure you have written a solution before saving.');
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clearAutoCloseTimer() {
    if (state.autoCloseTimer !== null) {
      clearTimeout(state.autoCloseTimer);
      state.autoCloseTimer = null;
    }
  }

  function scheduleAutoClose(ms, callback) {
    clearAutoCloseTimer();
    state.autoCloseTimer = setTimeout(() => {
      state.autoCloseTimer = null;
      callback();
    }, ms);
  }

  function ensureUiHost() {
    if (state.uiHost && state.uiHost.isConnected) {
      return state.uiHost;
    }

    if (state.uiHost && !state.uiHost.isConnected) {
      state.uiHost = null;
      state.uiRoot = null;
    }

    const host = document.createElement('div');
    host.id = 'leetcode-drive-solution-overlay';
    // No full-screen backdrop — this sits in the bottom-right corner only and
    // never blocks interaction with the rest of the page.
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'pointer-events:none'
    ].join(';');

    const parent = document.body || document.documentElement;
    if (!parent) return null;

    parent.appendChild(host);
    state.uiHost = host;
    state.uiRoot = host.attachShadow({ mode: 'open' });
    state.uiRoot.addEventListener('click', handleUiClick);

    return host;
  }

  // ---------------------------------------------------------------------------
  // Render — the entire corner UI is rebuilt from state each time.
  // ---------------------------------------------------------------------------
  function renderUi() {
    const status = state.status;

    if (status === 'idle') {
      if (state.uiHost) {
        state.uiHost.remove();
        state.uiHost = null;
        state.uiRoot = null;
      }
      return;
    }

    if (!state.uiRoot) {
      ensureUiHost();
    }
    if (!state.uiRoot) return;

    const problemTitle = escapeHtml(getProblemTitle());
    const errorMsg = escapeHtml(state.errorMessage || 'An unexpected error occurred.');

    const css = `
      :host { all: initial; }

      .card {
        width: 300px;
        background: #0b1523;
        border: 1px solid rgba(99, 148, 210, 0.28);
        border-radius: 14px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04);
        overflow: hidden;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
        color: #dce8f5;
        pointer-events: auto;
        animation: pop-in 0.16s cubic-bezier(.34,1.56,.64,1) both;
      }

      @keyframes pop-in {
        from { opacity: 0; transform: scale(0.94) translateY(8px); }
        to   { opacity: 1; transform: scale(1)    translateY(0);   }
      }

      .row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 14px 14px 12px;
      }

      .icon {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        flex-shrink: 0;
      }
      .icon.info    { background: rgba(99, 179, 237, 0.16); }
      .icon.success { background: rgba(52, 211, 153, 0.16); }
      .icon.warn    { background: rgba(251, 191, 36, 0.14); }
      .icon.error   { background: rgba(248, 113, 113, 0.16); }

      .text-block { min-width: 0; flex: 1; }
      .kicker {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(148, 163, 184, 0.8);
        margin-bottom: 3px;
      }
      .title {
        font-size: 13.5px;
        font-weight: 700;
        color: #f1f8ff;
        line-height: 1.35;
      }
      .subtitle {
        font-size: 12.5px;
        color: rgba(203, 213, 225, 0.85);
        line-height: 1.4;
        margin-top: 3px;
      }

      .close-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: rgba(203, 213, 225, 0.55);
        border-radius: 6px;
        width: 22px;
        height: 22px;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .close-btn:hover { background: rgba(148, 163, 184, 0.16); color: #f1f5f9; }

      .footer {
        display: flex;
        gap: 8px;
        padding: 0 14px 14px;
      }

      .btn {
        appearance: none;
        border: none;
        border-radius: 9px;
        padding: 8px 14px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        flex: 1;
        font-family: inherit;
      }
      .btn-primary { background: #3b82f6; color: #fff; }
      .btn-primary:hover { background: #2563eb; }
      .btn-ghost {
        background: rgba(30, 41, 59, 0.8);
        color: #e2e8f0;
        border: 1px solid rgba(148, 163, 184, 0.22);
      }
      .btn-ghost:hover { border-color: rgba(148, 163, 184, 0.4); }

      .spinner-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(99, 148, 210, 0.25);
        border-top-color: #60a5fa;
        border-radius: 50%;
        animation: spin 0.75s linear infinite;
        flex-shrink: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* Persistent floating Save pill (the 'ready' state) */
      .launcher {
        appearance: none;
        border: 1px solid rgba(99, 148, 210, 0.3);
        background: linear-gradient(135deg, rgba(15, 27, 46, 0.97), rgba(26, 42, 66, 0.97));
        color: #eff6ff;
        box-shadow: 0 12px 40px rgba(4, 12, 24, 0.5);
        border-radius: 999px;
        padding: 11px 16px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
        pointer-events: auto;
        transition: transform 0.12s, border-color 0.12s;
      }
      .launcher:hover { transform: translateY(-1px); border-color: rgba(139, 191, 255, 0.5); }
    `;

    let inner = '';

    if (status === 'checking') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon info">🔍</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="spinner-row">
                <div class="spinner"></div>
                <span class="title" style="font-weight:600;">Checking for a saved solution…</span>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'found') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon success">📄</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="title">Solution available</div>
              <div class="subtitle">A saved solution for "${problemTitle}" was found. Paste it into the editor?</div>
            </div>
            <button class="close-btn" type="button" data-action="paste-no" aria-label="Dismiss">✕</button>
          </div>
          <div class="footer">
            <button class="btn btn-ghost" type="button" data-action="paste-no">No</button>
            <button class="btn btn-primary" type="button" data-action="paste-yes">Yes, paste it</button>
          </div>
        </div>
      `;
    } else if (status === 'pasted') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon success">✅</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="title">Pasted into the editor</div>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'not-found') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon warn">📭</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="title">No saved solution found</div>
              <div class="subtitle">Write your solution, then save it to your LeetCode-Solutions folder whenever you're ready.</div>
            </div>
            <button class="close-btn" type="button" data-action="dismiss" aria-label="Dismiss">✕</button>
          </div>
          <div class="footer">
            <button class="btn btn-primary" type="button" data-action="save">💾 Save Solution</button>
          </div>
        </div>
      `;
    } else if (status === 'saving') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon info">💾</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="spinner-row">
                <div class="spinner"></div>
                <span class="title" style="font-weight:600;">Saving to Drive…</span>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'save-success') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon success">✅</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="title">Solution saved successfully!</div>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'error') {
      inner = `
        <div class="card">
          <div class="row">
            <div class="icon error">⚠️</div>
            <div class="text-block">
              <div class="kicker">Google Drive</div>
              <div class="title">Something went wrong</div>
              <div class="subtitle">${errorMsg}</div>
            </div>
            <button class="close-btn" type="button" data-action="dismiss" aria-label="Dismiss">✕</button>
          </div>
          <div class="footer">
            <button class="btn btn-ghost" type="button" data-action="dismiss">Dismiss</button>
            <button class="btn btn-primary" type="button" data-action="retry">Retry</button>
          </div>
        </div>
      `;
    } else if (status === 'ready') {
      inner = `
        <button class="launcher" type="button" data-action="save">
          <span>💾</span>
          <span>Save Solution</span>
        </button>
      `;
    }

    state.uiRoot.innerHTML = `<style>${css}</style>${inner}`;
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------
  function goReady() {
    clearAutoCloseTimer();
    state.status = 'ready';
    state.savedSolution = null;
    state.errorMessage = '';
    renderUi();
  }

  function goIdle() {
    clearAutoCloseTimer();
    state.status = 'idle';
    state.savedSolution = null;
    state.errorMessage = '';
    renderUi();
  }

  async function runLookup() {
    if (!isLeetCodeProblemPage()) return;

    state.lastAction = 'lookup';
    state.status = 'checking';
    state.savedSolution = null;
    state.errorMessage = '';
    clearAutoCloseTimer();
    renderUi();

    const requestId = ++state.lookupRequestId;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'LEETCODE_LOOKUP_SAVED_SOLUTION',
        payload: buildLookupPayload()
      });

      if (requestId !== state.lookupRequestId) return;

      if (response?.ok && response?.found && response?.solution?.content) {
        state.savedSolution = response.solution;
        state.status = 'found';
        renderUi();
        return;
      }

      if (response?.ok && !response?.found) {
        state.status = 'not-found';
        renderUi();
        return;
      }

      state.status = 'error';
      state.errorMessage = response?.error || 'Drive lookup failed. Check the extension console for details.';
      console.error('[Retained] Lookup returned an error:', state.errorMessage);
      renderUi();
      scheduleAutoClose(ERROR_TOAST_MS, goReady);
    } catch (error) {
      if (requestId !== state.lookupRequestId) return;

      state.status = 'error';
      state.errorMessage = error?.message || 'Drive lookup failed. Check the extension console for details.';
      console.error('[Retained] Saved-solution lookup failed:', error);
      renderUi();
      scheduleAutoClose(ERROR_TOAST_MS, goReady);
    }
  }

  async function handlePasteYes() {
    if (!state.savedSolution?.content) {
      goReady();
      return;
    }

    try {
      setEditorCode(state.savedSolution.content);
      state.status = 'pasted';
      renderUi();
      scheduleAutoClose(PASTED_TOAST_MS, goReady);
    } catch (error) {
      state.status = 'error';
      state.errorMessage = error?.message || 'Failed to paste the solution into the editor.';
      console.error('[Retained] Paste into editor failed:', error);
      renderUi();
      scheduleAutoClose(ERROR_TOAST_MS, goReady);
    }
  }

  function handlePasteNo() {
    goReady();
  }

  // Only ever called from an explicit user click (the Save button) — never automatically.
  async function performSave() {
    if (!isLeetCodeProblemPage()) return;

    state.lastAction = 'save';
    state.status = 'saving';
    state.errorMessage = '';
    clearAutoCloseTimer();
    renderUi();

    try {
      const payload = await waitForEditorData();

      const response = await chrome.runtime.sendMessage({
        type: 'LEETCODE_SAVE_SOLUTION',
        payload
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Drive upload failed.');
      }

      console.info('[Retained] Solution uploaded to Google Drive:', response.fileName);
      state.status = 'save-success';
      renderUi();
      scheduleAutoClose(SAVE_SUCCESS_TOAST_MS, goReady);
    } catch (error) {
      state.status = 'error';
      state.errorMessage = error?.message || 'Failed to save the solution to Google Drive.';
      console.error('[Retained] Save failed:', error);
      renderUi();
      scheduleAutoClose(ERROR_TOAST_MS, goReady);
    }
  }

  function handleRetry() {
    if (state.lastAction === 'save') {
      performSave();
    } else {
      runLookup();
    }
  }

  async function handleUiClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const action = button.dataset.action;

    if (action === 'dismiss') {
      goReady();
      return;
    }
    if (action === 'retry') {
      handleRetry();
      return;
    }
    if (action === 'paste-yes') {
      await handlePasteYes();
      return;
    }
    if (action === 'paste-no') {
      handlePasteNo();
      return;
    }
    if (action === 'save') {
      await performSave();
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Route / navigation handling
  // ---------------------------------------------------------------------------
  function handleRouteChange() {
    const currentPath = getNormalizedProblemPath();
    if (currentPath === state.lastProblemPath) return;

    state.lastProblemPath = currentPath;
    goIdle();

    if (!isLeetCodeProblemPage()) return;

    runLookup();
  }

  function startRouteWatcher() {
    // Belt-and-suspenders alongside the pushState/replaceState patch below —
    // LeetCode's client-side routing doesn't always go through those hooks.
    setInterval(handleRouteChange, ROUTE_POLL_INTERVAL_MS);
  }

  function installNavigationWatcher() {
    if (state.navigationWatcherInstalled) return;
    state.navigationWatcherInstalled = true;

    const notifyRouteChange = () => {
      window.dispatchEvent(new Event('leetcode-locationchange'));
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushStatePatched(...args) {
      const result = originalPushState.apply(this, args);
      notifyRouteChange();
      return result;
    };

    history.replaceState = function replaceStatePatched(...args) {
      const result = originalReplaceState.apply(this, args);
      notifyRouteChange();
      return result;
    };

    window.addEventListener('popstate', notifyRouteChange);
    window.addEventListener('leetcode-locationchange', handleRouteChange);
  }

  function initializeContentScript() {
    installNavigationWatcher();

    if (!isLeetCodeProblemPage()) return;

    startRouteWatcher();
    runLookup();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeContentScript, { once: true });
  } else {
    initializeContentScript();
  }
})();
