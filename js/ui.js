/* ============ UI：HUD / 小地图 / 消息 / 全屏界面 ============ */
(function () {
  const $ = (id) => document.getElementById(id);
  const UI = {};

  UI.hud = () => $('hud');
  UI.show = (id) => { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); if (id) $(id).classList.add('active'); };
  UI.hideScreens = () => UI.show(null);

  UI.setStamina = (v, low) => {
    const f = $('staminaFill');
    f.style.width = v + '%';
    f.classList.toggle('low', low);
  };
  UI.setHealth = (v) => { $('healthFill').style.width = Math.max(0, v) + '%'; };
  UI.setSan = (v) => {
    const f = $('sanFill');
    f.style.width = Math.max(0, v) + '%';
    f.classList.toggle('low', v <= 25);
  };
  UI.showSpectate = (on) => { $('screen-spectate').style.display = on ? 'block' : 'none'; };
  UI.setBottles = (n, total) => { $('bottleCount').textContent = `杏仁水 ${n}/${total}`; };
  UI.setTimer = (sec) => {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    $('timer').textContent = `${m}:${s}`;
  };
  UI.setObjective = (t) => { $('objective').textContent = t; };

  // 消息队列（自动淡出）
  UI.msg = function (text, cls, dur) {
    const box = $('messages');
    const el = document.createElement('div');
    el.className = 'msg' + (cls ? ' ' + cls : '');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { el.style.opacity = '0'; }, dur || 3200);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, (dur || 3200) + 700);
  };

  UI.damageFlash = function () {
    const d = $('damage');
    d.style.transition = 'none'; d.style.opacity = '0.9';
    requestAnimationFrame(() => {
      d.style.transition = 'opacity 0.6s'; d.style.opacity = '0';
    });
  };
  UI.setDarkness = function (v) { $('darkness').style.opacity = String(v); };

  // 对话框内容
  UI.setDeath = function (reason, stats) {
    $('deathReason').textContent = reason;
    $('deathStats').textContent = stats;
  };
  UI.setWin = function (stats) { $('winStats').textContent = stats; };

  window.UI = UI;
})();
