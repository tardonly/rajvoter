// Site-down notice: the database's request limit ran out, so nothing works until it resets.
// Covers the whole page until UNTIL (6:00 AM India time), then hides itself — no redeploy needed.
// Remove this file's <script> tags from index.html and admin.html once the site is back.
(function () {
  var UNTIL = Date.parse('2026-11-13T06:00:00+05:30');
  if (Date.now() >= UNTIL) return;
  function show() {
    var d = document.createElement('div');
    d.id = 'siteDown';
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff7ed;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif;color:#7c2d12';
    d.innerHTML = '<div style="max-width:420px">' +
      '<div style="font-size:56px;line-height:1">🛠️</div>' +
      '<h1 style="font-size:24px;margin:16px 0 8px">साइट अभी बंद है</h1>' +
      '<p style="font-size:18px;margin:0 0 16px">सुबह <b>6 बजे</b> फिर से चालू होगी। असुविधा के लिए खेद है 🙏</p>' +
      '<p style="font-size:15px;margin:0;color:#9a3412">The site is down for now and will be back at <b>6:00 AM</b>. Sorry for the trouble.</p>' +
      '</div>';
    document.body.appendChild(d);
    document.documentElement.style.overflow = 'hidden';
    setTimeout(function () { d.remove(); document.documentElement.style.overflow = ''; }, UNTIL - Date.now());
  }
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
