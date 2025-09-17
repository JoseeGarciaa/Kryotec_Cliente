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
  var state = {
    deferred: null,
    cta: null,
    dismissedAt: 0
  };

  var isStandalone = function(){
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone === true);
  };

  var saveDismiss = function(){
    try { localStorage.setItem('kryo_pwa_dismissed_at', String(Date.now())); } catch(_){}
  };
  var recentlyDismissed = function(){
    try { state.dismissedAt = Number(localStorage.getItem('kryo_pwa_dismissed_at')||'0'); } catch(_){}
    // 2 days cooldown
    return state.dismissedAt && (Date.now() - state.dismissedAt < 2*24*60*60*1000);
  };

  var showInstructions = function(){
    // Minimal inline sheet with instructions for Android Chrome fallback
    var sheet = document.createElement('div');
    sheet.style.position='fixed'; sheet.style.left='0'; sheet.style.right='0'; sheet.style.bottom='0';
    sheet.style.background='var(--fallback-b1, #1d232a)'; sheet.style.color='var(--fallback-bc, #a6adbb)';
    sheet.style.borderTop='1px solid rgba(200,200,200,0.25)'; sheet.style.boxShadow='0 -12px 30px rgba(0,0,0,.35)';
    sheet.style.padding='16px'; sheet.style.zIndex='10000';
    var close = document.createElement('button');
    close.textContent='✕'; close.style.float='right'; close.style.background='transparent'; close.style.border='none'; close.style.color='inherit'; close.style.fontSize='16px';
    close.addEventListener('click', function(){ sheet.remove(); });
    var title = document.createElement('div'); title.textContent='Cómo instalar la app'; title.style.fontWeight='700'; title.style.margin='0 0 8px 0';
    var steps = document.createElement('ol'); steps.style.margin='0'; steps.style.padding='0 0 0 18px'; steps.style.lineHeight='1.4';
    var ua = navigator.userAgent.toLowerCase();
    var instructions;
    if (ua.includes('iphone') || ua.includes('ipad')) {
      instructions = [
        'Abre en Safari',
        'Toca el botón Compartir (cuadro con flecha)',
        'Elige “Añadir a pantalla de inicio”',
        'Confirma con “Añadir”'
      ];
    } else {
      instructions = [
        'Abre el menú de Chrome (⋮)',
        'Selecciona “Instalar app” o “Añadir a pantalla principal”',
        'Confirma en el diálogo'
      ];
    }
    instructions.forEach(function(s){ var li=document.createElement('li'); li.textContent=s; steps.appendChild(li); });
    sheet.appendChild(close); sheet.appendChild(title); sheet.appendChild(steps); document.body.appendChild(sheet);
  };

  var buildCTA = function(){
    if (state.cta) return state.cta;
    var cta = document.createElement('div');
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
    var how = document.createElement('button');
    how.textContent='Cómo'; how.style.background='transparent'; how.style.border='1px solid rgba(200,200,200,0.25)'; how.style.color='inherit';
    how.style.padding='6px 10px'; how.style.borderRadius='8px'; how.style.fontSize='12px';
    var close = document.createElement('button');
    close.textContent='✕';
    close.style.background='transparent'; close.style.border='none'; close.style.color='inherit'; close.style.fontSize='14px';
    close.style.marginLeft='6px';
    close.addEventListener('click', function(){ cta.remove(); saveDismiss(); });
    btn.addEventListener('click', function(){
      if (state.deferred) {
        state.deferred.prompt();
        state.deferred.userChoice.finally(function(){ cta.remove(); state.deferred = null; saveDismiss(); });
      } else {
        showInstructions();
      }
    });
    how.addEventListener('click', function(){ showInstructions(); });
    cta.appendChild(btn); cta.appendChild(how); cta.appendChild(close);
    state.cta = cta; return cta;
  };

  var maybeShowCTA = function(){
    if (isStandalone() || recentlyDismissed()) return;
    var el = buildCTA();
    if (!document.body.contains(el)) document.body.appendChild(el);
    el.style.display='flex';
  };

  window.addEventListener('beforeinstallprompt', function(e){
    // Stash the event for triggering later (e.g., via a button the UI could show)
    window.__kryoDeferPrompt = e;
    state.deferred = e;
    try { e.preventDefault(); } catch(_){}
    try { maybeShowCTA(); } catch(_){}
  });

  window.addEventListener('appinstalled', function(){
    try {
      if (state.cta) state.cta.remove();
      localStorage.setItem('kryo_pwa_installed', '1');
    } catch(_){}
  });

  // Fallback: if the browser never fires beforeinstallprompt, still show the CTA (with instructions) after a short delay
  var startFallbackTimer = function(){
    if (isStandalone()) return;
    setTimeout(function(){
      if (!state.deferred) {
        try { maybeShowCTA(); } catch(_){}
      }
    }, 2500);
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startFallbackTimer();
  } else {
    document.addEventListener('DOMContentLoaded', startFallbackTimer);
  }
})();
