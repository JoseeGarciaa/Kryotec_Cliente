(function(){
  function qs(sel){ return document.querySelector(sel); }
  function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }
  function refreshButtons(rows, btnResolve, btnDelete){
    const any = rows.some(r => r.checked);
    if (btnResolve) btnResolve.disabled = !any;
    if (btnDelete) btnDelete.disabled = !any;
  }
  function init(){
    const selectAll = qs('#select-all');
    const rows = qsa('.row-select');
    const btnResolve = qs('#btn-bulk-resolve');
    const btnDelete = qs('#btn-bulk-delete');
    if (!selectAll && rows.length === 0) return; // Not on this page
    if (selectAll){
      selectAll.addEventListener('change', function(){
        rows.forEach(r => { r.checked = selectAll.checked; });
        refreshButtons(rows, btnResolve, btnDelete);
      });
    }
    rows.forEach(r => r.addEventListener('change', function(){ refreshButtons(rows, btnResolve, btnDelete); }));
    refreshButtons(rows, btnResolve, btnDelete);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
