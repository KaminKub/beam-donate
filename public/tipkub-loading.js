window.TipKubLoading = (function() {
  var _overlay, _fill, _logo, _maxFill = 0;

  function _getEl() {
    _overlay = document.getElementById('tk-loading-overlay');
    if (!_overlay) return false;
    _fill = _overlay.querySelector('.tk-logo-fill');
    _logo = _overlay.querySelector('.tk-logo-wrap');
    return true;
  }

  function _setFill(pct) {
    if (pct <= _maxFill) return; // fill เดินหน้าเท่านั้น — rAF ที่ late ไม่ revert ได้
    _maxFill = pct;
    if (_fill) _fill.style.clipPath = 'inset(' + (100 - pct) + '% 0 0 0)';
  }

  // รอ fill transition เสร็จก่อน — transitionend + fallback timer
  function _afterFill(fn) {
    if (_fill) {
      var fired = false;
      function once() { if (!fired) { fired = true; fn(); } }
      _fill.addEventListener('transitionend', once, { once: true });
      setTimeout(once, 500);
    } else {
      setTimeout(fn, 400);
    }
  }

  function _glow() {
    if (_logo) _logo.classList.add('tk-glow');
    setTimeout(function() {
      _overlay.classList.add('tk-fade-out');
      _overlay.addEventListener('transitionend', function() {
        _overlay.style.display = 'none';
      }, { once: true });
    }, 500);
  }

  function _doHide() {
    // set clip-path โดยตรงแทน _setFill เพื่อ guarantee transition ทุกกรณี
    _maxFill = 100;
    if (_fill) _fill.style.clipPath = 'inset(0% 0 0 0)';
    _afterFill(_glow);
  }

  function init(opts) {
    opts = opts || {};
    if (!_getEl()) return;

    if (sessionStorage.getItem('tk_from_auth')) {
      sessionStorage.removeItem('tk_from_auth');
      _overlay.style.display = 'none';
      return;
    }

    requestAnimationFrame(function() {
      requestAnimationFrame(function() { _setFill(10); });
    });

    if (opts.mode === 'api-gated') {
      document.addEventListener('DOMContentLoaded', function() { _setFill(30); });
      window.addEventListener('load', function() { _setFill(60); });
    } else {
      document.addEventListener('DOMContentLoaded', function() { _setFill(40); });
      window.addEventListener('load', function() {
        _setFill(100);
        _afterFill(_glow);
      });
    }

    if (opts.authButtons) {
      document.querySelectorAll(opts.authButtons).forEach(function(btn) {
        btn.addEventListener('click', function() {
          sessionStorage.setItem('tk_from_auth', '1');
          _overlay.style.cssText = 'display:flex;opacity:1;transition:none';
        });
      });
    }

    window.addEventListener('pageshow', function(e) {
      if (e.persisted) _overlay.style.display = 'none';
    });
  }

  function hide() {
    if (!_overlay && !_getEl()) return;
    _doHide();
  }

  function show() {
    if (!_overlay && !_getEl()) return;
    _maxFill = 0;
    _overlay.style.cssText = 'display:flex;opacity:1;transition:none';
  }

  return { init: init, hide: hide, show: show };
})();
