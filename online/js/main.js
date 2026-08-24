/* ============ 联机版入口：渲染管线 / 登录 / 大厅接线 / 主循环 ============
 * 渲染：Canvas + requestAnimationFrame（规范红线），游戏循环与 UI 状态分离。
 * 鱼眼后期：常驻；理智越低越重；晕 3D 友好模式减半。
 */
(function () {
  const { clamp } = U;

  window.__errors = [];
  window.addEventListener('error', (e) => {
    window.__errors.push((e.message || 'error') + ' @ ' + (e.filename || '') + ':' + e.lineno);
  });

  // ---------- 渲染器与场景 ----------
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0b07);
  scene.fog = new THREE.FogExp2(0x0d0b07, 0.05);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 130);

  // ---------- 鱼眼后期 ----------
  const dbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(dbSize.x, dbSize.y, { samples: 4 });
  rt.texture.encoding = THREE.sRGBEncoding;
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: rt.texture },
      k: { value: 0.22 },
      ca: { value: 0.006 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform float k;
      uniform float ca;
      void main() {
        vec2 d = vUv - 0.5;
        float r2 = dot(d, d);
        vec2 uv = vUv + d * (k * r2);
        vec2 shift = d * (ca * r2);
        vec3 col;
        col.r = texture2D(tDiffuse, uv + shift).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - shift).b;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

  function renderFrame() {
    const san = Game.san !== undefined ? Game.san : 100;
    const low = clamp((50 - san) / 50, 0, 1);
    const deep = clamp((25 - san) / 25, 0, 1);
    const wob = deep * Math.sin(performance.now() * 0.003) * 0.02;
    const mul = (Game.settings && Game.settings.friendly) ? 0.5 : 1;
    postMat.uniforms.k.value = (0.22 + low * 0.10 + deep * 0.08 + wob) * mul;
    postMat.uniforms.ca.value = (0.006 + low * 0.010 + deep * 0.008) * mul;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    rt.setSize(s.x, s.y);
  });

  // ---------- 注入 Game ----------
  Game.gl = { scene, camera, renderFrame };
  Game.player = new Player(camera, null);
  scene.add(Game.player.holder);
  scene.add(Game.player.flashlight, Game.player.flTarget, Game.player.glow);
  Game.player.flashlight.castShadow = Game.settings.shadows;

  // ---------- 主循环（渲染与逻辑分离，无轮询）----------
  let _last = performance.now(), _frames = 0, _fatal = false;
  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - _last) / 1000 || 0.016);
    _last = now;
    try {
      Game.tick(dt, now);
      renderFrame();
      _frames++;
    } catch (err) {
      if (!_fatal) {
        _fatal = true;
        window.__errors.push('tick: ' + (err.stack || err));
        console.error(err);
        try { UI.msg('运行错误：' + err.message, 'danger', 12000); } catch (_) { }
      }
    }
  }
  requestAnimationFrame(tick);

  // ---------- SDK 初始化与登录 UI ----------
  const $ = (id) => document.getElementById(id);

  (async function boot() {
    const ok = await Net.init();
    UI.setNet(ok ? (Net.online ? 'SDK 就绪' : 'SDK 就绪（未登录）') : '离线模式', ok);
    UI.setAuth(null);
    if (Net.vibe) {
      const u = Net.vibe.user;
      if (u) { Game.myName = u.name || '玩家'; UI.setAuth(u); }
      Net.onAuth((user) => {
        Game.myName = user ? (user.name || '玩家') : (Game.myName || '练习生');
        UI.setAuth(user);
        UI.setNet(user ? '已连接' : '未登录', !!user);
      });
    }
    if (!Game.myName) Game.myName = '练习生-' + String(Math.floor(Math.random() * 900) + 100);
    refreshRooms();
  })();
  // 判断是否为触摸设备
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

if (isTouchDevice) {
    const script = document.createElement('script');
    script.src = 'js/lib/nipplejs.js';   // 加上这一行！
    script.onload = () => {
        initJoystick();
    };
    document.head.appendChild(script);
} else {
    console.log('电脑端：不加载摇杆');
}

