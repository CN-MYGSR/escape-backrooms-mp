/* ============ 联机对局核心：回合状态机 / 房主演算 / 快照插值 ============
 * 同步模型（已声明）：state-sync
 *  - 各客户端权威自身位置（本地模拟），15Hz sendRealtime 上报 {t:'p'}
 *  - 房主校验事件（逃脱/抓捕/拾取）并广播可靠事件
 *  - 房主 20Hz sendRealtime 广播快照 {t:'snap'}（含 AI 怪物状态）
 *  - 远端实体用 120ms 手动插值缓冲平滑（角度环绕需自处理，不用 room.sync）
 * 状态可丢（p/snap）走 sendRealtime；事件不可丢（start/hit/…）走 send。
 */
(function () {
  const { clamp, dist2D } = U;
  const INTERP_MS = 120;

  // ---------- 插值缓冲 ----------
  class Buf {
    constructor() { this.s = []; }
    push(t, x, z, yaw, spd) {
      const s = this.s;
      s.push({ t, x, z, yaw, spd });
      if (s.length > 24) s.shift();
    }
    at(rt) {
      const s = this.s;
      if (!s.length) return null;
      if (rt <= s[0].t) return s[0];
      for (let i = s.length - 1; i >= 1; i--) {
        if (s[i - 1].t <= rt && rt <= s[i].t) {
          const a = s[i - 1], b = s[i];
          const k = (rt - a.t) / Math.max(1e-3, b.t - a.t);
          let dy = b.yaw - a.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + dy * k, spd: b.spd };
        }
      }
      return s[s.length - 1];
    }
    clear() { this.s.length = 0; }
  }

  const Game = {
    phase: 'idle',       // idle | room | countdown | playing | ended
    settings: { friendly: false, shadows: true, timid: false },
    san: 100, time: 0, bottles: 0,
    roster: [],          // [{id, name, ready, shadow, reason, order, catches}]
    solo: false,         // 本地练习（无房间）
    chatOpen: false,     // 聊天输入中（屏蔽移动/视角/游戏键）
    round: null,
    _flags: {},
    hallucinations: [],
  };
  window.Game = Game;

  Game.lobby = { count: () => Game.roster.length };

  // ---------- 由 main.js 注入 ----------
  Game.gl = null; // {scene, camera, renderFrame, disposeAll}
  Game.player = null;

  function myId() { return Net.myId(); }
  function myIdx() { return Game.roster.findIndex((r) => r.id === myId()); }
  function isHost() { return Net.isHost(); }
  function broadcast(msg) {           // 房主：发给所有人，并在本地应用同一事件
    if (!Game.solo) Net.send(msg);
    handleMsg(msg, myId());
  }
  function sendEvent(msg) {           // 客户端→房主的申报
    if (Game.solo) handleMsg(msg, myId());
    else Net.send(msg);
  }

  // 聊天：可靠消息直发全房间（低频事件，无需房主中继）
  Game.sendChat = function (text) {
    text = String(text || '').trim().slice(0, 80);
    if (!text) return;
    if (!Game.solo) Net.send({ t: 'chat', text });
    UI.addChat(Game.myName || '我', text);
  };

  // ---------- 房间与大厅 ----------
  Game.enterRoom = function (roomId, solo) {
    Game.solo = !!solo;
    Game.roomId = roomId;
    Game.roster = [{
      id: myId(), name: Game.myName, ready: Game.solo, shadow: false, order: 0, catches: 0,
    }];
    Game.phase = 'room';
    UI.show('screen-room');
    UI.setRoomCode(solo ? '（本地练习）' : roomId);
    Game._refreshPlayerList();
    if (solo) {
      UI.msg('本地练习模式： Esc 之外的一切照常，只是没有其他玩家。', null, 4000);
    }
  };

  Game._refreshPlayerList = function () {
    const box = document.getElementById('playerList');
    box.innerHTML = Game.roster.map((r, i) => {
      const me = r.id === myId();
      const host = i === 0 ? ' · 房主' : '';
      return `<div class="pline"><span>${escapeHtml(r.name)}${host}${me ? '（你）' : ''}</span>` +
        `<span class="${r.ready ? 'rdy' : 'wt'}">${r.ready ? '已准备' : '未准备'}</span></div>`;
    }).join('');
    const startBtn = document.getElementById('btnStartRound');
    startBtn.classList.toggle('hidden', !(isHost() || Game.solo));
    startBtn.disabled = Game.roster.length < 1;
    startBtn.textContent = Game.solo || Game.roster.length === 1 ? '开始（单人练习）' : '开 始 对 局';
  };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  Game.toggleReady = function () {
    const me = Game.roster.find((r) => r.id === myId());
    if (me) me.ready = !me.ready;
    if (!Game.solo && isHost()) Game._broadcastRoster();
    else if (!Game.solo) Net.send({ t: 'ready', v: me && me.ready });
    Game._refreshPlayerList();
  };
  Game._broadcastRoster = function () {
    if (Game.solo) { Game._refreshPlayerList(); return; }
    broadcast({ t: 'roster', roster: Game.roster });
  };

  Game.leaveRoom = function () {
    Game.endRoundLocal();
    Net.leave();
    Game.phase = 'idle';
    Game.roster = [];
    UI.show('screen-lobby');
  };

  // ---------- 开局（房主触发，全员执行）----------
  Game.startRound = function () {
    if (!(isHost() || Game.solo)) return;
    const seed = (Date.now() ^ (Math.random() * 0xfffff)) >>> 0;
    const spawnIdx = Math.floor(Math.random() * 10000); // beginRound 内取模房间数
    const payload = {
      t: 'start', seed, spawnIdx,
      roster: Game.roster.map((r) => ({ ...r, shadow: false, order: 0, catches: 0 })),
    };
    broadcast(payload);
  };

  Game.beginRound = function (seed, spawnIdx, roster) {
    Game.endRoundLocal();
    Game.roster = roster;
    Game.round = { seed };
    Game.time = 0; Game.bottles = 0; Game.san = 100;
    Game._flags = {};
    Game.hallucinations = [];

    const gl = Game.gl;
    const maze = MZ.generate(seed, {
      W: 63, H: 63, maxLeaf: 9, hallChance: 0.26,
      loopFactor: 0.42, maxLoopLen: 15, braidChance: 0.5,
    });
    // 出生/出口：与单机版相同的确定性推导
    const spawn = maze.rooms[spawnIdx % maze.rooms.length];
    spawn.spawn = true;
    const dists = MZ.bfsDistances(maze.grid, spawn.cx, spawn.cy);
    maze.rooms.forEach((r) => { r.bfs = dists[r.cy * maze.W + r.cx]; });
    const byDist = maze.rooms.filter((r) => !r.spawn && r.bfs >= 0).sort((a, b) => b.bfs - a.bfs);
    const exitRoom = byDist[0] || maze.rooms.find((r) => !r.spawn);
    exitRoom.isExit = true;
    maze.rooms.splice(maze.rooms.indexOf(exitRoom), 1);
    maze.rooms.push(exitRoom);
    const pickAt = (frac) => {
      const target = byDist[0] ? byDist[0].bfs * frac : 10;
      let best = byDist[0], bd = Infinity;
      for (const r of byDist) {
        const d = Math.abs(r.bfs - target);
        if (d < bd) { bd = d; best = r; }
      }
      return best || spawn;
    };

    Game.maze = maze;
    Game.world = new World(gl.scene, maze, (seed ^ 0x5bf03635) >>> 0, Game.settings);
    Game.player.world = Game.world;
    Game.player.flashlight.castShadow = Game.settings.shadows;

    Game.player.reset(Game.world.toWX(spawn.cx), Game.world.toWZ(spawn.cy));

    // AI 怪物（房主：演算；其他：远端视觉）
    Game.humanoid = new Humanoid(gl.scene, Game.world);
    Game.humanoid.reset(Game.world.toWX(pickAt(0.55).cx), Game.world.toWZ(pickAt(0.55).cy));
    Game.smiler = new Smiler(gl.scene, Game.world);
    Game.smiler.reset(Game.world.toWX(pickAt(0.3).cx), Game.world.toWZ(pickAt(0.3).cy));
    if (isHost() || Game.solo) {
      Game.humanoid.onHit = (id, dmg, kx, kz) =>
        broadcast({ t: 'hit', target: id, dmg, kx: +kx.toFixed(2), kz: +kz.toFixed(2) });
      Game.smiler.onHit = (id, dps) => broadcast({ t: 'hit', target: id, dmg: +dps.toFixed(2) });
    }

    // 远端化身 + 插值缓冲
    Game.avatars = new Map(); // idx -> Avatar
    Game.bufs = new Map();    // idx -> Buf
    Game.bufH = new Buf(); Game.bufS = new Buf();
    Game.roster.forEach((r, i) => {
      if (r.id === myId()) return;
      Game.avatars.set(i, new Avatar(gl.scene, r.name, i));
      Game.bufs.set(i, new Buf());
    });
    Game._netPos = new Map(); // 房主：idx -> {x,z,yaw,spd,f,sp,t}

    Game.phase = 'countdown';
    Game._countT = 3.2;
    Game.player.enabled = false;
    UI.hud().classList.remove('hidden');
    UI.show(null);
    UI.setObjective('准备…');
    UI.setBottles(0, Game.world.bottleTotal);
    UI.setSan(100);
    UI.setBattery(100);
    UI.setShadowMode(false);
    UI.setDarkness(0);
    console.log(`[对局开始] seed=${seed} 玩家=${roster.length} 我=房主:${isHost() || Game.solo}`);
  };

  // ---------- 回合本地清理 ----------
  Game.endRoundLocal = function () {
    const gl = Game.gl;
    if (Game.world) { Game.world.dispose(gl.scene); Game.world = null; }
    if (Game.humanoid) { disposeGroup(gl.scene, Game.humanoid.group); Game.humanoid = null; }
    if (Game.smiler) { disposeGroup(gl.scene, Game.smiler.group); Game.smiler = null; }
    if (Game.avatars) { Game.avatars.forEach((a) => a.dispose(gl.scene)); Game.avatars = null; }
    for (const h of Game.hallucinations) disposeGroup(gl.scene, h.e.group);
    Game.hallucinations = [];
    if (Game.player) Game.player.enabled = false;
  };
  function disposeGroup(scene, g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    scene.remove(g);
  }

  // ---------- 每帧 ----------
  Game.tick = function (dt, tNow) {
    if (Game.phase === 'countdown') {
      const prev = Math.ceil(Game._countT);
      Game._countT -= dt;
      const now = Math.ceil(Game._countT);
      if (now !== prev && now > 0) UI.msg(String(now), null, 800);
      if (Game._countT <= 0) {
        Game.phase = 'playing';
        Game.player.enabled = true;
        UI.msg('开始！', null, 1200);
        SFX.buzzFlicker();
      }
    }
    if (Game.phase !== 'playing') {
      if (Game.world) Game.world.update(dt, Game.player.pos, Game.time);
      return;
    }
    Game._step(dt, tNow);
  };

  Game._step = function (dt, tNow) {
    const P = Game.player, W = Game.world;
    const t = Game.time += dt;
    P.update(dt);
    const me = Game.roster[myIdx()];
    const iAmShadow = P.isShadow;

    // ---- 本地理智（仅人类）----
    if (!iAmShadow) {
      if (t > 3) Game.san = Math.max(0, Game.san - 0.1 * dt);
      const F = Game._flags;
      if (Game.san <= 75 && !F.m75) { F.m75 = true; UI.msg('脚步越来越沉……（理智 ≤75：移速下降）', 'warn', 3000); }
      if (Game.san <= 50 && !F.m50) { F.m50 = true; UI.msg('你听见了自己的心跳。（理智 ≤50）', 'warn', 3000); }
      if (Game.san <= 25 && !F.m25) { F.m25 = true; UI.msg('墙角的影子在看你。（理智 ≤25：幻觉出现）', 'danger', 3200); }
      if (Game.san <= 50 && Math.random() < dt * (0.35 + (50 - Game.san) / 50 * 0.65)) SFX.heartPulse();
      if (Game.san <= 25 && Game.hallucinations.length < 3 && Math.random() < dt * 0.5) _spawnHallucination();
      if (Game.san <= 0 && !F.sanZero) { F.sanZero = true; sendEvent({ t: 'sanZero' }); }
      if (P.health <= 0 && !F.died) { F.died = true; sendEvent({ t: 'died' }); }
    }
    _updateHallucinations(dt, t);

    // ---- 本地申报（人类：出口/杏仁水；影者：抓捕）----
    if (!iAmShadow) {
      const ex = W.exit;
      if (!Game._flags.escaped && dist2D(P.pos.x, P.pos.z, ex.trigger.x, ex.trigger.z) < 1.4) {
        Game._flags.escaped = true;
        sendEvent({ t: 'escaped' });
      }
      Game._pickT = (Game._pickT || 0) - dt;
      if (Game._pickT <= 0) {
        const hasSpace = P.slots[1] === null || P.slots[2] === null;
        const tryPick = (arr, k, label) => {
          arr.forEach((b, idx) => {
            if (b.taken || dist2D(P.pos.x, P.pos.z, b.x, b.z) >= 0.95) return;
            if (!hasSpace) {
              Game._pickT = 3;
              UI.msg('物品栏已满，先按 E 用掉一件。', 'warn', 2200);
              return;
            }
            Game._pickT = 0.4;
            sendEvent({ t: 'pickup', idx, k });
          });
        };
        tryPick(W.bottles, 0);
        tryPick(W.batteries, 1);
      }
    } else {
      // 影者：靠近人类（用插值位置）→ 申报抓捕
      Game._catchT = (Game._catchT || 0) - dt;
      if (Game._catchT <= 0) {
        Game.roster.forEach((r, i) => {
          if (r.shadow || r.id === myId()) return;
          const st = Game.bufs.get(i) && Game.bufs.get(i).at(tNow - INTERP_MS);
          if (st && dist2D(P.pos.x, P.pos.z, st.x, st.z) < 1.3) {
            Game._catchT = 0.7;
            sendEvent({ t: 'catch', target: r.id });
          }
        });
      }
    }

    // ---- 位置上报（15Hz，可丢）----
    Game._sendT = (Game._sendT || 0) - dt;
    if (Game._sendT <= 0 && !Game.solo) {
      Game._sendT = 1 / 15;
      Net.sendRT({
        t: 'p', i: myIdx(),
        x: +P.pos.x.toFixed(2), z: +P.pos.z.toFixed(2),
        y: +P.yaw.toFixed(3), s: +P.speed.toFixed(1),
        f: P.flashOn ? 1 : 0, sp: P.sprinting ? 1 : 0,
      });
    }

    // ---- 房主演算 ----
    if (isHost() || Game.solo) _hostSim(dt, t, tNow);

    // ---- 远端实体应用（含房主自己的远端玩家）----
    const rt = tNow - INTERP_MS;
    Game.roster.forEach((r, i) => {
      if (r.id === myId()) return;
      const buf = Game.bufs.get(i);
      const av = Game.avatars.get(i);
      if (!buf || !av) return;
      const st = buf.at(rt);
      if (st) {
        av.applyState(st.x, st.z, st.yaw, st.spd, r.shadow);
        av.setGlow(iAmShadow && !r.shadow);
        av.update(dt, Game.player.pos);
      }
    });
    // 房主/单机：pos 即权威演算结果，不能再被 120ms 前的插值快照回写
    // （否则每帧被拽回过去，实际移速跌到约 1/7）
    if (!(isHost() || Game.solo)) {
      const hSt = Game.bufH.at(rt);
      if (hSt) { Game.humanoid.applyNet(hSt.x, hSt.z, hSt.yaw, hSt.spd); }
      const sSt = Game.bufS.at(rt);
      if (sSt) { Game.smiler.applyNet(sSt.x, sSt.z); }
    }
    if (!(isHost() || Game.solo)) {
      Game.humanoid.updateRemote(dt, t);
      Game.smiler.updateRemote(dt, Game.gl.camera);
    }

    // ---- 世界/HUD/氛围 ----
    W.update(dt, P.pos, t);
    // 联网路径指示（SDK 内置诊断：直连/中继/恢复中 + 已连接人数）
    if (Net.room && !Game.solo) {
      Game._netUiT = (Game._netUiT || 0) - dt;
      if (Game._netUiT <= 0) {
        Game._netUiT = 0.5;
        try {
          const ns = Net.room.networkStats();
          const open = Net.room.peers().filter((p) => p.open).length;
          const label = { direct: '直连', mixed: '直连+中继', relay: '中继', recovering: '恢复中' }[ns.state] || ns.state;
          UI.setNet(open > 0 ? `${label} · ${open}人` : '等待连接…', ns.state === 'direct' || ns.state === 'mixed');
        } catch (_) { /* 诊断不可用时保持上次显示 */ }
      }
    }
    UI.setStamina(P.stamina, P.exhausted);
    UI.setHealth(P.health);
    UI.setSan(Game.san);
    UI.setBattery(P.isShadow ? 100 : P.battery);
    UI.setSlots(P.slots, P.selSlot, P.isShadow ? 100 : P.battery);
    UI.setTimer(t);
    UI.setObjective(iAmShadow
      ? `猎杀剩余人类（${Game.roster.filter((r) => !r.shadow).length} 人）`
      : '找到出口并穿过它');
    UI.setAliveList(Game.roster.map((r, i) => ({
      name: r.name, shadow: r.shadow, me: r.id === myId(),
    })));
    UI.setDarkness(clamp(1 - dist2D(P.pos.x, P.pos.z, Game.smiler.pos.x, Game.smiler.pos.z) / 4.5, 0, 0.9));
    SFX.update(dt);
  };

  // ---------- 房主演算 ----------
  function _hostSim(dt, t, tNow) {
    const P = Game.player;
    // 最近的人类（含自己）
    let target = null, td = Infinity;
    Game.roster.forEach((r, i) => {
      if (r.shadow) return;
      let x, z, yaw, f, sp;
      if (r.id === myId()) { x = P.pos.x; z = P.pos.z; yaw = P.yaw; f = P.flashOn; sp = P.sprinting; }
      else {
        const np = Game._netPos.get(i);
        if (!np || tNow - np.t > 3000) return; // 超时无数据不作为目标
        x = np.x; z = np.z; yaw = np.yaw; f = !!np.f; sp = !!np.sp;
      }
      const d = dist2D(Game.humanoid.pos.x, Game.humanoid.pos.z, x, z);
      if (d < td) {
        td = d;
        target = {
          id: r.id, x, z, yaw, f, sp,
          pos: new THREE.Vector3(x, 1.62, z),
          get cx() { return Game.world.toCX(this.x); },
          get cy() { return Game.world.toCY(this.z); },
          get forward() { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); },
          flashOn: f, sprinting: sp,
        };
      }
    });
    if (target) {
      const aggr = Math.min(0.9, Game.bottles * 0.14 + t / 150 * 0.35);
      Game.humanoid.speedBonus = aggr;
      Game.smiler.speedBonus = aggr * 0.5;
      Game.humanoid.updateHost(dt, target, t);
      Game.smiler.updateHost(dt, target, Game.gl.camera, t);
      // 房主把 AI 状态写进自己的缓冲（统一插值路径）
      Game.bufH.push(tNow, Game.humanoid.pos.x, Game.humanoid.pos.z, Game.humanoid.yaw,
        Game.humanoid.curSpeed || 0);
      Game.bufS.push(tNow, Game.smiler.pos.x, Game.smiler.pos.z, 0, 0);
    }

    // 20Hz 快照广播
    Game._snapT = (Game._snapT || 0) - dt;
    if (Game._snapT <= 0 && !Game.solo) {
      Game._snapT = 1 / 20;
      const ps = Game.roster.map((r, i) => {
        if (r.id === myId())
          return [i, +P.pos.x.toFixed(2), +P.pos.z.toFixed(2), +P.yaw.toFixed(3), +P.speed.toFixed(1), P.isShadow ? 1 : 0];
        const np = Game._netPos.get(i);
        if (!np) return [i, 0, 0, 0, 0, r.shadow ? 1 : 0];
        return [i, np.x, np.z, np.yaw, np.spd, r.shadow ? 1 : 0];
      });
      Net.sendRT({
        t: 'snap', ps,
        h: [+Game.humanoid.pos.x.toFixed(2), +Game.humanoid.pos.z.toFixed(2),
            +Game.humanoid.yaw.toFixed(3), +(Game.humanoid.curSpeed || 0).toFixed(1)],
        s: [+Game.smiler.pos.x.toFixed(2), +Game.smiler.pos.z.toFixed(2)],
      });
    }

    // 回合结束判定
    if (Game.roster.length > 0 && Game.roster.every((r) => r.shadow)) {
      _endRound();
    }
  }

  // ---------- 结算 ----------
  function _endRound() {
    const results = Game.roster.map((r) => ({
      name: r.name, id: r.id, reason: r.reason || 'escape',
      order: r.order, catches: r.catches || 0,
    }));
    broadcast({ t: 'roundEnd', results });
  }

  Game._showResults = function (results) {
    Game.phase = 'ended';
    Game.player.enabled = false;
    UI.hud().classList.add('hidden');
    const orderName = { escape: '逃脱', caught: '被抓', sanity: '理智归零', died: '倒下' };
    const sorted = [...results].sort((a, b) => (a.order - b.order) || (b.catches - a.catches));
    document.getElementById('resultBody').innerHTML = sorted.map((r, i) => {
      const me = r.id === myId();
      return `<div>${i + 1}. ${escapeHtml(r.name)}${me ? '（你）' : ''} — ` +
        `${r.order > 0 ? `第 ${r.order} 个逃出` : orderName[r.reason] || '影者'}` +
        `${r.catches ? ` · 抓捕 ×${r.catches}` : ''}</div>`;
    }).join('');
    document.getElementById('btnAgain').classList.toggle('hidden', !(isHost() || Game.solo));
    UI.show('screen-result');
    SFX.win();

    // 个人累计战绩 → vibe.save（只写自己的）
    const me = results.find((r) => r.id === myId());
    if (me && Net.save()) {
      Net.save().get('stats').then((old) => {
        const s = old || { v: 1, rounds: 0, escapes: 0, firsts: 0, catches: 0 };
        s.rounds++;
        if (me.reason === 'escape') s.escapes++;
        if (me.order === 1) s.firsts++;
        s.catches += me.catches || 0;
        Net.save().set('stats', s);
      }).catch(() => { });
    }
    // 每局结果 → room.data（房主写）
    if ((isHost() || Game.solo) && Net.room && Net.room.data) {
      Net.room.data.set('r' + Date.now(), results).catch(() => { });
    }
  };

  Game.backToRoom = function () {
    Game.endRoundLocal();
    Game.roster.forEach((r) => { r.shadow = false; r.order = 0; r.catches = 0; r.ready = false; });
    Game.phase = 'room';
    UI.show('screen-room');
    if (isHost() || Game.solo) Game._broadcastRoster();
  };

  // ---------- 消息处理（房主与客户端共用）----------
  function handleMsg(msg, fromId) {
    switch (msg.t) {
      case 'roster': {
        Game.roster = msg.roster;
        if (Game.phase === 'room') Game._refreshPlayerList();
        // 对局中新名字（后加入者）暂不进入当前回合
        break;
      }
      case 'start': {
        Game.beginRound(msg.seed, msg.spawnIdx, msg.roster);
        break;
      }
      case 'p': { // 仅房主处理
        if (isHost() && !Game.solo) {
          Game._netPos.set(msg.i, { x: msg.x, z: msg.z, yaw: msg.y, spd: msg.s, f: msg.f, sp: msg.sp, t: performance.now() });
        }
        break;
      }
      case 'snap': { // 仅非房主处理
        if (!(isHost() || Game.solo)) {
          const now = performance.now();
          for (const row of msg.ps) {
            const [i, x, z, yaw, spd, sh] = row;
            if (i === myIdx()) continue;
            const buf = Game.bufs.get(i);
            if (buf) buf.push(now, x, z, yaw, spd);
            const r = Game.roster[i];
            if (r) r.shadow = !!sh;
          }
          if (msg.h) Game.bufH.push(now, msg.h[0], msg.h[1], msg.h[2], msg.h[3] || 0);
          if (msg.s) Game.bufS.push(now, msg.s[0], msg.s[1], 0, 0);
        }
        break;
      }
      case 'escaped': { // 房主校验
        if (!(isHost() || Game.solo)) break;
        const r = Game.roster.find((x) => x.id === fromId);
        if (!r || r.shadow) break;
        if (Game.solo || _posNearExit(fromId)) {
          const order = Game.roster.filter((x) => x.shadow).length + 1;
          broadcast({ t: 'becomeShadow', id: fromId, reason: 'escape', order });
        }
        break;
      }
      case 'catch': { // 房主校验
        if (!(isHost() || Game.solo)) break;
        const catcher = Game.roster.find((x) => x.id === fromId);
        const victim = Game.roster.find((x) => x.id === msg.target);
        if (!catcher || !catcher.shadow || !victim || victim.shadow) break;
        if (Game.solo || _distBetween(fromId, msg.target) < 3.2) {
          catcher.catches = (catcher.catches || 0) + 1;
          broadcast({ t: 'becomeShadow', id: msg.target, reason: 'caught', by: catcher.name });
          if (isHost()) Game._broadcastRoster();
        }
        break;
      }
      case 'sanZero':
      case 'died': {
        if (!(isHost() || Game.solo)) break;
        const r = Game.roster.find((x) => x.id === fromId);
        if (!r || r.shadow) break;
        broadcast({ t: 'becomeShadow', id: fromId, reason: msg.t === 'sanZero' ? 'sanity' : 'died' });
        break;
      }
      case 'becomeShadow': {
        const r = Game.roster.find((x) => x.id === msg.id);
        if (!r || r.shadow) break;
        r.shadow = true; r.reason = msg.reason; r.order = msg.order || 0;
        if (msg.id === myId()) {
          Game.player.becomeShadow();
          Game.san = Math.max(Game.san, 40); // 化影者后理智稳定
          UI.setShadowMode(true);
          SFX.sting();
          UI.msg(msg.reason === 'escape'
            ? `你第 ${msg.order} 个穿过出口——升格为影者！`
            : (msg.reason === 'caught' ? `被 ${msg.by} 抓住——你加入了影者。`
              : '你化作了影者。'), 'danger', 4200);
          UI.setObjective('猎杀剩余人类');
        } else {
          UI.msg(`${r.name} ${msg.reason === 'escape' ? '逃出了后室，成为影者' : '化作了影者'}`,
            msg.reason === 'escape' ? 'warn' : null, 3000);
        }
        if (isHost() || Game.solo) Game._broadcastRoster();
        break;
      }
      case 'hit': {
        if (msg.target === myId()) {
          const fatal = !Game.player.isShadow && msg.dmg >= Game.player.health;
          Game.player.hurt(msg.dmg, msg.dmg < 5); // 持续伤害(黑雾)静默
          if (msg.kx !== undefined && msg.kx !== null) Game.player.knockback(msg.kx, msg.kz, 9);
          if (fatal && Game.phase === 'playing') {
            // 被怪物杀死：跳脸惊吓（有击退坐标=影者，否则=笑靥；胆小模式关闭）
            Game._jumpscare(msg.kx !== undefined && msg.kx !== null ? 'shadow' : 'smiler');
          }
        }
        break;
      }
      case 'pickup': { // 房主校验（k: 0=杏仁水 1=电池）
        if (!(isHost() || Game.solo)) break;
        const arr = msg.k === 1 ? Game.world && Game.world.batteries : Game.world && Game.world.bottles;
        const b = arr && arr[msg.idx];
        const p = _latestPos(fromId);
        const posOk = Game.solo || (p && b && dist2D(p.x, p.z, b.x, b.z) < 2.4);
        if (b && !b.taken && posOk) broadcast({ t: 'picked', idx: msg.idx, k: msg.k || 0, id: fromId });
        break;
      }
      case 'picked': {
        const arr = msg.k === 1 ? Game.world && Game.world.batteries : Game.world && Game.world.bottles;
        const b = arr && arr[msg.idx];
        if (b && !b.taken) {
          b.taken = true; b.g.visible = false;
          if (msg.id === myId()) {
            const P = Game.player;
            const slot = P.slots[1] === null ? 1 : (P.slots[2] === null ? 2 : -1);
            if (slot === -1) {
              // 兜底：两槽已满的罕见竞态 → 直接生效
              if (msg.k === 1) P.battery = Math.min(100, P.battery + 50);
              else {
                P.stamina = Math.min(100, P.stamina + 45);
                P.health = Math.min(100, P.health + 25);
                Game.san = Math.min(100, Game.san + 40);
              }
            } else {
              P.slots[slot] = msg.k === 1 ? { k: 'battery' } : { k: 'water' };
              SFX.pickup();
              UI.msg(msg.k === 1 ? '拾取 电池（2/3 选中 · E 使用）' : '拾取 杏仁水（2/3 选中 · E 使用）', null, 2400);
            }
            if (msg.k !== 1) {
              Game.bottles++;
              UI.setBottles(Game.bottles, Game.world.bottleTotal);
            }
          }
        }
        break;
      }
      case 'chat': {
        const r = Game.roster.find((x) => x.id === fromId);
        UI.addChat(r ? r.name : '玩家', String(msg.text || '').slice(0, 80));
        break;
      }
      case 'roundEnd': {
        if (Game.phase === 'playing' || Game.phase === 'countdown') Game._showResults(msg.results);
        break;
      }
    }
  }
  Game._handleMsg = handleMsg;

  // 房主校验用的最新位置
  function _latestPos(id) {
    if (id === myId()) return { x: Game.player.pos.x, z: Game.player.pos.z };
    const i = Game.roster.findIndex((r) => r.id === id);
    const np = i >= 0 && Game._netPos.get(i);
    return np ? np : null;
  }
  function _posNearExit(id) {
    const p = _latestPos(id);
    if (!p || !Game.world || !Game.world.exit) return false;
    return dist2D(p.x, p.z, Game.world.exit.trigger.x, Game.world.exit.trigger.z) < 4;
  }
  function _distBetween(a, b) {
    const pa = _latestPos(a), pb = _latestPos(b);
    if (!pa || !pb) return Infinity;
    return dist2D(pa.x, pa.z, pb.x, pb.z);
  }
  // ---------- 跳脸惊吓（被怪物杀死时；胆小模式关闭） ----------
  Game._jumpscare = function (kind) {
    if (Game.settings.timid) return;
    const ov = document.getElementById('jumpscare');
    const img = document.getElementById('jumpscareImg');
    if (!ov || !img) return;
    if (kind === 'smiler') {
      // 笑靥：直接复用游戏内的发光笑脸贴图
      img.src = TEX.smilerFace().image.toDataURL();
    } else {
      // 影者：黑暗中的一对冷白细长眼 + 隐约头廓
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, 512, 512);
      const g = x.createRadialGradient(256, 290, 30, 256, 290, 230);
      g.addColorStop(0, 'rgba(34,34,40,0.95)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(0, 0, 512, 512);
      x.shadowColor = '#eef6ff'; x.shadowBlur = 48;
      x.fillStyle = '#f4fbff';
      for (const ex of [176, 336]) {
        x.beginPath();
        x.ellipse(ex, 252, 26, 48, 0, 0, Math.PI * 2);
        x.fill();
      }
      img.src = c.toDataURL();
    }
    // 重置动画（连续触发时重新播放）
    ov.classList.add('hidden');
    void ov.offsetWidth;
    ov.classList.remove('hidden');
    SFX.jumpscare();
    clearTimeout(Game._jsT);
    Game._jsT = setTimeout(() => { ov.classList.add('hidden'); }, 1150);
  };

  // ---------- 低理智幻觉（纯本地视觉）----------
  function _spawnHallucination() {
    const P = Game.player, gl = Game.gl;
    const kind = Math.random() < 0.5 ? 'shadow' : 'smiler';
    for (let i = 0; i < 10; i++) {
      const ang = P.yaw + (Math.random() - 0.5) * 2.4;
      const d = 5 + Math.random() * 9;
      const x = P.pos.x - Math.sin(ang) * d;
      const z = P.pos.z - Math.cos(ang) * d;
      if (kind === 'shadow') {
        const cx = Game.world.toCX(x), cy = Game.world.toCY(z);
        if (Game.maze.grid[cy][cx] === MZ.WALL) continue;
        const e = new Humanoid(gl.scene, Game.world);
        e.reset(x, z);
        e.yaw = Math.atan2(P.pos.x - x, P.pos.z - z);
        e.isHallucination = true;
        e.group.traverse((o) => {
          if (o.material) { o.material.transparent = true; o.material.opacity = 0; }
        });
        Game.hallucinations.push({ kind, e, age: 0, ttl: 4 + Math.random() * 4, vanish: false, _f: 0 });
        return;
      } else {
        const e = new Smiler(gl.scene, Game.world);
        e.reset(x, z);
        e.isHallucination = true;
        e.fade = 0;
        Game.hallucinations.push({ kind, e, age: 0, ttl: 4 + Math.random() * 4, vanish: false, _f: 0 });
        return;
      }
    }
  }
  function _updateHallucinations(dt, t) {
    const P = Game.player, gl = Game.gl;
    for (let i = Game.hallucinations.length - 1; i >= 0; i--) {
      const h = Game.hallucinations[i];
      h.age += dt;
      if (!h.vanish && dist2D(P.pos.x, P.pos.z, h.e.pos.x, h.e.pos.z) < 3) h.vanish = true;
      let fade;
      if (h.vanish) fade = h._f - dt * 3.5;
      else if (h.age < 0.5) fade = h.age / 0.5;
      else if (h.age > h.ttl - 1.2) fade = (h.ttl - h.age) / 1.2;
      else fade = 1;
      if (Game.san <= 25 && Math.random() < 0.1) fade *= 0.3;
      h._f = clamp(fade, 0, 1);
      if (h.kind === 'shadow') {
        h.e.group.visible = h._f > 0.01;
        h.e.group.traverse((o) => { if (o.material) o.material.opacity = h._f; });
        h.e.updateRemote(dt, t);
      } else {
        h.e.group.visible = h._f > 0.01;
        h.e.fade = h._f;
        h.e.updateRemote(dt, gl.camera);
      }
      if ((h.vanish && h._f <= 0) || h.age >= h.ttl) {
        disposeGroup(gl.scene, h.e.group);
        Game.hallucinations.splice(i, 1);
      }
    }
  }

  // ---------- 网络事件（房间层）----------
  // 所有消息类型统一注册到 Net（host 与 client 走同一 handleMsg 分支）
  ['roster', 'start', 'p', 'snap', 'escaped', 'catch', 'sanZero', 'died',
    'becomeShadow', 'hit', 'pickup', 'picked', 'roundEnd', 'hello', 'ready', 'chat']
    .forEach((t) => Net.on(t, (msg, fromId) => handleMsg(msg, fromId)));

  // handleMsg 中补充的房间层消息
  const _baseHandle = handleMsg;
  handleMsg = function (msg, fromId) {
    switch (msg.t) {
      case 'hello': { // 新加入者自我介绍 → 房主收编进花名册
        if (isHost() && !Game.solo) {
          let r = Game.roster.find((x) => x.id === fromId);
          if (!r && Game.roster.length < (Game.maxPlayers || 6)) {
            if (Game.phase === 'playing' || Game.phase === 'countdown') {
              // 对局中进入：先入册但标记旁观，下一局参战
              Game.roster.push({ id: fromId, name: msg.name, ready: false, shadow: true, order: 0, catches: 0, spectate: true });
              UI.msg(`${msg.name} 进入房间（等待下一局）`, null, 3000);
              Net.send({ t: 'roster', roster: Game.roster });
              Net.sendTo({ t: 'waitNext' }, fromId);
            } else {
              Game.roster.push({ id: fromId, name: msg.name, ready: false, shadow: false, order: 0, catches: 0 });
              UI.msg(`${msg.name} 加入了房间`, null, 3000);
              Game._broadcastRoster();
            }
            Net.announceUpdate();
          } else if (r && r.spectate === undefined) {
            r.name = msg.name;
            Game._broadcastRoster();
          }
        }
        break;
      }
      case 'ready': {
        if (isHost() && !Game.solo) {
          const r = Game.roster.find((x) => x.id === fromId);
          if (r) { r.ready = !!msg.v; Game._broadcastRoster(); }
        }
        break;
      }
      case 'waitNext': {
        if (Game.phase === 'room') {
          UI.msg('对局进行中，你将在下一局加入。', 'warn', 5000);
        }
        break;
      }
      default: _baseHandle(msg, fromId);
    }
  };
  // 覆盖统一注册使用的入口
  Game._handleMsg = handleMsg;
  ['roster', 'start', 'p', 'snap', 'escaped', 'catch', 'sanZero', 'died',
    'becomeShadow', 'hit', 'pickup', 'picked', 'roundEnd', 'hello', 'ready', 'waitNext', 'chat']
    .forEach((t) => Net.on(t, (msg, fromId) => handleMsg(msg, fromId)));

  Net.onPeer(function (ev) {
    if (ev.type === 'join') {
      // 新 DataChannel 打开：向房主自我介绍（房主维护花名册）
      if (!isHost()) return;
      // hello 由对方主动发送；此处仅提示
    }
    if (ev.type === 'leave') {
      const r = Game.roster.find((x) => x.id === ev.id);
      if (isHost()) {
        if (r) {
          UI.msg(`${r.name} 离开了房间`, null, 2500);
          if (Game.phase === 'playing' || Game.phase === 'countdown') {
            // 对局中不移动 roster 索引（化身/缓冲按索引绑定），标记掉线
            r.disconnected = true;
          } else {
            Game.roster = Game.roster.filter((x) => x.id !== ev.id);
          }
          Game._broadcastRoster();
          Net.announceUpdate();
        }
      } else if (Net.room && ev.id === Net.room.hostId) {
        UI.msg('房主已离开，对局中断。请返回大厅重新建房。', 'danger', 6000);
        Game.phase = 'room';
        Game.player.enabled = false;
      } else if (r) {
        UI.msg(`${r.name} 掉线了`, 'warn', 2500);
      }
    }
    if (ev.type === 'error') {
      console.warn('[Net] peer error', ev.reason, ev.detail);
    }
  });
})();
