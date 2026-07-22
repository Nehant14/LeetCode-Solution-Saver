(() => {
  'use strict';

  const DEFAULTS = { scale: 1, color: '#3b82f6' };
  const PRESETS = ['#3b82f6', '#10b981', '#8b5cf6'];
  const STORAGE_KEY = 'retainedAppearance';

  const sizeSlider = document.getElementById('sizeSlider');
  const sizeValue = document.getElementById('sizeValue');
  const previewBtn = document.getElementById('previewBtn');
  const hexInput = document.getElementById('hexInput');
  const hexSwatch = document.getElementById('hexSwatch');
  const statusEl = document.getElementById('status');
  const swatches = Array.from(document.querySelectorAll('.swatch[data-color]'));

  let current = Object.assign({}, DEFAULTS);
  let saveTimer = null;

  function normalizeInput(raw) {
    let v = (raw || '').trim();
    if (!v) return '';
    if (!v.startsWith('#')) v = '#' + v;
    return v.toLowerCase();
  }

  function isValidHex(v) {
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
  }

  function expandHex(v) {
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      return '#' + v.slice(1).split('').map((c) => c + c).join('');
    }
    return v;
  }

  function contrastTextColor(hex) {
    const c = hex.slice(1);
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#0b1523' : '#eff6ff';
  }

  function applyPreview() {
    const scale = current.scale;
    const color = expandHex(current.color);
    const textColor = contrastTextColor(color);

    previewBtn.style.fontSize = (13 * scale).toFixed(1) + 'px';
    previewBtn.style.padding = (11 * scale).toFixed(1) + 'px ' + (16 * scale).toFixed(1) + 'px';
    previewBtn.style.background = color;
    previewBtn.style.color = textColor;
    previewBtn.style.borderColor = color + '80';

    sizeValue.textContent = Math.round(scale * 100) + '%';

    swatches.forEach((sw) => {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === color);
    });

    const isCustom = !PRESETS.some((p) => p.toLowerCase() === color);
    hexSwatch.classList.toggle('active', isCustom);

    if (document.activeElement !== hexInput) {
      hexInput.value = color.slice(1);
    }
  }

  function persist() {
    statusEl.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.sync.set({ [STORAGE_KEY]: current }, () => {
          statusEl.textContent = 'Saved';
        });
      } catch (err) {
        statusEl.textContent = 'Could not save';
      }
    }, 150);
  }

  sizeSlider.addEventListener('input', () => {
    current.scale = Number(sizeSlider.value) / 100;
    applyPreview();
    persist();
  });

  swatches.forEach((sw) => {
    sw.addEventListener('click', () => {
      current.color = sw.dataset.color;
      applyPreview();
      persist();
    });
  });

  hexInput.addEventListener('input', () => {
    const normalized = normalizeInput(hexInput.value);
    if (isValidHex(normalized)) {
      current.color = expandHex(normalized);
      applyPreview();
      persist();
    }
  });

  hexInput.addEventListener('blur', () => {
    hexInput.value = expandHex(current.color).slice(1);
  });

  hexInput.addEventListener('focus', () => {
    hexInput.select();
  });

  try {
    chrome.storage.sync.get([STORAGE_KEY], (result) => {
      current = Object.assign({}, DEFAULTS, result && result[STORAGE_KEY]);
      sizeSlider.value = Math.round(current.scale * 100);
      applyPreview();
    });
  } catch (err) {
    applyPreview();
  }
})();
