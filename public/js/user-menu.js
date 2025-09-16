// User menu actions (CSP-compliant external file)
(function(){
  document.addEventListener('DOMContentLoaded', function(){
    const s = document.getElementById('user-settings');
    const n = document.getElementById('user-notifs');
    if(s){ s.addEventListener('click', function(e){ e.preventDefault(); window.location.href = '/cuenta'; }); }
    if(n){ n.addEventListener('click', function(e){ e.preventDefault(); window.location.href = '/notificaciones'; }); }
  });
})();
