// Google Analytics (GA4) and Google Tag Manager, on every page. index.html, promo and the landing page load this with
// "defer" (it never holds up the first paint); admin.html still loads it plainly.
// Page views: one per page load, sent by gtag's config. The address goes without its ?query (a ?ref= holds a user id).
// App actions: the pages call track(name, params) for every request to the server (search, signup, pay, mark…), with
// only the action, the village and the result — never a name, phone number, password or what was searched for.
// Each action goes to GA4 directly (when GA_ID is set) and to the dataLayer as event "app_action", so a Tag Manager
// trigger on that event can use them too.
// Speed: the two Google scripts (~250 KB) load only once the page is up — at the first tap, key or scroll, or 3.5 s after
// the page has loaded. The page view and every track() before that wait in the dataLayer and are sent when they load.
(function () {
  var GA_ID = 'G-G9EK9GTQ4J';   // the GA4 web stream's measurement ID: G-XXXXXXXXXX (analytics.google.com → Admin → Data streams)
  var GTM_ID = 'GTM-5Z2LNDRF';  // Tag Manager container; admin.html still starts it inline in its <head>
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  if (GA_ID) {
    gtag('js', new Date());
    gtag('config', GA_ID, { page_location: location.origin + location.pathname });
  }
  window.track = function (name, params) {
    try {
      var p = params || {};
      if (GA_ID) gtag('event', name, p);
      var d = { event: 'app_action', action: name };
      for (var k in p) d[k] = p[k];
      window.dataLayer.push(d);
    } catch (e) { /* analytics must never break the app */ }
  };
  // track() calls made before this file ran (a page that loads it with defer keeps them in window.trackq)
  var q = window.trackq || [];
  window.trackq = null;
  for (var i = 0; i < q.length; i++) window.track.apply(null, q[i]);

  var started = false;
  function add(src) { var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); }
  function start() {
    if (started) return;
    started = true;
    if (GA_ID) add('https://www.googletagmanager.com/gtag/js?id=' + GA_ID);
    var gtmOn = false;   // a page that starts Tag Manager inline has pushed gtm.start already
    for (var j = 0; j < window.dataLayer.length; j++) if (window.dataLayer[j] && window.dataLayer[j]['gtm.start']) gtmOn = true;
    if (GTM_ID && !gtmOn) {
      window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
      add('https://www.googletagmanager.com/gtm.js?id=' + GTM_ID);
    }
  }
  var evs = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
  for (var e = 0; e < evs.length; e++) window.addEventListener(evs[e], start, { once: true, passive: true });
  function later() { setTimeout(start, 3500); }
  if (document.readyState === 'complete') later(); else window.addEventListener('load', later);
})();
