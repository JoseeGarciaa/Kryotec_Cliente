// View transitions + subtle UI polish
// Turbo Drive for fast page navigations
(function(){
  // If Turbo is available later, it will take over. Fallback: anchor prefetch + fade transitions.
  const supportsViewTransitions = typeof document !== 'undefined' && 'startViewTransition' in document;

  // Fade on link navigation
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || a.target === '_blank') return;
    // Only internal
    if (/^https?:\/\//i.test(href)) return;
    if (supportsViewTransitions) {
      e.preventDefault();
      document.startViewTransition(async () => {
        window.location.href = href;
      });
    }
  });

  // Auto-animate cards on load
  window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.card').forEach((el, i) => {
      el.classList.add('animate-slide-up');
      el.style.animationDelay = (i * 40) + 'ms';
    });
  });
})();
