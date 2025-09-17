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
    // Create a small, unobtrusive CTA to install
    try {
      var cta = document.getElementById('kryo-pwa-install');
      if (!cta) {
        cta = document.createElement('div');
        cta.id = 'kryo-pwa-install';
        cta.setAttribute('role','dialog');
        cta.style.position='fixed';
        cta.style.left='0'; cta.style.right='0'; cta.style.bottom='12px';
        cta.style.margin='0 auto'; cta.style.maxWidth='420px';
        cta.style.background='var(--fallback-b1, #1d232a)';
        cta.style.color='var(--fallback-bc, #a6adbb)';
        cta.style.border='1px solid rgba(200,200,200,0.25)';
        cta.style.borderRadius='10px'; cta.style.padding='10px 12px';
        cta.style.boxShadow='0 6px 16px rgba(0,0,0,0.25)';
        cta.style.zIndex='9999';
        cta.style.display='flex'; cta.style.alignItems='center'; cta.style.gap='10px';
        cta.innerHTML = '<div style="flex:1;line-height:1.2"><div style="font-weight:600;font-size:14px">Instalar KryoSense</div><div style="opacity:.85;font-size:12px">Añade la app a tu pantalla de inicio</div></div>';
        var btn = document.createElement('button');
        btn.textContent = 'Instalar';
        btn.style.background='var(--fallback-p, #6d5efc)';
        btn.style.color='#fff'; btn.style.border='none'; btn.style.padding='8px 12px';
        btn.style.borderRadius='8px'; btn.style.fontWeight='600'; btn.style.fontSize='13px';
        var close = document.createElement('button');
        close.textContent='✕';
        close.style.background='transparent'; close.style.border='none'; close.style.color='inherit'; close.style.fontSize='14px';
        close.style.marginLeft='8px';
        close.addEventListener('click', function(){ cta.remove(); });
        btn.addEventListener('click', function(){
          var p = window.__kryoDeferPrompt; if (!p) return;
          p.prompt();
          p.userChoice.finally(function(){ cta.remove(); window.__kryoDeferPrompt = null; });
        });
        cta.appendChild(btn); cta.appendChild(close);
        document.body.appendChild(cta);
      } else {
        cta.style.display='flex';
      }
    } catch(_){}
  });
})();
