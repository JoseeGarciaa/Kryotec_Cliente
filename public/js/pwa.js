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

  // Optional: surface install prompt for users
  window.addEventListener('beforeinstallprompt', function(e){
    // Stash the event for triggering later (e.g., via a button the UI could show)
    window.__kryoDeferPrompt = e;
    try { e.preventDefault(); } catch(_){}
    // If you later want to show a CTA, you can trigger: window.__kryoDeferPrompt.prompt()
  });
})();
