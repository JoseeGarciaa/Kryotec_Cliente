(function(){
  if (!('serviceWorker' in navigator)) return;
  var register = function(){
    navigator.serviceWorker.register('/sw.js').catch(function(err){
      console.debug('SW register failed', err);
    });
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    register();
  } else {
    document.addEventListener('DOMContentLoaded', register);
  }

  // Let the browser show its own install UI; do not intercept beforeinstallprompt.
  window.addEventListener('appinstalled', function(){
    try { localStorage.setItem('kryo_pwa_installed', '1'); } catch(_){}
  });
})();
