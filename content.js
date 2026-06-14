(() => {
  'use strict';

  const ACCEPTED_TEXT = 'Accepted';
  const PROBLEM_PATH_PATTERN = /^\/problems\/[^/]+/;
  const POLL_INTERVAL_MS = 1000;
  const ACCEPTED_DETECTION_DELAY_MS = 350;
  const EDITOR_WAIT_TIMEOUT_MS = 5000;

  // How long to show the "Saved!" success modal before auto-closing
  const SUCCESS_MODAL_AUTO_CLOSE_MS = 4000;
  // How long to show the "No saved solution" notice before auto-closing
  const MISSING_MODAL_AUTO_CLOSE_MS = 3000;
  // How long to show an error modal before auto-closing
  const ERROR_MODAL_AUTO_CLOSE_MS = 5000;

  const state = {
    lastProblemPath: location.pathname,
    uploadInProgress: false,
    acceptedScanScheduled: false,
    pendingAcceptedMutation: false,
    observer: null,
    lookupRequestId: 0,
    lookupKey: '',
    // Possible statuses: 'idle' | 'loading' | 'saving' | 'found' | 'missing' | 'error' | 'save-success'
    lookupStatus: 'idle',
    errorMessage: '',
    savedSolution: null,
    panelOpen: false,
    uiHost: null,
    uiRoot: null,
    navigationWatcherInstalled: false,
    autoCloseTimer: null
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

    throw new Error('Timed out while reading the LeetCode editor state.');
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

  function scheduleAutoClose(ms) {
    clearAutoCloseTimer();
    state.autoCloseTimer = setTimeout(() => {
      state.autoCloseTimer = null;
      dismissUi();
    }, ms);
  }

  function dismissUi() {
    clearAutoCloseTimer();
    state.lookupStatus = 'idle';
    state.panelOpen = false;
    state.savedSolution = null;
    state.errorMessage = '';
    renderSolutionUi();
  }

  function ensureUiHost() {
    if (state.uiHost && state.uiHost.isConnected) {
      return state.uiHost;
    }

    // Clean up stale host if it got detached
    if (state.uiHost && !state.uiHost.isConnected) {
      state.uiHost = null;
      state.uiRoot = null;
    }

    const host = document.createElement('div');
    host.id = 'leetcode-drive-solution-overlay';
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'inset:0',
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

  function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise((resolve, reject) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        success ? resolve() : reject(new Error('Clipboard copy failed.'));
      } catch (error) {
        document.body.removeChild(textarea);
        reject(error);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render — the entire UI is rebuilt from state each time.
  // Only one "mode" renders at a time based on state.lookupStatus.
  // ---------------------------------------------------------------------------
  function renderSolutionUi() {
    const status = state.lookupStatus;

    // 'idle' means nothing should be on screen — remove the host entirely.
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

    const solutionName   = escapeHtml(state.savedSolution?.name || 'Saved solution');
    const codeContent    = escapeHtml(state.savedSolution?.content || '');
    const solutionLang   = escapeHtml(state.savedSolution?.extension || 'txt').toUpperCase();
    const errorMsg       = escapeHtml(state.errorMessage || 'An unexpected error occurred.');

    // ---- Shared CSS ----
    const css = `
      :host { all: initial; }

      /* Full-screen dimmed backdrop for modal states */
      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(4, 9, 18, 0.62);
        backdrop-filter: blur(3px);
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }

      /* Floating launcher badge (bottom-right) */
      .corner-badge {
        position: fixed;
        right: 20px;
        bottom: 20px;
        pointer-events: auto;
      }

      /* ---- Modal card ---- */
      .modal {
        width: min(580px, calc(100vw - 32px));
        max-height: min(80vh, 720px);
        background: #0b1523;
        border: 1px solid rgba(99, 148, 210, 0.28);
        border-radius: 20px;
        box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
        color: #dce8f5;
        animation: pop-in 0.18s cubic-bezier(.34,1.56,.64,1) both;
      }

      @keyframes pop-in {
        from { opacity: 0; transform: scale(0.92) translateY(10px); }
        to   { opacity: 1; transform: scale(1)    translateY(0);    }
      }

      /* Header */
      .modal-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 20px 14px;
        border-bottom: 1px solid rgba(99, 148, 210, 0.14);
        flex-shrink: 0;
      }
      .modal-icon {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        flex-shrink: 0;
      }
      .modal-icon.saving  { background: rgba(59, 130, 246, 0.18); }
      .modal-icon.loading { background: rgba(99, 179, 237, 0.16); }
      .modal-icon.success { background: rgba(52, 211, 153, 0.16); }
      .modal-icon.missing { background: rgba(251, 191, 36, 0.14); }
      .modal-icon.error   { background: rgba(248, 113, 113, 0.16); }

      .modal-title-block { min-width: 0; flex: 1; }
      .modal-kicker {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: rgba(148, 163, 184, 0.8);
        margin-bottom: 4px;
      }
      .modal-title {
        font-size: 15px;
        font-weight: 700;
        color: #f1f8ff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .close-btn {
        appearance: none;
        border: none;
        background: rgba(148, 163, 184, 0.1);
        color: rgba(203, 213, 225, 0.7);
        border-radius: 8px;
        width: 28px;
        height: 28px;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.1s;
      }
      .close-btn:hover { background: rgba(148, 163, 184, 0.22); color: #f1f5f9; }

      /* Body */
      .modal-body {
        padding: 16px 20px 20px;
        overflow: auto;
        flex: 1;
      }

      /* Spinner */
      .spinner-row {
        display: flex;
        align-items: center;
        gap: 12px;
        color: rgba(203, 213, 225, 0.85);
        font-size: 13.5px;
      }
      .spinner {
        width: 20px;
        height: 20px;
        border: 2.5px solid rgba(99, 148, 210, 0.25);
        border-top-color: #60a5fa;
        border-radius: 50%;
        animation: spin 0.75s linear infinite;
        flex-shrink: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* Success / missing / error banners */
      .banner {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 12px;
        font-size: 13.5px;
        line-height: 1.5;
      }
      .banner.success { background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.22); color: #a7f3d0; }
      .banner.missing { background: rgba(251, 191, 36, 0.09); border: 1px solid rgba(251, 191, 36, 0.2);  color: #fde68a; }
      .banner.error   { background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.22); color: #fca5a5; }
      .banner-icon { font-size: 17px; flex-shrink: 0; margin-top: 1px; }

      /* Code block */
      .code-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
        margin-top: 14px;
      }
      .lang-badge {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        padding: 3px 9px;
        border-radius: 6px;
        background: rgba(96, 165, 250, 0.14);
        color: #93c5fd;
        border: 1px solid rgba(96, 165, 250, 0.22);
      }
      .copy-btn {
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: rgba(30, 41, 59, 0.9);
        color: #e2e8f0;
        border-radius: 8px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .copy-btn:hover { border-color: rgba(148, 163, 184, 0.44); }

      .code-block {
        margin: 0;
        white-space: pre;
        overflow: auto;
        padding: 14px 16px;
        border-radius: 12px;
        border: 1px solid rgba(94, 112, 136, 0.2);
        background: #060e1a;
        color: #e2eaf4;
        font: 13px/1.65 Consolas, 'SFMono-Regular', Menlo, Monaco, monospace;
        tab-size: 2;
        max-height: 420px;
      }

      /* Footer action row */
      .modal-footer {
        padding: 12px 20px 16px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        border-top: 1px solid rgba(99, 148, 210, 0.1);
        flex-shrink: 0;
      }
      .btn-primary {
        appearance: none;
        border: none;
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        color: #fff;
        border-radius: 10px;
        padding: 8px 18px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(37, 99, 235, 0.35);
      }
      .btn-primary:hover { background: linear-gradient(135deg, #3b82f6, #2563eb); }
      .btn-ghost {
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.2);
        background: rgba(30, 41, 59, 0.8);
        color: #e2e8f0;
        border-radius: 10px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn-ghost:hover { border-color: rgba(148, 163, 184, 0.4); }

      /* Launcher badge */
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
        gap: 10px;
        font-size: 13px;
        font-weight: 600;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.01em;
        transition: transform 0.12s, border-color 0.12s;
        pointer-events: auto;
      }
      .launcher:hover { transform: translateY(-1px); border-color: rgba(139, 191, 255, 0.5); }
      .launcher-dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 6px #34d399; }
    `;

    // ---- Build inner HTML based on status ----
    let inner = '';

    if (status === 'saving') {
      // Modal: uploading to Drive
      inner = `
        <div class="backdrop" data-action="backdrop-noop">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Saving solution to Google Drive">
            <div class="modal-header">
              <div class="modal-icon saving">💾</div>
              <div class="modal-title-block">
                <div class="modal-kicker">Google Drive</div>
                <div class="modal-title">Saving accepted solution…</div>
              </div>
            </div>
            <div class="modal-body">
              <div class="spinner-row">
                <div class="spinner"></div>
                <span>Uploading your accepted code to the <strong>LeetCode-Solutions</strong> folder on Google Drive. This usually takes a moment.</span>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'save-success') {
      // Modal: upload succeeded
      inner = `
        <div class="backdrop" data-action="backdrop-dismiss">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Solution saved">
            <div class="modal-header">
              <div class="modal-icon success">✅</div>
              <div class="modal-title-block">
                <div class="modal-kicker">Google Drive</div>
                <div class="modal-title">${solutionName}</div>
              </div>
              <button class="close-btn" type="button" data-action="dismiss" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
              <div class="banner success">
                <span class="banner-icon">🎉</span>
                <span>Solution saved to your <strong>LeetCode-Solutions</strong> folder on Google Drive.</span>
              </div>
              ${codeContent ? `
                <div class="code-meta">
                  <span class="lang-badge">${solutionLang}</span>
                  <button class="copy-btn" type="button" data-action="copy-code">Copy to clipboard</button>
                </div>
                <pre class="code-block">${codeContent}</pre>
              ` : ''}
            </div>
            <div class="modal-footer">
              <button class="btn-ghost" type="button" data-action="dismiss">Close</button>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'loading') {
      // Modal: looking up a previously-saved solution
      inner = `
        <div class="backdrop" data-action="backdrop-noop">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Looking up saved solution">
            <div class="modal-header">
              <div class="modal-icon loading">🔍</div>
              <div class="modal-title-block">
                <div class="modal-kicker">Google Drive</div>
                <div class="modal-title">Checking for a saved solution…</div>
              </div>
            </div>
            <div class="modal-body">
              <div class="spinner-row">
                <div class="spinner"></div>
                <span>Searching your <strong>LeetCode-Solutions</strong> folder on Google Drive.</span>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'found' && state.panelOpen) {
      // Modal: solution found — show the code
      inner = `
        <div class="backdrop" data-action="backdrop-dismiss">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Saved Drive solution">
            <div class="modal-header">
              <div class="modal-icon success">📄</div>
              <div class="modal-title-block">
                <div class="modal-kicker">Google Drive · Saved solution</div>
                <div class="modal-title">${solutionName}</div>
              </div>
              <button class="close-btn" type="button" data-action="dismiss" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
              <div class="code-meta">
                <span class="lang-badge">${solutionLang}</span>
                <button class="copy-btn" type="button" data-action="copy-code">Copy to clipboard</button>
              </div>
              <pre class="code-block">${codeContent}</pre>
            </div>
            <div class="modal-footer">
              <button class="btn-ghost" type="button" data-action="dismiss">Close</button>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'found' && !state.panelOpen) {
      // Compact launcher badge — user closed the modal but can reopen it
      inner = `
        <div class="corner-badge">
          <button class="launcher" type="button" data-action="toggle-panel">
            <span class="launcher-dot"></span>
            <span>View Saved Drive Solution</span>
            <span style="opacity:0.65;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">${solutionLang}</span>
          </button>
        </div>
      `;
    } else if (status === 'missing') {
      // Modal: no saved solution found
      inner = `
        <div class="backdrop" data-action="backdrop-dismiss">
          <div class="modal" role="dialog" aria-modal="true" aria-label="No saved solution">
            <div class="modal-header">
              <div class="modal-icon missing">📭</div>
              <div class="modal-title-block">
                <div class="modal-kicker">Google Drive</div>
                <div class="modal-title">No saved solution found</div>
              </div>
              <button class="close-btn" type="button" data-action="dismiss" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
              <div class="banner missing">
                <span class="banner-icon">ℹ️</span>
                <span>No previously saved solution was found for this problem in your <strong>LeetCode-Solutions</strong> folder. Submit an accepted solution to save one.</span>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn-ghost" type="button" data-action="dismiss">Dismiss</button>
            </div>
          </div>
        </div>
      `;
    } else if (status === 'error') {
      // Modal: something went wrong
      inner = `
        <div class="backdrop" data-action="backdrop-dismiss">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Error">
            <div class="modal-header">
              <div class="modal-icon error">⚠️</div>
              <div class="modal-title-block">
                <div class="modal-kicker">Google Drive</div>
                <div class="modal-title">Something went wrong</div>
              </div>
              <button class="close-btn" type="button" data-action="dismiss" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
              <div class="banner error">
                <span class="banner-icon">❌</span>
                <span>${errorMsg}</span>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn-ghost" type="button" data-action="dismiss">Dismiss</button>
            </div>
          </div>
        </div>
      `;
    }

    state.uiRoot.innerHTML = `<style>${css}</style>${inner}`;
  }

  async function handleUiClick(event) {
    const target = event.target;

    // Clicking the dimmed backdrop dismisses the modal (except during active operations)
    const backdrop = target.closest('[data-action="backdrop-dismiss"]');
    if (backdrop && target === backdrop) {
      dismissUi();
      return;
    }

    const button = target.closest('button[data-action]');
    if (!button) return;

    const action = button.dataset.action;

    if (action === 'dismiss') {
      dismissUi();
      return;
    }

    if (action === 'toggle-panel') {
      state.panelOpen = true;
      renderSolutionUi();
      return;
    }

    if (action === 'copy-code' && state.savedSolution?.content) {
      try {
        await copyTextToClipboard(state.savedSolution.content);
        button.textContent = '✓ Copied!';
        setTimeout(() => {
          if (button.isConnected) button.textContent = 'Copy to clipboard';
        }, 1400);
      } catch (error) {
        console.error('[LeetCode Saver] Copy failed:', error);
      }
    }
  }

  async function requestSavedSolutionLookup({ keepPanelOpen = false } = {}) {
    if (!isLeetCodeProblemPage()) return;

    const lookupKey = `${getNormalizedProblemPath()}::${buildLookupPayload().preferredExtension}`;

    // Already have the result cached — nothing to do
    if (state.lookupKey === lookupKey && state.lookupStatus === 'found' && state.savedSolution) {
      return;
    }

    state.lookupKey = lookupKey;
    state.lookupStatus = 'loading';
    state.panelOpen = keepPanelOpen;
    state.savedSolution = null;
    state.errorMessage = '';
    clearAutoCloseTimer();
    renderSolutionUi();

    const requestId = ++state.lookupRequestId;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'LEETCODE_LOOKUP_SAVED_SOLUTION',
        payload: buildLookupPayload()
      });

      if (requestId !== state.lookupRequestId) return;

      if (response?.ok && response?.found && response?.solution?.content) {
        state.savedSolution = response.solution;
        state.lookupStatus = 'found';
        state.panelOpen = true;
        renderSolutionUi();
        return;
      }

      if (response?.ok && !response?.found) {
        state.lookupStatus = 'missing';
        state.savedSolution = null;
        renderSolutionUi();
        scheduleAutoClose(MISSING_MODAL_AUTO_CLOSE_MS);
        return;
      }

      // Service returned ok:false
      state.lookupStatus = 'error';
      state.errorMessage = response?.error || 'Drive lookup failed. Check the extension console for details.';
      state.savedSolution = null;
      console.error('[LeetCode Saver] Lookup returned an error:', state.errorMessage);
      renderSolutionUi();
      scheduleAutoClose(ERROR_MODAL_AUTO_CLOSE_MS);
    } catch (error) {
      if (requestId !== state.lookupRequestId) return;

      state.lookupStatus = 'error';
      state.errorMessage = error?.message || 'Drive lookup failed. Check the extension console for details.';
      state.savedSolution = null;
      console.error('[LeetCode Saver] Saved-solution lookup failed:', error);
      renderSolutionUi();
      scheduleAutoClose(ERROR_MODAL_AUTO_CLOSE_MS);
    }
  }

  function isGreenishColor(color) {
    const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return false;

    const red   = Number(match[1]);
    const green = Number(match[2]);
    const blue  = Number(match[3]);
    return green > red + 20 && green > blue + 20;
  }

  function nodeContainsAcceptedIndicator(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;

    const text = node.textContent || '';
    if (!text.includes(ACCEPTED_TEXT)) return false;

    const computedStyle = window.getComputedStyle(node);
    const className     = String(node.className || '').toLowerCase();
    const successHint   = /success|accepted|green|text-green|bg-green/.test(className);

    return successHint
      || isGreenishColor(computedStyle.color)
      || isGreenishColor(computedStyle.backgroundColor);
  }

  function mutationMentionsAcceptance(mutation) {
    for (const node of mutation.addedNodes || []) {
      if (nodeContainsAcceptedIndicator(node)) return true;
      if (node.nodeType === Node.ELEMENT_NODE && node.textContent?.includes(ACCEPTED_TEXT)) return true;
    }

    if (mutation.type === 'characterData') {
      if ((mutation.target?.data || '').includes(ACCEPTED_TEXT)) return true;
    }

    return false;
  }

  function scheduleAcceptedScan() {
    if (state.acceptedScanScheduled) return;
    state.acceptedScanScheduled = true;

    queueMicrotask(async () => {
      state.acceptedScanScheduled = false;

      try {
        await wait(ACCEPTED_DETECTION_DELAY_MS);

        if (!isLeetCodeProblemPage() || state.uploadInProgress || !state.pendingAcceptedMutation) {
          return;
        }

        state.pendingAcceptedMutation = false;
        state.uploadInProgress = true;
        state.lookupStatus = 'saving';   // NEW: distinct "saving" status
        state.panelOpen = true;
        state.savedSolution = null;
        state.errorMessage = '';
        clearAutoCloseTimer();
        renderSolutionUi();

        const payload = await waitForEditorData();

        const response = await chrome.runtime.sendMessage({
          type: 'LEETCODE_SOLUTION_ACCEPTED',
          payload
        });

        if (!response?.ok) {
          throw new Error(response?.error || 'Drive upload failed.');
        }

        console.info('[LeetCode Saver] Solution uploaded to Google Drive:', response.fileName);
        state.uploadInProgress = false;
        state.pendingAcceptedMutation = false;

        // Fetch the just-uploaded file so we can display its content in the success modal
        await requestSavedSolutionLookup({ keepPanelOpen: true });

        // If lookup succeeded, switch to save-success view; otherwise leave whatever status lookup set
        if (state.lookupStatus === 'found') {
          state.lookupStatus = 'save-success';
          renderSolutionUi();
          scheduleAutoClose(SUCCESS_MODAL_AUTO_CLOSE_MS);
        }
      } catch (error) {
        state.uploadInProgress = false;
        state.lookupStatus = 'error';
        state.savedSolution = null;
        state.errorMessage = error?.message || 'Failed to save the solution to Google Drive.';
        renderSolutionUi();
        scheduleAutoClose(ERROR_MODAL_AUTO_CLOSE_MS);
        console.error('[LeetCode Saver] Unable to save accepted solution:', error);
      }
    });
  }

  function attachObserver() {
    if (state.observer) {
      state.observer.disconnect();
    }

    state.observer = new MutationObserver((mutations) => {
      if (!isLeetCodeProblemPage()) return;

      for (const mutation of mutations) {
        if (mutationMentionsAcceptance(mutation)) {
          state.pendingAcceptedMutation = true;
          scheduleAcceptedScan();
          break;
        }
      }
    });

    const target = document.documentElement || document.body;
    if (target) {
      state.observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true
      });
    }
  }

  function resetForRouteChange() {
    const currentPath = getNormalizedProblemPath();
    if (currentPath !== state.lastProblemPath) {
      state.lastProblemPath = currentPath;
      state.uploadInProgress = false;
      state.pendingAcceptedMutation = false;
    }
  }

  function startRouteWatcher() {
    setInterval(() => { resetForRouteChange(); }, POLL_INTERVAL_MS);
  }

  function handleRouteChange() {
    resetForRouteChange();
    clearAutoCloseTimer();

    // BUG FIX: always reset to idle on route change so stale UI is removed
    state.lookupStatus = 'idle';
    state.savedSolution = null;
    state.lookupKey = '';
    state.panelOpen = false;
    state.errorMessage = '';
    renderSolutionUi();  // removes UI host because status is 'idle'

    if (!isLeetCodeProblemPage()) return;

    requestSavedSolutionLookup();
  }

  function installNavigationWatcher() {
    if (state.navigationWatcherInstalled) return;
    state.navigationWatcherInstalled = true;

    const notifyRouteChange = () => {
      window.dispatchEvent(new Event('leetcode-locationchange'));
    };

    const originalPushState    = history.pushState;
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

    attachObserver();
    startRouteWatcher();
    requestSavedSolutionLookup();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeContentScript, { once: true });
  } else {
    initializeContentScript();
  }
})();
