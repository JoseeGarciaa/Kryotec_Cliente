(function(){
  const TOGGLE_ATTR = 'data-password-toggle';
  const OPEN_ICON = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12c2.2-4 6.1-6.5 10.5-6.5S20.3 8 22.5 12c-2.2 4-6.1 6.5-10.5 6.5S3.7 16 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const CLOSED_ICON = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M21 12c-2.2 4-6.1 6.5-10.5 6.5-1.9 0-3.8-.5-5.3-1.4"/><path d="M3 7.5C5.2 3.6 9.1 1.5 12 1.5c1.9 0 3.8.5 5.3 1.4"/><path d="M9.5 9.5a3 3 0 0 1 4 4"/></svg>';
  function setIcon(container, showing){
    if(!(container instanceof HTMLElement)) return;
    container.innerHTML = showing ? OPEN_ICON : CLOSED_ICON;
  }
  function qsa(sel, ctx){ return Array.from((ctx||document).querySelectorAll(sel)); }
  function setupToggle(toggle){
    if(!(toggle instanceof HTMLElement)) return;
    const targetId = toggle.getAttribute(TOGGLE_ATTR);
    if(!targetId) return;
    const input = document.getElementById(targetId);
    if(!(input instanceof HTMLInputElement)) return;
    const iconHolder = toggle.querySelector('[data-eye-icon]');
    const isShowing = input.type !== 'password';
    setIcon(iconHolder, isShowing);
    toggle.addEventListener('click', ()=>{
      const currentlyShowing = input.type !== 'password';
      const nextType = currentlyShowing ? 'password' : 'text';
      input.type = nextType;
      toggle.setAttribute('aria-pressed', nextType === 'text' ? 'true' : 'false');
      setIcon(iconHolder, nextType === 'text');
    });
  }
  qsa(`[${TOGGLE_ATTR}]`).forEach(setupToggle);
})();