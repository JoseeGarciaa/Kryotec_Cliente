(function(){
  document.addEventListener('DOMContentLoaded', function(){
    const btn = document.getElementById('btn-add-order');
    const modal = document.getElementById('modal-add-order');
    if(btn && modal && typeof modal.showModal === 'function'){
      btn.addEventListener('click', function(){
        modal.showModal();
      });
    }
    // Close buttons inside modal that have data-close attribute
    document.querySelectorAll('#modal-add-order [data-close]')
      .forEach(el => el.addEventListener('click', () => modal?.close()))
    // If backdrop exists, ensure click closes via native <form method="dialog">
    const backdrop = document.querySelector('#modal-add-order .modal-backdrop');
    if(backdrop){
      backdrop.addEventListener('click', () => modal?.close());
    }
  });
})();
