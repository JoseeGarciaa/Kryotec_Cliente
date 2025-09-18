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

  // Custom install prompt
  var deferredPrompt = null;
  var btn = null;
  function ensureButton(){
    if (btn || !document.body) return;
    btn = document.createElement('button');
    btn.id = 'kryo-install-btn';
    btn.textContent = 'Instalar app';
    btn.style.position='fixed';
    btn.style.right='16px';
    btn.style.bottom='16px';
    btn.style.zIndex='1000';
    btn.style.padding='10px 14px';
    btn.style.borderRadius='9999px';
    btn.style.background='#6d5efc';
    btn.style.color='#fff';
    btn.style.boxShadow='0 4px 12px rgba(0,0,0,.25)';
    btn.style.border='0';
    btn.style.cursor='pointer';
    btn.style.display='none';
    document.body.appendChild(btn);
    btn.addEventListener('click', async function(){
      if (!deferredPrompt) return;
      btn.style.display='none';
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch(_){}
      deferredPrompt = null;
    });
  }

  window.addEventListener('beforeinstallprompt', function(e){
    // Prevent default mini-infobar
    e.preventDefault();
    deferredPrompt = e;
    ensureButton();
    if (btn) btn.style.display='inline-flex';
  });

  window.addEventListener('appinstalled', function(){
    try { localStorage.setItem('kryo_pwa_installed', '1'); } catch(_){}
    if (btn) btn.style.display='none';
    deferredPrompt = null;
  });
})();
