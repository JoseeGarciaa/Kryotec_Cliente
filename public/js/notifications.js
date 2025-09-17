(function(){
  const POLL_INTERVAL_MS = 7000; // 7s, más ágil
  const endpoint = '/notificaciones/api/updates';
  let lastId = 0;
  let timer = null;
  let welcomed = false;
  let fallbackOnly = false;

  function canNotify(){
    // Para notificaciones simples no requerimos serviceWorker
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  async function ensurePermission(){
    if(!canNotify()) return false;
    if(Notification.permission === 'granted') return true;
    if(Notification.permission === 'denied') return false;
    try {
      const res = await Notification.requestPermission();
      return res === 'granted';
    } catch {
      return false;
    }
  }

  async function poll(){
    try {
      const q = lastId > 0 ? ('?after='+encodeURIComponent(String(lastId))) : '';
      const res = await fetch(endpoint + q, { credentials: 'same-origin', cache: 'no-store' });
      if(!res.ok) return;
      const data = await res.json();
      if(!data) return;
      if(Array.isArray(data.items)){
        for(const it of data.items){
          show(it);
        }
      }
      if(typeof data.lastId === 'number' && data.lastId > lastId){
        lastId = data.lastId;
      }
    } catch {}
  }

  function show(alert){
    const title = (alert.tipo_alerta || 'Alerta');
    const body = (alert.descripcion || 'Hay una nueva notificación');
    const ts = new Date(alert.fecha_creacion || Date.now());

    // Siempre mostramos un toast in-app para asegurar feedback visual
    showInApp(alert);

    if(!canNotify() || Notification.permission !== 'granted') {
      return; // nativa no disponible
    }
    try {
      const notif = new Notification(title, {
        body: body + ' • ' + ts.toLocaleString(),
      icon: '/static/images/favicon.png',
      tag: 'kryo-alert-'+alert.id,
        requireInteraction: true,
        timestamp: ts.getTime(),
        renotify: true,
        silent: false,
      });
      notif.onclick = () => {
      window.focus();
      try { notif.close(); } catch{}
      // Opcional: ir a la sección de notificaciones
      window.location.href = '/notificaciones';
      };
    } catch(e) {
      // Silencioso si el navegador no permite construir la notificación
      console.debug('Notification error', e);
    }
  }

  function showInApp(alert){
    try {
      const title = (alert.tipo_alerta || 'Alerta');
      const body = (alert.descripcion || 'Hay una nueva notificación');
      let container = document.querySelector('#kryo-toast-container');
      if(!container){
        container = document.createElement('div');
        container.id = 'kryo-toast-container';
        // Responsive: bottom on mobile, end/right on >=sm; small gap between toasts
        container.className = 'toast toast-bottom sm:toast-end gap-2';
        container.style.zIndex = '9999';
        document.body.appendChild(container);
      }
      const item = document.createElement('div');
      // Friendlier/smaller typography, rounded, subtle border
      item.className = 'alert alert-info shadow rounded-2xl border border-info/30 p-3 md:p-4 text-sm';
      item.setAttribute('role', 'status');
      item.setAttribute('aria-live', 'polite');

      // Layout: content on the left, close button on the right
      const row = document.createElement('div');
      row.className = 'w-full flex items-start gap-3';

      const content = document.createElement('div');
      content.className = 'min-w-0';

      const titleEl = document.createElement('div');
      titleEl.className = 'font-semibold text-base-content/90 mb-0.5';
      titleEl.textContent = String(title);

      const bodyEl = document.createElement('div');
      bodyEl.className = 'text-xs md:text-sm leading-snug break-words max-w-[92vw] sm:max-w-[24rem] md:max-w-[36rem]';
      bodyEl.textContent = String(body);

      content.appendChild(titleEl);
      content.appendChild(bodyEl);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-ghost btn-xs text-base-content/70 hover:text-base-content ml-2';
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Cerrar notificación');
      closeBtn.textContent = '✕';

      // Close interaction (CSP-safe)
      const removeItem = () => { try { item.remove(); } catch {} };
      closeBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); removeItem(); });

      // Clicking the toast navigates to Notificaciones (keeps current behavior intuitive)
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => { try { window.location.href = '/notificaciones'; } catch{} });

      row.appendChild(content);
      row.appendChild(closeBtn);
      item.appendChild(row);
      container.appendChild(item);

      // Auto-dismiss after a few seconds, unless user already closed it
      const autoTimer = setTimeout(removeItem, 6000);
    } catch {}
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]);
    });
  }

  async function init(){
    // Solo en páginas autenticadas dentro del layout principal
    const hasBody = document.querySelector('main, section, body');
    if(!hasBody) return;
  const ok = await ensurePermission();
  if(!ok) { fallbackOnly = true; }
    // One-time welcome per session
    try {
      if(!fallbackOnly && sessionStorage && !sessionStorage.getItem('kryoNotifWelcome')){
        sessionStorage.setItem('kryoNotifWelcome', '1');
        show({ id: 'welcome', tipo_alerta: 'Notificaciones activadas', descripcion: 'Te avisaremos sobre nuevos eventos', fecha_creacion: Date.now() });
      }
    } catch {}
    // Semilla inicial para evitar spam en el primer poll: obtener lastId visible
    try {
      const res = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
      if(res.ok){
        const data = await res.json();
        if(typeof data.lastId === 'number') lastId = data.lastId;
      }
    } catch {}
    // Empezar polling: primer poll inmediato y luego intervalo
    poll();
    timer = setInterval(poll, POLL_INTERVAL_MS);

    // Poll al volver a la pestaña
    document.addEventListener('visibilitychange', function(){
      if(document.visibilityState === 'visible'){
        poll();
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
