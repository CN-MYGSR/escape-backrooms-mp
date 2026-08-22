/* ============ 主循环：游戏状态 / 输入 / 各系统接线 ============ */
(function () {
  const { clamp, dist2D } = U;

  // 全局错误捕获（便于排查，F12 之外也能看到）
  window.__errors = [];
  window.addEventListener('error', (e) => {
    window.__errors.push((e.message || 'error') + ' @ ' + (e.filename || '') + ':' + e.lineno);
  });

  const Game = {
    state: 'menu', // menu | playing | paused | dead | won | spectate
    time: 0,
    bottles: 0,
    san: 100,             // 理智：1 秒 -5，归零则化身影者进入观战
    spectate: false,
    hallucinations: [],
    shadowSelf: null,     // 理智归零后玩家化成的影者
    ghost: null,          // 观战时喂给怪物 AI 的"幽灵假人"
    spec: null,           // 观战相机状态
    _sanFlags: null,
    quality: { shadows: true },
    settings: { friendly: false }, // 晕 3D 友好模式
    _last: 0,
    _introT: 0, _introStep: 0,
    _frames: 0, _fatal: false,
    _directorT: 12,
  };
  window.Game = Game;

  // ---------- 初始化渲染器 ----------
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
  // 相机挂在 player.holder 支架下（见 newRun），不直接加入场景

  // ---------- 鱼眼后期：全屏桶形畸变 + 边缘轻微色散 ----------
  const dbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(dbSize.x, dbSize.y, { samples: 4 });
  rt.texture.encoding = THREE.sRGBEncoding;
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: rt.texture },
      k: { value: 0.085 },   // 桶形畸变强度
      ca: { value: 0.004 },  // 边缘色散强度
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
        vec2 uv = vUv + d * (k * r2);   // 桶形（鱼眼）畸变：越靠边缘越弯
        vec2 shift = d * (ca * r2);     // 边缘色散
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
    // 鱼眼畸变常驻（与怪物无关），基础值即清晰可见；
    // 理智 ≤50 渐强、≤25 二次加重并叠加呼吸式波动；
    // 晕 3D 友好模式下整体强度减半
    const san = (Game.san !== undefined) ? Game.san : 100;
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

  function disposeGroup(g) {
    g.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    g.parent && g.parent.remove(g);
  }

  // ---------- 开新局 ----------
  Game.newRun = function () {
    if (Game.world) Game.world.dispose(scene);
    if (Game.humanoid) disposeGroup(Game.humanoid.group);
    if (Game.smiler) disposeGroup(Game.smiler.group);

    const seed = (Date.now() ^ (Math.random() * 0xfffff)) >>> 0;
    Game.seed = seed;
    const maze = MZ.generate(seed, {
      W: 63, H: 63, maxLeaf: 9, hallChance: 0.26,
      loopFactor: 0.42, maxLoopLen: 15, braidChance: 0.5,
    });
    console.log(`[BSP迷宫] 房间:${maze.stats.leaves} 大厅:${maze.stats.halls} ` +
      `环形回路:${maze.stats.loops} 死角编织:${maze.stats.braids}`);

    // 出生点：任意房间；出口：BFS 最远房间（先选房、后建场景）
    const spawn = maze.rooms[Math.floor(Math.random() * maze.rooms.length)];
    spawn.spawn = true;
    const dists = MZ.bfsDistances(maze.grid, spawn.cx, spawn.cy);
    maze.rooms.forEach(r => { r.bfs = dists[r.cy * maze.W + r.cx]; });
    const byDist = maze.rooms.filter(r => !r.spawn && r.bfs >= 0).sort((a, b) => b.bfs - a.bfs);
    const exitRoom = byDist[0] || maze.rooms.find(r => !r.spawn);
    exitRoom.isExit = true;
    // 重排：把出口房间放到最后，供 World._buildExit 识别
    maze.rooms.splice(maze.rooms.indexOf(exitRoom), 1);
    maze.rooms.push(exitRoom);
    // 怪物出生：路径距离约为全程 55% 与 30% 的房间
    const pickAt = (frac) => {
      const target = byDist[0] ? byDist[0].bfs * frac : 10;
      let best = byDist[0], bd = Infinity;
      for (const r of byDist) {
        const d = Math.abs(r.bfs - target);
        if (d < bd) { bd = d; best = r; }
      }
      return best || spawn;
    };
    const hRoom = pickAt(0.55), sRoom = pickAt(0.3);

    Game.world = new World(scene, maze, Game.quality);
    Game.player = Game.player || new Player(camera, Game.world);
    Game.player.world = Game.world;
    if (!Game.player.holder.parent) scene.add(Game.player.holder);
    scene.add(Game.player.flashlight, Game.player.flTarget, Game.player.glow);
    Game.player.flashlight.castShadow = Game.quality.shadows;

    Game.player.reset(Game.world.toWX(spawn.cx), Game.world.toWZ(spawn.cy));
    Game.humanoid = new Humanoid(scene, Game.world);
    Game.humanoid.reset(Game.world.toWX(hRoom.cx), Game.world.toWZ(hRoom.cy));
    Game.smiler = new Smiler(scene, Game.world);
    Game.smiler.reset(Game.world.toWX(sRoom.cx), Game.world.toWZ(sRoom.cy));

    // 理智 / 观战 / 幻觉 清理
    for (const h of Game.hallucinations) disposeGroup(h.e.group);
    Game.hallucinations.length = 0;
    if (Game.shadowSelf) { disposeGroup(Game.shadowSelf.group); Game.shadowSelf = null; }
    Game.spectate = false; Game.ghost = null; Game.spec = null;
    Game.san = 100;
    Game._sanFlags = { m75: false, m50: false, m25: false };

    Game.time = 0; Game.bottles = 0; Game._introStep = 0; Game._introT = 0;
    Game._attacker = null;
    Game._danger = 0;
    Game._directorT = 12;
    UI.setBottles(0, Game.world.bottleTotal);
    UI.setObjective('寻找出口');
    UI.setDarkness(0);
    UI.setSan(100);
    UI.showSpectate(false);
    UI.hud().classList.remove('hidden');
    console.log(`[出生] 房间(${spawn.cx},${spawn.cy}) → 出口 BFS 距离 ${exitRoom.bfs} 格`);
  };

  Game.attacker = function (name) { Game._attacker = name; };

  // ---------- 状态切换 ----------
  Game.start = function () {
    try {
      SFX.init();
      Game.quality.shadows = document.getElementById('optShadows').checked;
      Game.settings.friendly = document.getElementById('optFriendly').checked;
      renderer.shadowMap.enabled = Game.quality.shadows;
      Game.newRun();
      Game.state = 'playing';
      Game.player.enabled = true;
      UI.hideScreens();
      Game.player.requestLock();
    } catch (err) {
      console.error(err);
      window.__errors.push('start: ' + (err.stack || err));
      alert('初始化失败：' + err.message);
    }
  };
  Game.pause = function () {
    if (Game.state !== 'playing') return;
    Game.state = 'paused';
    Game.player.enabled = false;
    UI.show('screen-pause');
  };
  Game.resume = function () {
    Game.state = 'playing';
    Game.player.enabled = true;
    UI.hideScreens();
    Game.player.requestLock();
  };
  Game.restart = function () {
    Game.newRun();
    Game.state = 'playing';
    Game.player.enabled = true;
    UI.hideScreens();
    Game.player.requestLock();
  };
  Game.die = function () {
    Game.state = 'dead';
    Game.player.enabled = false;
    SFX.death();
    SFX.setDanger(0); SFX.setWhisper(0); SFX.heartbeat(0);
    UI.setDarkness(0);
    const who = Game._attacker || '后室本身';
    const m = Math.floor(Game.time / 60), s = Math.floor(Game.time % 60);
    UI.setDeath(`${who} 在迷宫深处带走了你。`,
      `存活 ${m}分${s}秒 · 杏仁水 ${Game.bottles}/${Game.world.bottleTotal}`);
    UI.show('screen-dead');
    document.exitPointerLock && document.exitPointerLock();
  };
  Game.win = function () {
    Game.state = 'won';
    Game.player.enabled = false;
    SFX.win();
    SFX.setDanger(0); SFX.setWhisper(0); SFX.heartbeat(0);
    const m = Math.floor(Game.time / 60), s = Math.floor(Game.time % 60);
    UI.setWin(`用时 ${m}分${s}秒 · 杏仁水 ${Game.bottles}/${Game.world.bottleTotal} · 迷宫种子 ${Game.seed || ''}`);
    UI.show('screen-win');
    document.exitPointerLock && document.exitPointerLock();
  };

  // ---------- 理智归零：化身影者，进入观战 ----------
  Game.sanityDeath = function () {
    Game.state = 'spectate';
    Game.spectate = true;
    const P = Game.player;
    P.enabled = false;
    SFX.death();
    SFX.setDanger(0); SFX.setWhisper(0); SFX.heartbeat(0);
    UI.setDarkness(0);
    UI.hud().classList.add('hidden');
    // 玩家化作影者，在倒下之处起身、永远徘徊
    const shadow = new Humanoid(scene, Game.world);
    shadow.reset(P.pos.x, P.pos.z);
    shadow.dormant = 0;
    shadow.speedBonus = 0;
    Game.shadowSelf = shadow;
    // 幽灵假人：站桩不动、对怪物"隐身"、受击无效——供观战时驱动怪物 AI
    Game.ghost = {
      pos: P.pos.clone(),
      sprinting: false, flashOn: false, hidden: true,
      forward: new THREE.Vector3(0, 0, -1),
      get cx() { return Game.world.toCX(this.pos.x); },
      get cy() { return Game.world.toCY(this.pos.z); },
      hurt() {}, knockback() {},
    };
    // 观战相机（复用玩家支架：无碰撞自由飞行）
    Game.spec = {
      pos: new THREE.Vector3(P.pos.x, P.pos.y, P.pos.z),
      yaw: P.yaw, pitch: -0.12, keys: {}, dragging: false,
    };
    UI.showSpectate(true);
    document.exitPointerLock && document.exitPointerLock();
  };

  // ---------- 导演系统：怪物掉队太远时悄悄挪回玩家附近，保证遭遇 ----------
  // maxMeters：超过此距离触发；minCells/maxCells：落点距玩家的曼哈顿格数范围
  function relocateIfFar(mon, maxMeters, minCells, maxCells) {
    const P = Game.player, W = Game.world;
    if (!mon || mon.dormant > 0) return;
    if (mon === Game.humanoid && mon.state === 2) return; // 追击中不挪
    const d = dist2D(mon.pos.x, mon.pos.z, P.pos.x, P.pos.z);
    if (d < maxMeters) return;
    for (let i = 0; i < 15; i++) {
      const r = W.roomNear(P.cx, P.cy, minCells, maxCells);
      const tx = W.toWX(r.cx), tz = W.toWZ(r.cy);
      // 落点不能在玩家视野内（凭空出现穿帮），也不能贴脸
      if (W.los(P.pos.x, P.pos.y, P.pos.z, tx, 1.5, tz)) continue;
      mon.pos.set(tx, 0, tz);
      if (mon.path) { mon.path = null; } // 影者重新选巡逻目标
      return;
    }
  }

  // ---------- 观战：自由飞行相机 ----------
  function updateSpectator(dt) {
    const s = Game.spec; if (!s) return;
    const k = s.keys;
    const spd = ((k.ShiftLeft || k.ShiftRight) ? 14 : 6.5) * dt;
    let mx = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
    let mz = (k.KeyS ? 1 : 0) - (k.KeyW ? 1 : 0);
    let my = (k.Space ? 1 : 0) - (k.KeyC ? 1 : 0);
    const cp = Math.cos(s.pitch), sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    const fx = -sy * cp, fy = Math.sin(s.pitch), fz = -cy * cp; // 视线前向（含俯仰）
    const rx = cy, rz = -sy;                                    // 视线右向
    if (mx || mz || my) {
      const l = Math.hypot(mx, mz, my); mx /= l; mz /= l; my /= l;
      s.pos.x += (fx * -mz + rx * mx) * spd;
      s.pos.y += (fy * -mz + my) * spd;
      s.pos.z += (fz * -mz + rz * mx) * spd;
    }
    s.pos.y = clamp(s.pos.y, 0.3, 40);
    const h = Game.player.holder;
    h.position.copy(s.pos);
    h.rotation.y = s.yaw;
    camera.position.set(0, 0, 0);
    camera.rotation.x = s.pitch;
    camera.rotation.y = 0;
    camera.rotation.z = 0;
  }

  function spectateStep(dt, t) {
    updateSpectator(dt);
    Game.world.update(dt, Game.player.holder.position, t);
    // 怪物继续活动：影者搜索一番后回归巡逻，笑靥会漂到你倒下的地方驻留
    Game.humanoid.update(dt, Game.ghost, t);
    Game.smiler.update(dt, Game.ghost, camera, t);
    Game.shadowSelf.update(dt, Game.ghost, t);
    updateHallucinations(dt, t, camera); // 已生成的幻觉继续淡出
    SFX.update(dt);
  }

  // ---------- 幻觉（理智 ≤25）：无 AI / 不移动 / 不攻击 / 无碰撞 ----------
  function spawnHallucination() {
    const P = Game.player;
    const kind = Math.random() < 0.5 ? 'shadow' : 'smiler';
    // 在玩家视野方向 ±70°、5~14m 处尝试放置
    for (let i = 0; i < 10; i++) {
      const ang = P.yaw + (Math.random() - 0.5) * 2.4;
      const d = 5 + Math.random() * 9;
      const x = P.pos.x - Math.sin(ang) * d;
      const z = P.pos.z - Math.cos(ang) * d;
      if (kind === 'shadow') {
        const cx = Game.world.toCX(x), cy = Game.world.toCY(z);
        if (Game.world.maze.grid[cy][cx] === MZ.WALL) continue; // 必须站在开放格
        const e = new Humanoid(scene, Game.world);
        e.reset(x, z);
        e.yaw = Math.atan2(P.pos.x - x, P.pos.z - z); // 面朝玩家
        e.group.traverse(o => {
          if (o.material) { o.material.transparent = true; o.material.opacity = 0; }
        });
        Game.hallucinations.push({ kind, e, age: 0, ttl: 4 + Math.random() * 4, vanish: false, _f: 0 });
        return;
      } else {
        const e = new Smiler(scene, Game.world);
        e.reset(x, z);
        e.fade = 0;
        Game.hallucinations.push({ kind, e, age: 0, ttl: 4 + Math.random() * 4, vanish: false, _f: 0 });
        return;
      }
    }
  }

  function updateHallucinations(dt, t, cam) {
    const P = Game.player;
    const arr = Game.hallucinations;
    for (let i = arr.length - 1; i >= 0; i--) {
      const h = arr[i];
      h.age += dt;
      // 走近即消散
      if (!h.vanish && dist2D(P.pos.x, P.pos.z, h.e.pos.x, h.e.pos.z) < 3) h.vanish = true;
      let fade;
      if (h.vanish) fade = h._f - dt * 3.5;
      else if (h.age < 0.5) fade = h.age / 0.5;
      else if (h.age > h.ttl - 1.2) fade = (h.ttl - h.age) / 1.2;
      else fade = 1;
      if (Game.san <= 25 && Math.random() < 0.1) fade *= 0.3; // 低理智下不稳定闪烁
      h._f = clamp(fade, 0, 1);
      if (h.kind === 'shadow') {
        h.e.group.visible = h._f > 0.01;
        h.e.group.traverse(o => { if (o.material) o.material.opacity = h._f; });
        h.e._animate(dt, 0, t); // 只做待机摇摆/扫视，不产生位移
      } else {
        h.e.group.visible = h._f > 0.01;
        h.e.fade = h._f;
        h.e.updateVisualOnly(t, cam); // 只做涡旋与笑脸朝向
      }
      if ((h.vanish && h._f <= 0) || h.age >= h.ttl) {
        disposeGroup(h.e.group);
        arr.splice(i, 1);
      }
    }
  }

  // ---------- UI 事件 ----------
  document.getElementById('btnStart').addEventListener('click', Game.start);
  document.getElementById('btnResume').addEventListener('click', Game.resume);
  document.getElementById('btnRestart1').addEventListener('click', Game.restart);
  document.getElementById('btnRestart2').addEventListener('click', Game.restart);
  document.getElementById('btnRestart3').addEventListener('click', Game.restart);
  document.getElementById('btnRestart4').addEventListener('click', Game.restart);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP' && Game.state === 'playing') Game.pause();
    if (Game.state === 'spectate' && Game.spec) Game.spec.keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => {
    if (Game.state === 'spectate' && Game.spec) Game.spec.keys[e.code] = false;
  });
  // 观战视角：拖动或指针锁定均可
  document.addEventListener('mousemove', (e) => {
    if (Game.state === 'spectate' && Game.spec &&
        (document.pointerLockElement || Game.spec.dragging)) {
      Game.spec.yaw -= e.movementX * 0.0022;
      Game.spec.pitch = clamp(Game.spec.pitch - e.movementY * 0.0022, -1.5, 1.5);
    }
  });
  canvas.addEventListener('mousedown', () => { if (Game.spec) Game.spec.dragging = true; });
  window.addEventListener('mouseup', () => { if (Game.spec) Game.spec.dragging = false; });
  canvas.addEventListener('click', () => {
    if (Game.state === 'spectate') Game.player.requestLock();
    else if (Game.state === 'playing' && !Game.player._locked) Game.player.requestLock();
  });

  // ---------- 每帧 ----------
  const introMsgs = [
    ['你穿过了现实的缝隙，落入后室。', 3600],
    ['潮湿地毯。嗡鸣的荧光灯。无尽的黄。', 3600],
    ['你的理智正在流逝——杏仁水能稳住它。', 3800],
    ['找到出口。活着离开。', 3200],
  ];

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - Game._last) / 1000 || 0.016);
    Game._last = now;
    if (Game.state !== 'playing' && Game.state !== 'spectate') { renderFrame(); return; }
    try {
      if (Game.state === 'spectate') spectateStep(dt, Game.time += dt);
      else step(dt, Game.time += dt);
      Game._frames++; // 完整跑完一帧（含渲染提交）才计数
    } catch (err) {
      // 首个错误：记录并显示，保持最后一帧画面，避免无声黑屏冻结
      if (!Game._fatal) {
        Game._fatal = true;
        window.__errors.push('tick: ' + (err.stack || err));
        try { UI.msg('运行错误：' + err.message, 'danger', 12000); } catch (_) { }
        console.error(err);
      }
    }
  }

  function step(dt, t) {
    const P = Game.player, W = Game.world;

    // --- 玩家 ---
    P.update(dt);

    // --- 开场台词 ---
    Game._introT += dt;
    if (Game._introStep < introMsgs.length && Game._introT > Game._introStep * 3.8 + 0.5) {
      UI.msg(introMsgs[Game._introStep][0], null, introMsgs[Game._introStep][1]);
      Game._introStep++;
    }

    // --- 理智系统：1 秒 -0.1；75 减速 / 50 心跳 / 25 幻觉 / 0 化身影者 ---
    if (t > 3) Game.san = Math.max(0, Game.san - 0.1 * dt);
    const F = Game._sanFlags;
    if (Game.san <= 75 && !F.m75) { F.m75 = true; UI.msg('脚步越来越沉……（理智 ≤75：移速下降）', 'warn', 3200); }
    if (Game.san <= 50 && !F.m50) { F.m50 = true; UI.msg('你听见了自己的心跳。（理智 ≤50）', 'warn', 3200); }
    if (Game.san <= 25 && !F.m25) { F.m25 = true; UI.msg('墙角的影子在看你。那不是真的……对吗？（理智 ≤25）', 'danger', 3600); }
    // ≤50：随机心跳（越低越频繁）
    if (Game.san <= 50 && Math.random() < dt * (0.35 + (50 - Game.san) / 50 * 0.65)) SFX.heartPulse();
    // ≤25：随机生成幻觉（无 AI、不移动、不攻击、无碰撞）
    if (Game.san <= 25 && Game.hallucinations.length < 3 && Math.random() < dt * 0.5) spawnHallucination();
    updateHallucinations(dt, t, camera);
    if (Game.san <= 0) { Game.sanityDeath(); return; }

    // --- 世界与怪物 ---
    W.update(dt, P.pos, t);
    const aggression = Math.min(0.9, Game.bottles * 0.14 + t / 150 * 0.35);
    Game.humanoid.speedBonus = aggression;
    Game.smiler.speedBonus = aggression * 0.5;
    Game.humanoid.update(dt, P, t);
    const sm = Game.smiler.update(dt, P, camera, t);

    // --- 导演系统：影者/笑靥离得太久太远就回到附近 ---
    Game._directorT -= dt;
    if (Game._directorT <= 0) {
      Game._directorT = 9;
      relocateIfFar(Game.humanoid, 38, 3, 7);
      relocateIfFar(Game.smiler, 30, 3, 6);
    }

    // --- 死亡判定 ---
    if (P.health <= 0) { Game.die(); return; }

    // --- 杏仁水拾取 ---
    for (const b of W.bottles) {
      if (b.taken) continue;
      if (dist2D(P.pos.x, P.pos.z, b.x, b.z) < 0.95) {
        b.taken = true; b.g.visible = false;
        Game.bottles++;
        P.stamina = Math.min(100, P.stamina + 45);
        P.health = Math.min(100, P.health + 25);
        Game.san = Math.min(100, Game.san + 40);
        SFX.pickup();
        UI.setBottles(Game.bottles, W.bottleTotal);
        UI.msg('杏仁水：理智 +40，体力与生命恢复。它们察觉到了……', 'warn', 2800);
      }
    }

    // --- 出口发现与胜利 ---
    const ex = W.exit;
    const exd = dist2D(P.pos.x, P.pos.z, ex.trigger.x, ex.trigger.z);
    if (!ex.discovered) {
      const dd = dist2D(P.pos.x, P.pos.z, ex.pos.x, ex.pos.z);
      if (dd < 22 && W.los(P.pos.x, P.pos.y, P.pos.z, ex.pos.x, 1.5, ex.pos.z)) {
        ex.discovered = true;
        UI.msg('远处透出绿光——是出口！', null, 3600);
        UI.setObjective('循着绿光前进');
      }
    }
    if (exd < 1.4) { Game.win(); return; }

    // --- 音频氛围 ---
    const hd = dist2D(P.pos.x, P.pos.z, Game.humanoid.pos.x, Game.humanoid.pos.z);
    const chasing = Game.humanoid.state === 2; // CHASE
    const danger = chasing ? clamp(1 - hd / 26, 0.15, 1) : clamp(1 - hd / 12, 0, 0.4) * 0.5;
    Game._danger = Math.max(danger, Game._danger - dt * 0.3);
    SFX.setDanger(Game._danger);
    SFX.heartbeat(chasing ? clamp(1 - hd / 20, 0.1, 1) : 0);
    // 笑靥接近度（低语音量），直接由距离计算
    const whisper = clamp(1 - sm.d / 14, 0, 1);
    SFX.setWhisper(clamp(whisper * (sm.hasLos ? 1 : 0.55), 0, 1) * (sm.lit ? 0.5 : 1));
    SFX.update(dt);

    // --- HUD ---
    UI.setStamina(P.stamina, P.exhausted);
    UI.setHealth(P.health);
    UI.setSan(Game.san);
    UI.setTimer(t);
    UI.setDarkness(clamp(1 - sm.d / 4.5, 0, 0.9));

    renderFrame();
  }
  requestAnimationFrame(tick);

  // 菜单阶段也持续渲染一帧背景（黑屏即可，等开始后才有场景）
  Game._last = performance.now();
})();
