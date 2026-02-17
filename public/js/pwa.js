(function(){
  if (!('serviceWorker' in navigator)) return;
  var register = function(){
    navigator.serviceWorker.register('/sw.js').catch(function(err){
      console.debug('SW register failed', err);
    });
  };
  var lockOrientation = function(){
    var target = 'portrait-primary';
    try {
      if (screen.orientation && screen.orientation.lock) {
        var res = screen.orientation.lock(target);
        if (res && typeof res.catch === 'function') res.catch(function(){});
        return;
      }
      var legacy = screen.lockOrientation || screen.mozLockOrientation || screen.msLockOrientation;
      if (legacy) legacy.call(screen, target);
    } catch(_){ }
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    register();
    lockOrientation();
  } else {
    document.addEventListener('DOMContentLoaded', function(){
      register();
      lockOrientation();
    });
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

  // iOS / macOS Safari fallback (no beforeinstallprompt)
  function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isStandalone(){ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone === true); }
  function isSafari(){
    var ua = navigator.userAgent;
    return /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/i.test(ua);
  }

  function ensureIOSHelp(){
    if (deferredPrompt) return; // native prompt available
    if (!(isIOS() || isSafari()) || isStandalone()) return;
    ensureButton();
    if (!btn) return;
    btn.textContent = 'Cómo instalar';
    btn.style.display='inline-flex';
    btn.onclick = function(){ showInstructions(); };
  }

  function showInstructions(){
    var existing = document.getElementById('kryo-ios-help');
    if (existing) { existing.remove(); }
    var wrap = document.createElement('div');
    wrap.id = 'kryo-ios-help';
    wrap.style.position='fixed';wrap.style.inset='0';wrap.style.background='rgba(0,0,0,.55)';wrap.style.zIndex='1001';
    wrap.innerHTML = '<div style="max-width:440px;margin:60px auto;background:#121826;padding:24px;border-radius:16px;font:14px system-ui;color:#fff;line-height:1.5;box-shadow:0 10px 30px -5px rgba(0,0,0,.6);">'
      + '<div style="font-size:17px;font-weight:600;margin-bottom:10px;">Instalar KryoSense</div>'
      + '<ol style="padding-left:18px;margin:0 0 14px;">'
      + (isIOS() ? (
          '<li>Abre en Safari (no en navegador interno).</li>'+
          '<li>Toca el botón compartir (cuadro con flecha ↑).</li>'+
          '<li>Selecciona "Agregar a pantalla de inicio".</li>'+
          '<li>Confirma el nombre y pulsa Añadir.</li>'
        ) : (
          '<li>En Safari macOS abre el menú "Archivo".</li>'+
          '<li>Elige "Agregar al Dock" (o "Add to Dock").</li>'+
          '<li>Opcional: Ajusta el nombre y confirma.</li>'
        ))
      + '</ol>'
      + '<div style="opacity:.7;font-size:12px;">Esta guía aparece porque tu navegador no expone el prompt de instalación estándar.</div>'
      + '<div style="margin-top:16px;text-align:right"><button id="kryo-ios-help-close" style="background:#6d5efc;border:0;padding:8px 16px;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;">Cerrar</button></div>'
      + '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function(e){ if (e.target === wrap) wrap.remove(); });
    document.getElementById('kryo-ios-help-close').addEventListener('click', function(){ wrap.remove(); });
  }

  // Delay to allow beforeinstallprompt (if any) else fallback
  setTimeout(ensureIOSHelp, 2500);
})();
