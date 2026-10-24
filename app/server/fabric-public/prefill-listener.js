(function () {
  let lastAppliedKey = '';
  let lastAppliedTime = 0;

  function applyCodes(codes, autoSubmit) {
    if (!codes || codes.length === 0) return;
    const key = codes.map(function (c) { return String(c || '').trim().toUpperCase(); }).filter(Boolean).sort().join(',');
    const now = Date.now();
    var textarea = document.getElementById('pdtCodes');
    const currentVal = textarea ? textarea.value.trim().toUpperCase().split('\n').map(function (s) { return s.trim(); }).filter(Boolean).sort().join(',') : '';

    if (key === lastAppliedKey && (now - lastAppliedTime < 2500 || currentVal === key)) {
      if (typeof window.parent !== 'undefined' && window.parent !== window.self) {
        try { window.parent.postMessage({ type: 'fabric-ready' }, '*'); } catch (e) {}
      }
      return;
    }
    lastAppliedKey = key;
    lastAppliedTime = now;

    if (textarea) textarea.value = codes.join('\n');
    if (autoSubmit) {
      if (typeof handleQuery === 'function') {
        handleQuery();
      } else {
        setTimeout(function () { if (typeof handleQuery === 'function') handleQuery(); }, 30);
      }
    }
  }

  // URL 查询参数兜底：?codes=A1,B6 或 ?pids=A1,B6
  try {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('codes') || params.get('pids');
    if (raw) {
      var parsed = raw.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      if (parsed.length > 0) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { applyCodes(parsed, true); });
        } else {
          applyCodes(parsed, true);
        }
      }
    }
  } catch (err) {}

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'fabric-prefill') return;
    var codes = Array.isArray(data.codes) ? data.codes.filter(function (c) { return typeof c === 'string' && c.trim(); }) : [];
    applyCodes(codes, data.autoSubmit === true);
  });
})();
