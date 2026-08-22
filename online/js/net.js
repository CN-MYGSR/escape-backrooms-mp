/* ============ 网络层：VibeHub SDK 封装 ============
 * 规范要求：
 *  - 只用 window.VibeHub（禁止自建后端/DB/WebSocket）
 *  - 实时状态走 P2P：sendRealtime（可丢快照）+ send（可靠事件）
 *  - 登录/退出/账号状态 UI 由 onAuthChange 驱动
 *  - 无任何轮询
 */
(function () {
  const DEFAULT_WORK = 'escape-backrooms-mp'; // 发布时按最终项目 slug 调整

  const Net = {
    vibe: null,
    room: null,
    roomId: null,
    ready: false,        // SDK 初始化成功
    online: false,       // SDK 可用且已登录（可联机）
    _handlers: {},
    _peerCbs: [],
    _authCbs: [],
  };
  window.Net = Net;

  // ---------- 初始化 ----------
  Net.init = async function () {
    // ?offline=1：跳过 SDK（本地练习/调试用）
    let forceOffline = false;
    try { forceOffline = new URLSearchParams(location.search).get('offline') === '1'; } catch (_) { }
    // 项目 slug：URL 参数 > localStorage > 默认值（发布后固定）
    let work = DEFAULT_WORK;
    try {
      const u = new URLSearchParams(location.search).get('work');
      if (u) { work = u; localStorage.setItem('vibehub-work', u); }
      else if (localStorage.getItem('vibehub-work')) work = localStorage.getItem('vibehub-work');
    } catch (_) { /* file:// 或隐私模式忽略 */ }
    Net.work = work;

    if (forceOffline || typeof VibeHub === 'undefined') {
      console.warn('[Net] 离线模式（offline=1 或 SDK 未加载）');
      return false;
    }
    try {
      Net.vibe = await VibeHub.init({ work });
      Net.ready = true;
      console.log('[Net] SDK 就绪', VibeHub.version, 'channel=' + VibeHub.channel, 'work=' + work);
      Net.vibe.onAuthChange((user) => {
        Net.online = !!user;
        Net._authCbs.forEach((cb) => { try { cb(user); } catch (e) { console.error(e); } });
      });
      Net.online = Net.vibe.isLoggedIn();
      return true;
    } catch (err) {
      console.warn('[Net] SDK 初始化失败（离线模式）：', err && err.message || err);
      Net.ready = false;
      Net.online = false;
      return false;
    }
  };

  // ---------- 账号 ----------
  Net.login = async function () {
    if (!Net.vibe) return null;
    try { return await Net.vibe.login(); }
    catch (err) { console.warn('[Net] 登录失败：', err && err.message || err); return null; }
  };
  Net.logout = function () { if (Net.vibe) Net.vibe.logout(); };
  Net.onAuth = function (cb) { Net._authCbs.push(cb); };
  Net.save = function () { return Net.vibe ? Net.vibe.save : null; };

  // ---------- 消息路由 ----------
  Net.on = function (t, fn) { Net._handlers[t] = fn; };
  Net.send = function (msg) { if (Net.room) Net.room.send(msg); };                 // 可靠有序：事件
  Net.sendTo = function (msg, peerId) { if (Net.room) Net.room.send(msg, peerId); };
  Net.sendRT = function (msg) { if (Net.room) Net.room.sendRealtime(msg); };       // 可丢：快照/位置

  // ---------- 房间 ----------
  function makeCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  Net._wireRoom = function (room) {
    Net.room = room;
    room.onMessage((msg, fromId) => {
      if (!msg || typeof msg !== 'object') return;
      const h = Net._handlers[msg.t];
      if (h) { try { h(msg, fromId); } catch (e) { console.error('[Net] handler', msg.t, e); } }
    });
    room.onPeer((ev) => {
      Net._peerCbs.forEach((cb) => { try { cb(ev); } catch (e) { console.error(e); } });
    });
  }

  /** 创建房间：返回 {roomId}；失败返回 null */
  Net.createRoom = async function (opts) {
    if (!Net.vibe) return null;
    opts = opts || {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const roomId = makeCode();
      try {
        const room = await Net.vibe.room.join(roomId, {
          topology: 'host',
          sync: { bufferSize: 32, interpDelayMs: 110 },
        });
        Net._wireRoom(room);
        Net.roomId = roomId;
        await room.announce({
          open: true,
          listed: !opts.pass,
          max: opts.max || 4,
          mode: '经典',
          pass: opts.pass || '',
          players: 1,
        });
        return { roomId, room };
      } catch (err) {
        console.warn('[Net] 创建房间重试', err && err.message || err);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return null;
  };

  /** 加入房间；密码不符返回 {error:'pass'} */
  Net.joinRoom = async function (roomId, pass) {
    if (!Net.vibe) return { error: 'offline' };
    roomId = String(roomId || '').trim().toUpperCase();
    try {
      const meta = await Net.vibe.rooms.get(roomId);
      if (!meta) return { error: 'notfound' };
      if (meta.pass && meta.pass !== String(pass || '')) return { error: 'pass' };
      if (typeof meta.players === 'number' && typeof meta.max === 'number' && meta.players >= meta.max)
        return { error: 'full' };
      const room = await Net.vibe.room.join(roomId, {
        topology: 'host',
        sync: { bufferSize: 32, interpDelayMs: 110 },
      });
      Net._wireRoom(room);
      Net.roomId = roomId;
      return { roomId, room };
    } catch (err) {
      console.warn('[Net] 加入失败', err && err.message || err);
      return { error: 'join' };
    }
  };

  Net.listRooms = async function () {
    if (!Net.vibe) return [];
    try {
      const all = await Net.vibe.rooms.list();
      return all.filter((r) => r.listed !== false && r.open !== false);
    } catch (_) { return []; }
  };

  Net.quickJoin = async function () {
    if (!Net.vibe) return null;
    try {
      const id = await Net.vibe.rooms.quickJoin({ filter: (r) => r.players < r.max && !r.pass });
      return id;
    } catch (_) { return null; }
  };

  /** 房主更新房间元数据（人数等） */
  Net.announceUpdate = async function (extra) {
    if (!Net.room || !Net.room.isHost) return;
    try { await Net.room.announce(Object.assign({ open: true, players: Game.lobby.count() }, extra || {})); }
    catch (_) { /* 元数据更新失败不影响对局 */ }
  };

  Net.leave = function () {
    if (Net.room) { try { Net.room.leave(); } catch (_) { } }
    Net.room = null; Net.roomId = null;
  };

  Net.onPeer = function (cb) { Net._peerCbs.push(cb); };
  Net.myId = function () { return Net.room ? Net.room.peerId : 'local'; };
  Net.isHost = function () { return !Net.room || Net.room.isHost; };
})();
