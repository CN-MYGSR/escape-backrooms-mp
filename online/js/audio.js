/* ============ 程序化音效：全部由 WebAudio 现场合成 ============ */
(function () {
  const SFX = {
    ctx: null, master: null, muted: false,
    _noiseBuf: null,
    _hum: null, _drone: null, _whisper: null,
    _heartT: 0, _heartLevel: 0, _buzz: null,
  };

  SFX.init = function () {
    if (SFX.ctx) { if (SFX.ctx.state === 'suspended') SFX.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    SFX.ctx = new AC();
    SFX.master = SFX.ctx.createGain();
    SFX.master.gain.value = 0.9;
    SFX.master.connect(SFX.ctx.destination);
    // 预生成 2 秒白噪声
    const len = SFX.ctx.sampleRate * 2;
    SFX._noiseBuf = SFX.ctx.createBuffer(1, len, SFX.ctx.sampleRate);
    const d = SFX._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    SFX._startAmbience();
  };

  function noiseSrc(loop) {
    const s = SFX.ctx.createBufferSource();
    s.buffer = SFX._noiseBuf; s.loop = !!loop;
    return s;
  }

  // ---------- 环境音：日光灯嗡鸣 ----------
  SFX._startAmbience = function () {
    const c = SFX.ctx;
    // 100/120Hz 电流 hum
    const g = c.createGain(); g.gain.value = 0.028; g.connect(SFX.master);
    for (const f of [100, 120, 240]) {
      const o = c.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const og = c.createGain(); og.gain.value = f === 240 ? 0.25 : 1;
      o.connect(og); og.connect(g); o.start();
    }
    // 高频电流嘶声
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 7600; bp.Q.value = 8;
    const bg = c.createGain(); bg.gain.value = 0.006;
    const ns = noiseSrc(true);
    ns.connect(bp); bp.connect(bg); bg.connect(SFX.master); ns.start();
    SFX._buzz = bg;
  };

  // ---------- 危险氛围（影者追击时），level 0~1 ----------
  SFX._ensureDrone = function () {
    if (SFX._drone || !SFX.ctx) return;
    const c = SFX.ctx;
    const g = c.createGain(); g.gain.value = 0; g.connect(SFX.master);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    lp.connect(g);
    for (const f of [54, 55.7, 110.3]) {
      const o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      const og = c.createGain(); og.gain.value = 0.33;
      o.connect(og); og.connect(lp); o.start();
    }
    SFX._drone = g;
  };
  SFX.setDanger = function (level) {
    if (!SFX.ctx) return;
    SFX._ensureDrone();
    if (SFX._drone) SFX._drone.gain.setTargetAtTime(0.14 * level, SFX.ctx.currentTime, 0.4);
  };

  // ---------- 低语（笑靥接近时），level 0~1 ----------
  SFX._ensureWhisper = function () {
    if (SFX._whisper || !SFX.ctx) return;
    const c = SFX.ctx;
    const g = c.createGain(); g.gain.value = 0; g.connect(SFX.master);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 3;
    const ns = noiseSrc(true); ns.connect(bp); bp.connect(g); ns.start();
    // 缓慢调制滤波频率，像含混的人声
    const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.7;
    const lg = c.createGain(); lg.gain.value = 900;
    lfo.connect(lg); lg.connect(bp.frequency); lfo.start();
    SFX._whisper = g;
  };
  SFX.setWhisper = function (level) {
    if (!SFX.ctx) return;
    SFX._ensureWhisper();
    if (SFX._whisper) SFX._whisper.gain.setTargetAtTime(0.05 * level, SFX.ctx.currentTime, 0.6);
  };

  // ---------- 心跳：由 update 驱动（影者追击），level 0~1 ----------
  SFX.heartbeat = function (level) { SFX._heartLevel = level; };
  SFX.heartPulse = function (vol) { // 独立的一次双跳（低理智随机触发）
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const thump = (delay, v) => {
      const o = c.createOscillator(); o.type = 'sine';
      const g = c.createGain();
      o.frequency.setValueAtTime(62, t + delay);
      o.frequency.exponentialRampToValueAtTime(38, t + delay + 0.12);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(v, t + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.22);
      o.connect(g); g.connect(SFX.master);
      o.start(t + delay); o.stop(t + delay + 0.3);
    };
    const v = vol === undefined ? 0.4 : vol;
    thump(0, v); thump(0.16, v * 0.65);
  };
  SFX.update = function (dt) {
    if (!SFX.ctx || SFX._heartLevel <= 0.01) return;
    SFX._heartT -= dt;
    if (SFX._heartT <= 0) {
      SFX._heartT = Math.max(0.35, 1.15 - SFX._heartLevel * 0.75);
      const c = SFX.ctx, t = c.currentTime;
      const thump = (delay, vol) => {
        const o = c.createOscillator(); o.type = 'sine';
        const g = c.createGain();
        o.frequency.setValueAtTime(62, t + delay);
        o.frequency.exponentialRampToValueAtTime(38, t + delay + 0.12);
        g.gain.setValueAtTime(0, t + delay);
        g.gain.linearRampToValueAtTime(vol * SFX._heartLevel, t + delay + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.22);
        o.connect(g); g.connect(SFX.master);
        o.start(t + delay); o.stop(t + delay + 0.3);
      };
      thump(0, 0.5); thump(0.16, 0.32);
    }
  };

  // ---------- 单次音效 ----------
  SFX.step = function (sprint) {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const s = noiseSrc();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 380 + Math.random() * 260;
    const g = c.createGain();
    const vol = (sprint ? 0.34 : 0.2) * (0.8 + Math.random() * 0.4);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    s.playbackRate.value = 0.85 + Math.random() * 0.3;
    s.connect(lp); lp.connect(g); g.connect(SFX.master);
    s.start(t); s.stop(t + 0.12);
  };

  SFX.monsterStep = function (vol) {
    if (!SFX.ctx || vol <= 0.01) return;
    const c = SFX.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.16);
    const g = c.createGain();
    g.gain.setValueAtTime(0.5 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); g.connect(SFX.master);
    o.start(t); o.stop(t + 0.3);
  };

  SFX.click = function () {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'square';
    o.frequency.value = 1900;
    const g = c.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    o.connect(g); g.connect(SFX.master);
    o.start(t); o.stop(t + 0.04);
  };

  SFX.pickup = function () {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    [660, 990].forEach((f, i) => {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.12, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.35);
      o.connect(g); g.connect(SFX.master);
      o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.4);
    });
  };

  SFX.sting = function () { // 笑靥初见 jumpscare
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    for (const det of [0, 13, -11, 27]) {
      const o = c.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(180 + det * 6, t);
      o.frequency.exponentialRampToValueAtTime(880 + det * 20, t + 0.5);
      const g = c.createGain();
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      o.connect(g); g.connect(SFX.master);
      o.start(t); o.stop(t + 1.2);
    }
    const s = noiseSrc(); const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const g = c.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    s.connect(hp); hp.connect(g); g.connect(SFX.master);
    s.start(t); s.stop(t + 0.8);
  };

  SFX.screech = function () { // 影者击中
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(1350, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.45);
    const g = c.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g); g.connect(SFX.master);
    o.start(t); o.stop(t + 0.55);
    const s = noiseSrc(); const g2 = c.createGain();
    g2.gain.setValueAtTime(0.18, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(g2); g2.connect(SFX.master);
    s.start(t); s.stop(t + 0.4);
  };

  SFX.hurt = function () {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g); g.connect(SFX.master);
    o.start(t); o.stop(t + 0.45);
  };

  SFX.jumpscare = function () { // 被怪物杀死时的跳脸
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    // 低频轰鸣
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.connect(g); g.connect(SFX.master); o.start(t); o.stop(t + 0.85);
    // 噪声爆裂
    const s = noiseSrc();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.5, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(bp); bp.connect(g2); g2.connect(SFX.master);
    s.start(t); s.stop(t + 0.55);
    // 尖啸下滑
    const o2 = c.createOscillator(); o2.type = 'sawtooth';
    o2.frequency.setValueAtTime(1600, t);
    o2.frequency.exponentialRampToValueAtTime(220, t + 0.6);
    const g3 = c.createGain();
    g3.gain.setValueAtTime(0.28, t);
    g3.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    o2.connect(g3); g3.connect(SFX.master);
    o2.start(t); o2.stop(t + 0.7);
  };

  SFX.death = function () {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 2.2);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const g = c.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
    o.connect(lp); lp.connect(g); g.connect(SFX.master);
    o.start(t); o.stop(t + 2.5);
  };

  SFX.win = function () {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t + i * 0.16);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.16 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.16 + 1.4);
      o.connect(g); g.connect(SFX.master);
      o.start(t + i * 0.16); o.stop(t + i * 0.16 + 1.5);
    });
  };

  // 日光灯随机闪烁的电流爆音
  SFX.buzzFlicker = function () {
    if (!SFX.ctx) return;
    const c = SFX.ctx, t = c.currentTime;
    const s = noiseSrc();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 5200; bp.Q.value = 2;
    const g = c.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    s.connect(bp); bp.connect(g); g.connect(SFX.master);
    s.start(t); s.stop(t + 0.1);
  };

  window.SFX = SFX;
})();