function initJoystick() {
    const zone = document.getElementById('joystick-zone');
    zone.style.display = 'block'; // 显示

    const manager = nipplejs.create({
        zone: zone,
        mode: 'static',          // 固定位置摇杆
        position: { left: '50%', top: '50%' },
        color: 'rgba(255,255,255,0.25)',
        size: 120,
        restOpacity: 0.5,
    });

    // 摇杆移动时存储数据到全局或 Player 实例
    let stickX = 0, stickY = 0;

    manager.on('move', (evt, data) => {
        // data.vector 是一个 { x, y }，范围 -1 ~ 1
        const v = data.vector;
        stickX = v.x;
        stickY = v.y;
        // 将值传给 Player 实例
        if (Game.player) {
            Game.player.stickX = stickX;
            Game.player.stickY = stickY;
        }
    });

    manager.on('end', () => {
        stickX = 0;
        stickY = 0;
        if (Game.player) {
            Game.player.stickX = 0;
            Game.player.stickY = 0;
        }
    });

    // 防止触摸滚动
    zone.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    zone.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}

  $('btnLogin').addEventListener('click', async () => {
    const u = await Net.login();
    if (!u) UI.msg('登录失败或已取消，可先玩本地练习。', 'warn', 3500);
  });
  $('btnLogout').addEventListener('click', () => Net.logout());

  // ---------- 大厅按钮 ----------
  async function refreshRooms() {
    const box = $('roomList');
    if (!Net.vibe) { box.innerHTML = '<p class="dim">离线模式：无法浏览房间，可创建本地练习。</p>'; return; }
    box.innerHTML = '<p class="dim">加载中…</p>';
    const rooms = await Net.listRooms();
    if (!rooms.length) { box.innerHTML = '<p class="dim">暂无公开房间，创建一个吧。</p>'; return; }
    box.innerHTML = rooms.map((r) =>
      `<div class="rline"><span>${escapeHtml(r.roomId)} · ${r.players}/${r.max} 人${r.pass ? ' · 🔒' : ''}</span>` +
      `<button class="mini rjoin" data-code="${escapeHtml(r.roomId)}">加入</button></div>`
    ).join('');
    box.querySelectorAll('.rjoin').forEach((b) =>
      b.addEventListener('click', () => joinByCode(b.dataset.code)));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  $('btnRefresh').addEventListener('click', refreshRooms);

  async function afterJoin(res) {
    if (!res || res.error) {
      const why = res && res.error === 'pass' ? '密码错误' :
        res && res.error === 'full' ? '房间已满' :
          res && res.error === 'notfound' ? '房间不存在' : '加入失败';
      UI.msg(why, 'warn', 3000);
      return;
    }
    Game.enterRoom(res.roomId, false);
    Net.send({ t: 'hello', name: Game.myName }); // 向房主报名
    UI.setNet('房间内', true);
  }

  $('btnCreate').addEventListener('click', async () => {
    Game.settings.friendly = $('optFriendly').checked;
    Game.settings.timid = $('optTimid').checked;
    Game.maxPlayers = parseInt($('optMax').value, 10) || 4;
    if (!Net.vibe) { // 离线：直接本地练习
      Game.enterRoom('LOCAL', true);
      return;
    }
    if (!Net.online) {
      const u = await Net.login();
      if (!u) { UI.msg('联机需要先登录；已为你开启本地练习。', 'warn', 3500); Game.enterRoom('LOCAL', true); return; }
    }
    UI.msg('正在创建房间…', null, 2500);
    const res = await Net.createRoom({ max: Game.maxPlayers, pass: $('optPass').value.trim() });
    if (!res) { UI.msg('创建失败，请重试或先本地练习。', 'warn', 3500); return; }
    Game.enterRoom(res.roomId, false);
    UI.setNet('房间内（房主）', true);
  });

  async function joinByCode(code) {
    Game.settings.friendly = $('optFriendly').checked;
    Game.settings.timid = $('optTimid').checked;
    if (!Net.vibe) { UI.msg('离线模式无法加入房间。', 'warn', 3000); return; }
    if (!Net.online) {
      const u = await Net.login();
      if (!u) { UI.msg('联机需要先登录。', 'warn', 3000); return; }
    }
    const res = await Net.joinRoom(code || $('optCode').value);
    await afterJoin(res);
  }
  $('btnJoinCode').addEventListener('click', () => joinByCode(null));

  $('btnQuick').addEventListener('click', async () => {
    Game.settings.friendly = $('optFriendly').checked;
    Game.settings.timid = $('optTimid').checked;
    if (!Net.vibe || !Net.online) { UI.msg('快速加入需要登录。', 'warn', 3000); return; }
    const id = await Net.quickJoin();
    if (!id) { UI.msg('没有可加入的房间。', 'warn', 3000); return; }
    await afterJoin(await Net.joinRoom(id));
  });

  // ---------- 房间按钮 ----------
  $('btnReady').addEventListener('click', () => Game.toggleReady());
  $('btnStartRound').addEventListener('click', () => Game.startRound());
  $('btnLeave').addEventListener('click', () => Game.leaveRoom());

  // ---------- 结算按钮 ----------
  $('btnAgain').addEventListener('click', () => { UI.show('screen-room'); Game.backToRoom(); });
  $('btnBackLobby').addEventListener('click', () => { UI.show('screen-room'); Game.backToRoom(); });

  // 点击画面锁定指针（对局中）
  canvas.addEventListener('click', () => {
    if ((Game.phase === 'playing' || Game.phase === 'countdown') && !Game.player._locked)
      Game.player.requestLock();
  });
})();
