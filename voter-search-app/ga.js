// Google Analytics (GA4) beside Tag Manager, on every page (index, admin, promo load this in <head>).
// Page views: one per page load, sent by gtag's config. The address goes without its ?query (a ?ref= holds a user id).
// App actions: the pages call track(name, params) for every request to the server (search, signup, pay, mark…), with
// only the action, the village and the result — never a name, phone number, password or what was searched for.
// Each action goes to GA4 directly (when GA_ID is set) and to the dataLayer as event "app_action", so a Tag Manager
// trigger on that event can use them too.
(function () {
  var GA_ID = '';   // the GA4 web stream's measurement ID: G-XXXXXXXXXX (analytics.google.com → Admin → Data streams)
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  if (GA_ID) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
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
})();
