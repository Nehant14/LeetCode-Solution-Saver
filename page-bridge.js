// Runs in the PAGE's own JS world (see manifest's "world": "MAIN"), unlike
// content.js which runs isolated and cannot see window.monaco directly.
// Talks to content.js via CustomEvents dispatched on window.
(() => {
  'use strict';

  function getActiveModel() {
    const models = window.monaco?.editor?.getModels?.() || [];
    if (!models.length) return null;
    return models.find((model) => typeof model?.getValue === 'function' && model.getValue().trim().length > 0) || models[0];
  }

  window.addEventListener('retained:request', (event) => {
    const { requestId, action, payload } = event.detail || {};
    if (!requestId || !action) return;

    let result;

    try {
      if (action === 'get-state') {
        const model = getActiveModel();
        result = {
          requestId,
          ok: true,
          data: {
            code: model?.getValue?.() || '',
            languageId: model?.getLanguageId?.() || ''
          }
        };
      } else if (action === 'set-code') {
        const model = getActiveModel();
        if (!model || typeof model.setValue !== 'function') {
          result = { requestId, ok: false, error: 'Could not find the Monaco editor model on this page.' };
        } else {
          model.setValue(String(payload?.code ?? ''));
          result = { requestId, ok: true };
        }
      } else {
        result = { requestId, ok: false, error: `Unknown bridge action: ${action}` };
      }
    } catch (error) {
      result = { requestId, ok: false, error: error?.message || 'Page bridge error.' };
    }

    window.dispatchEvent(new CustomEvent('retained:response', { detail: result }));
  });
})();
