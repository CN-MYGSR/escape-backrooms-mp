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
  UI.setBattery = (v) => {
    const f = $('batteryFill');
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
    const sl = $('slots');
    if (sl) sl.style.opacity = isShadow ? '0.35' : '1';
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

  // ---------- 物品槽（1 手电 / 2、3 物品） ----------
  UI.setSlots = (slots, sel, batPct) => {
    for (let i = 0; i < 3; i++) {
      const ico = $('slot' + i);
      if (!ico) continue;
      const box = ico.parentElement;
      let txt = '—', empty = i > 0;
      if (i === 0) {
        txt = '手电' + (batPct != null ? '·' + Math.round(batPct) + '%' : '');
      } else if (slots && slots[i]) {
        txt = slots[i].k === 'water' ? '杏仁水' : '电池';
        empty = false;
      }
      ico.textContent = txt;
      box.classList.toggle('sel', i === sel);
      box.classList.toggle('empty', empty);
    }
  };

  // ---------- 聊天 ----------
  UI.openChat = function () {
    const inp = $('chatInput');
    if (!inp || (window.Game && Game.chatOpen)) return;
    if (window.Game) {
      Game.chatOpen = true;
      if (Game.player) Game.player.keys = {}; // 打字时停住移动
    }
    inp.classList.remove('hidden');
    inp.value = '';
    inp.focus();
  };
  UI.closeChat = function (send) {
    const inp = $('chatInput');
    if (!inp || !(window.Game && Game.chatOpen)) return '';
    const text = inp.value.trim().slice(0, 80);
    inp.value = '';
    inp.classList.add('hidden');
    inp.blur();
    Game.chatOpen = false;
    return send ? text : '';
  };
  UI.addChat = function (name, text) {
    const log = $('chatLog');
    if (!log) return;
    const el = document.createElement('div');
    el.className = 'chat-line';
    const b = document.createElement('b');
    b.textContent = name + '：';
    el.appendChild(b);
    el.appendChild(document.createTextNode(text));
    log.appendChild(el);
    while (log.children.length > 6) log.removeChild(log.firstChild);
    setTimeout(() => { el.style.opacity = '0'; }, 8000);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 9000);
  };
  // 聊天输入键（Enter 发送 / Esc 取消）——绑在 window 捕获阶段：
  // 真实打字经 input 冒泡可达，合成键盘事件派发到页面根也可达
  (() => {
    window.addEventListener('keydown', (e) => {
      if (!(window.Game && Game.chatOpen)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const t = UI.closeChat(true);
        if (t && Game.sendChat) Game.sendChat(t);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        UI.closeChat(false);
      }
    }, true);
  })();

  window.UI = UI;
})();
