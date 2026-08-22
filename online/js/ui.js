/* ============ 联机版 UI：HUD / 消息 / 界面切换 ============ */
(function () {
  const $ = (id) => document.getElementById(id);
  const UI = {};

  UI.show = (id) => {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    if (id) $(id).classList.add('active');
  };
  UI.hud = () => $('hud');

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
  UI.setBottles = (n, total) => { $('bottleCount').textContent = `杏仁水 ${n}/${total}`; };
  UI.setTimer = (sec) => {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    $('timer').textContent = `${m}:${s}`;
  };
  UI.setObjective = (t) => { $('objective').textContent = t; };
  UI.setNet = (t, ok) => {
    const el = $('netState');
    el.textContent = t;
    el.style.color = ok === false ? '#c06a5a' : (ok === true ? '#8fd88a' : '#8fa87a');
  };

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
  UI.setDarkness = (v) => { $('darkness').style.opacity = String(v); };

  // 影者化后隐藏人类条
  UI.setShadowMode = function (isShadow) {
    $('sanBar').style.display = isShadow ? 'none' : '';
    $('bars').style.opacity = isShadow ? '0.35' : '1';
  };

  // 幸存者列表（右上）
  UI.setAliveList = function (rows) {
    $('aliveList').innerHTML = rows.map((r) =>
      `<div class="${r.shadow ? 'sh' : 'hu'}${r.me ? ' me' : ''}">${r.name}${r.shadow ? ' · 影者' : ''}</div>`
    ).join('');
  };

  UI.setAuth = function (user) {
    $('authStatus').textContent = user ? `已登录：${user.name || '玩家'}` : '未登录（离线练习可用）';
    $('btnLogin').classList.toggle('hidden', !!user);
    $('btnLogout').classList.toggle('hidden', !user);
  };

  UI.setRoomCode = (code) => { $('roomCode').textContent = code || '—'; };

  window.UI = UI;
})();
