(() => {
  'use strict';

  const ACCEPTED_TEXT = 'Accepted';
  const PROBLEM_PATH_PATTERN = /^\/problems\/[^/]+/;
  const POLL_INTERVAL_MS = 1000;
  const ACCEPTED_DETECTION_DELAY_MS = 350;
  const EDITOR_WAIT_TIMEOUT_MS = 5000;

  const state = {
    lastProblemPath: location.pathname,
    uploadInProgress: false,
    acceptedScanScheduled: false,
    pendingAcceptedMutation: false,
    observer: null,
    lookupRequestId: 0,
    lookupKey: '',
    lookupStatus: 'idle',
    savedSolution: null,
    panelOpen: false,
    uiHost: null,
    uiRoot: null,
    navigationWatcherInstalled: false,
    routeWatcher: null
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isLeetCodeProblemPage() {
    return PROBLEM_PATH_PATTERN.test(location.pathname);
  }

  function getNormalizedProblemPath() {
    return location.pathname.replace(/\/+$/, '');
  }

  function sanitizeFilenamePart(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .trim();
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

  function ensureUiHost() {
    if (state.uiHost) {
      return state.uiHost;
    }

    const host = document.createElement('div');
    host.id = 'leetcode-drive-solution-overlay';
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '20px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    const parent = document.body || document.documentElement;
    if (!parent) {
      return null;
    }

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
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (success) {
          resolve();
        } else {
          reject(new Error('Clipboard copy failed.'));
        }
      } catch (error) {
        document.body.removeChild(textarea);
        reject(error);
      }
    });
  }

  function renderSolutionUi() {
    const shouldShowOverlay = state.uploadInProgress
      || state.lookupStatus === 'loading'
      || state.lookupStatus === 'found'
      || state.lookupStatus === 'missing'
      || state.lookupStatus === 'error';

    if (!shouldShowOverlay) {
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

    if (!state.uiRoot) {
      return;
    }

    const solutionName = escapeHtml(state.savedSolution?.name || 'Saved solution');
    const codeContent = escapeHtml(state.savedSolution?.content || '');
    const solutionLanguage = escapeHtml(state.savedSolution?.extension || 'txt');
    const isFound = state.lookupStatus === 'found' && Boolean(state.savedSolution);
    const isMissing = state.lookupStatus === 'missing';
    const isError = state.lookupStatus === 'error';
    const isLoading = state.lookupStatus === 'loading';
    const isUploading = state.uploadInProgress;

    state.uiRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }

        .dock {
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #e5eef7;
          pointer-events: auto;
        }

        .launcher {
          appearance: none;
          border: 1px solid rgba(127, 168, 210, 0.26);
          background: linear-gradient(135deg, rgba(19, 35, 57, 0.96), rgba(30, 48, 73, 0.96));
          color: #eff6ff;
          box-shadow: 0 18px 50px rgba(6, 18, 32, 0.42);
          border-radius: 999px;
          padding: 12px 16px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }

        .launcher:hover {
          transform: translateY(-1px);
          border-color: rgba(139, 191, 255, 0.44);
        }

        .status-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: 999px;
          padding: 10px 14px;
          background: rgba(12, 18, 28, 0.82);
          border: 1px solid rgba(134, 149, 170, 0.24);
          color: rgba(226, 232, 240, 0.78);
          font-size: 12px;
          box-shadow: 0 14px 36px rgba(6, 18, 32, 0.3);
        }

        .panel {
          width: min(640px, calc(100vw - 40px));
          max-height: min(72vh, 720px);
          margin-bottom: 12px;
          background: rgba(10, 16, 24, 0.94);
          border: 1px solid rgba(127, 168, 210, 0.22);
          border-radius: 22px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
          overflow: hidden;
          backdrop-filter: blur(16px);
          display: flex;
          flex-direction: column;
        }

        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 16px 18px;
          border-bottom: 1px solid rgba(127, 168, 210, 0.16);
          background: linear-gradient(180deg, rgba(21, 29, 40, 0.98), rgba(14, 20, 30, 0.94));
        }

        .panel-title {
          min-width: 0;
        }

        .panel-kicker {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: rgba(148, 163, 184, 0.9);
          margin-bottom: 4px;
        }

        .panel-name {
          font-size: 15px;
          font-weight: 700;
          color: #f8fbff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .panel-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .ghost-button {
          appearance: none;
          border: 1px solid rgba(148, 163, 184, 0.2);
          background: rgba(30, 41, 59, 0.82);
          color: #eff6ff;
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }

        .ghost-button:hover {
          border-color: rgba(148, 163, 184, 0.42);
        }

        .panel-body {
          padding: 16px 18px 18px;
          overflow: auto;
        }

        .panel-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          color: rgba(203, 213, 225, 0.82);
          font-size: 12px;
        }

        .code-block {
          margin: 0;
          white-space: pre;
          overflow: auto;
          padding: 16px;
          border-radius: 18px;
          border: 1px solid rgba(94, 112, 136, 0.22);
          background: #07111d;
          color: #e8eef6;
          font: 13px/1.6 Consolas, 'SFMono-Regular', Menlo, Monaco, 'Liberation Mono', monospace;
          tab-size: 2;
        }

        .hidden {
          display: none !important;
        }
      </style>
      <div class="dock">
        ${isUploading || isLoading || (isFound && state.panelOpen) ? `
          <section class="panel" role="dialog" aria-label="Saved Drive solution">
            <div class="panel-header">
              <div class="panel-title">
                <div class="panel-kicker">Google Drive</div>
                <div class="panel-name">${isUploading ? 'Saving solution' : isLoading ? 'Finding saved solution' : solutionName}</div>
              </div>
              <div class="panel-actions">
                ${isFound ? `
                  <button class="ghost-button" type="button" data-action="copy-code">Copy to Clipboard</button>
                  <button class="ghost-button" type="button" data-action="close-panel">Close</button>
                ` : ''}
              </div>
            </div>
            <div class="panel-body">
              <div class="panel-meta">${isUploading ? 'Saving accepted code to Google Drive.' : isLoading ? 'Checking your LeetCode-Solutions folder for a match.' : `${solutionLanguage} file from your LeetCode-Solutions folder`}</div>
              ${isUploading ? `
                <div class="status-pill">Uploading the accepted solution to Google Drive.</div>
              ` : ''}
              ${isLoading ? `
                <div class="status-pill">Looking up the saved solution now.</div>
              ` : ''}
              ${isFound ? `
                <pre class="code-block">${codeContent}</pre>
              ` : ''}
            </div>
          </section>
        ` : ''}

        ${isFound && !state.panelOpen ? `
          <button class="launcher" type="button" data-action="toggle-panel">
            <span>View Saved Drive Solution</span>
            <span style="opacity: 0.7; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;">${solutionLanguage}</span>
          </button>
        ` : ''}

        ${isMissing ? `
          <div class="status-pill">No saved solution found</div>
        ` : ''}

        ${isError ? `
          <div class="status-pill">Drive solution unavailable</div>
        ` : ''}

        ${isMissing ? `
          <div class="status-pill">No saved solution found</div>
        ` : ''}

        ${isError ? `
          <div class="status-pill">Drive solution unavailable</div>
        ` : ''}
      </div>
    `;
  }

  async function handleUiClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }

    const action = button.dataset.action;

    if (action === 'toggle-panel') {
      state.panelOpen = !state.panelOpen;
      renderSolutionUi();
      return;
    }

    if (action === 'close-panel') {
      state.panelOpen = false;
      renderSolutionUi();
      return;
    }

    if (action === 'copy-code' && state.savedSolution?.content) {
      try {
        await copyTextToClipboard(state.savedSolution.content);
        button.textContent = 'Copied';
        setTimeout(() => {
          if (button.isConnected) {
            button.textContent = 'Copy to Clipboard';
          }
        }, 1200);
      } catch (error) {
        console.error('[LeetCode Saver] Copy failed:', error);
      }
    }
  }

  async function requestSavedSolutionLookup({ keepPanelOpen = false } = {}) {
    if (!isLeetCodeProblemPage()) {
      return;
    }

    const lookupKey = `${getNormalizedProblemPath()}::${buildLookupPayload().preferredExtension}`;
    if (state.lookupKey === lookupKey && state.lookupStatus === 'found' && state.savedSolution) {
      return;
    }

    state.lookupKey = lookupKey;
    state.lookupStatus = 'loading';
    state.panelOpen = keepPanelOpen;
    state.savedSolution = null;
    renderSolutionUi();

    const requestId = ++state.lookupRequestId;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'LEETCODE_LOOKUP_SAVED_SOLUTION',
        payload: buildLookupPayload()
      });

      if (requestId !== state.lookupRequestId) {
        return;
      }

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
        return;
      }

      state.lookupStatus = 'error';
      state.savedSolution = null;
      console.error('[LeetCode Saver] Lookup returned an error:', response?.error || 'Unknown error');
      renderSolutionUi();
    } catch (error) {
      if (requestId !== state.lookupRequestId) {
        return;
      }

      state.lookupStatus = 'error';
      state.savedSolution = null;
      console.error('[LeetCode Saver] Saved-solution lookup failed:', error);
      renderSolutionUi();
    }
  }

  function isGreenishColor(color) {
    const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) {
      return false;
    }

    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);

    return green > red + 20 && green > blue + 20;
  }

  function nodeContainsAcceptedIndicator(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const element = node;
    const text = element.textContent || '';
    if (!text.includes(ACCEPTED_TEXT)) {
      return false;
    }

    const computedStyle = window.getComputedStyle(element);
    const className = String(element.className || '').toLowerCase();
    const successHint = /success|accepted|green|text-green|bg-green/.test(className);

    return successHint || isGreenishColor(computedStyle.color) || isGreenishColor(computedStyle.backgroundColor);
  }

  function mutationMentionsAcceptance(mutation) {
    for (const node of mutation.addedNodes || []) {
      if (nodeContainsAcceptedIndicator(node)) {
        return true;
      }

      if (node.nodeType === Node.ELEMENT_NODE && node.textContent?.includes(ACCEPTED_TEXT)) {
        return true;
      }
    }

    if (mutation.type === 'characterData') {
      const text = mutation.target?.data || '';
      if (text.includes(ACCEPTED_TEXT)) {
        return true;
      }
    }

    return false;
  }

  function scheduleAcceptedScan() {
    if (state.acceptedScanScheduled) {
      return;
    }

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
        state.lookupStatus = 'loading';
        state.panelOpen = true;
        renderSolutionUi();

        const payload = await waitForEditorData();

        const response = await chrome.runtime.sendMessage({
          type: 'LEETCODE_SOLUTION_ACCEPTED',
          payload
        });

        if (!response?.ok) {
          throw new Error(response?.error || 'Drive upload failed.');
        }

        state.uploadInProgress = false;
        state.pendingAcceptedMutation = false;
        console.info('[LeetCode Saver] Solution uploaded to Google Drive:', response.fileName);
        await requestSavedSolutionLookup({ keepPanelOpen: true });
      } catch (error) {
        state.uploadInProgress = false;
        state.lookupStatus = 'error';
        state.savedSolution = null;
        renderSolutionUi();
        console.error('[LeetCode Saver] Unable to save accepted solution:', error);
      }
    });
  }

  function attachObserver() {
    if (state.observer) {
      state.observer.disconnect();
    }

    state.observer = new MutationObserver((mutations) => {
      if (!isLeetCodeProblemPage()) {
        return;
      }

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
    setInterval(() => {
      resetForRouteChange();
    }, POLL_INTERVAL_MS);
  }

  function handleRouteChange() {
    resetForRouteChange();

    if (!isLeetCodeProblemPage()) {
      state.lookupStatus = 'idle';
      state.savedSolution = null;
      state.panelOpen = false;
      renderSolutionUi();
      return;
    }

    state.lookupStatus = 'idle';
    state.savedSolution = null;
    state.panelOpen = false;
    renderSolutionUi();
    requestSavedSolutionLookup();
  }

  function installNavigationWatcher() {
    if (state.navigationWatcherInstalled) {
      return;
    }

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

    if (!isLeetCodeProblemPage()) {
      return;
    }

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
