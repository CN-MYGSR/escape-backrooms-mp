/* ============ 程序化贴图：全部用 Canvas 现场生成，零外部资源 ============ */
(function () {
  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function tex(c, repeat) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 4;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    return t;
  }
  function noise(ctx, w, h, alpha, mono) {
    for (let i = 0; i < w * h * 0.35; i++) {
      const v = mono ? 0 : Math.floor(Math.random() * 255);
      const g = Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
      if (mono) {
        ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
      }
    }
  }
  function stains(ctx, w, h, n, color, aMax) {
    for (let i = 0; i < n; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 8 + Math.random() * 42;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${color},${Math.random() * aMax})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  // ---- 黄色壁纸：竖条纹 + 噪点 + 水渍 ----
  function wallpaper() {
    const S = 256, c = canvas(S, S), x = c.getContext('2d');
    x.fillStyle = '#b3a04e'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < S; i += 32) {
      x.fillStyle = i % 64 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.05)';
      x.fillRect(i, 0, 16, S);
      x.fillStyle = 'rgba(0,0,0,0.14)';
      x.fillRect(i + 30, 0, 2, S);
    }
    // 顶部与底部的阴影渐变（假的接缝感）
    let g = x.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, 'rgba(0,0,0,0.30)');
    g.addColorStop(0.12, 'rgba(0,0,0,0)');
    g.addColorStop(0.88, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.34)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    stains(x, S, S, 9, '70,58,20', 0.13);
    noise(x, S, S, 0.05);
    return c;
  }

  // ---- 潮湿地毯：浓噪点 + 深色水渍 ----
  function carpet() {
    const S = 256, c = canvas(S, S), x = c.getContext('2d');
    x.fillStyle = '#8a7d49'; x.fillRect(0, 0, S, S);
    const img = x.getImageData(0, 0, S, S), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 46;
      d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.8;
    }
    x.putImageData(img, 0, 0);
    stains(x, S, S, 12, '30,26,10', 0.20);
    // 纤维划痕
    x.strokeStyle = 'rgba(0,0,0,0.08)';
    for (let i = 0; i < 60; i++) {
      const px = Math.random() * S, py = Math.random() * S;
      x.beginPath(); x.moveTo(px, py);
      x.lineTo(px + Math.random() * 8 - 4, py + Math.random() * 8 - 4);
      x.stroke();
    }
    return c;
  }

  // ---- 吸音吊顶：格子板块 ----
  function ceiling() {
    const S = 256, c = canvas(S, S), x = c.getContext('2d');
    x.fillStyle = '#c8c1a0'; x.fillRect(0, 0, S, S);
    x.strokeStyle = 'rgba(60,52,26,0.55)';
    x.lineWidth = 3;
    for (let i = 0; i <= S; i += S / 2) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i, S); x.stroke();
      x.beginPath(); x.moveTo(0, i); x.lineTo(S, i); x.stroke();
    }
    stains(x, S, S, 6, '80,64,20', 0.12);
    noise(x, S, S, 0.05);
    return c;
  }

  // ---- 笑靥的脸：透明底 + 发光白眼与利齿笑 ----
  function smilerFace() {
    const S = 256, c = canvas(S, S), x = c.getContext('2d');
    // 眼睛：细长的冷白椭圆
    x.shadowColor = '#dff6ff'; x.shadowBlur = 22;
    x.fillStyle = '#eafcff';
    for (const ex of [86, 170]) {
      x.beginPath();
      x.ellipse(ex, 88, 13, 20, 0, 0, Math.PI * 2);
      x.fill();
    }
    // 咧到极限的笑
    x.strokeStyle = '#f2ffff'; x.lineWidth = 13; x.lineCap = 'round';
    x.shadowBlur = 26; x.shadowColor = '#cfefff';
    x.beginPath();
    x.arc(128, 96, 74, 0.18 * Math.PI, 0.82 * Math.PI);
    x.stroke();
    // 牙缝刻痕
    x.shadowBlur = 0; x.strokeStyle = 'rgba(2,6,10,0.9)'; x.lineWidth = 3;
    for (let a = 0.24; a <= 0.76; a += 0.065) {
      const px = 128 + Math.cos(a * Math.PI) * 74;
      const py = 96 + Math.sin(a * Math.PI) * 74;
      // 沿径向向内的短线
      const nx = 128 - px, ny = 96 - py, len = Math.hypot(nx, ny);
      x.beginPath();
      x.moveTo(px + nx / len * 2, py + ny / len * 2);
      x.lineTo(px - nx / len * 11, py - ny / len * 11);
      x.stroke();
    }
    return c;
  }

  // ---- 出口灯牌 ----
  function exitSign() {
    const c = canvas(256, 128), x = c.getContext('2d');
    x.fillStyle = '#031b0e'; x.fillRect(0, 0, 256, 128);
    x.strokeStyle = '#0f5c33'; x.lineWidth = 8; x.strokeRect(6, 6, 244, 116);
    x.shadowColor = '#5cff9d'; x.shadowBlur = 24;
    x.fillStyle = '#b6ffd2';
    x.font = 'bold 58px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('EXIT', 128, 56);
    x.font = 'bold 34px "Microsoft YaHei", sans-serif';
    x.fillText('出 口', 128, 98);
    return c;
  }

  // ---- 杏仁水标签 ----
  function almondLabel() {
    const c = canvas(128, 64), x = c.getContext('2d');
    x.fillStyle = '#d8e6ea'; x.fillRect(0, 0, 128, 64);
    x.fillStyle = '#3a6b7c';
    x.font = 'bold 22px "Microsoft YaHei", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('杏仁水', 64, 24);
    x.font = '12px Arial';
    x.fillText('ALMOND WATER', 64, 46);
    return c;
  }

  const cache = {};
  window.TEX = {
    wallpaper: () => cache.wall || (cache.wall = tex(wallpaper())),
    carpet: () => cache.carpet || (cache.carpet = tex(carpet())),
    ceiling: () => cache.ceil || (cache.ceil = tex(ceiling())),
    smilerFace: () => cache.face || (cache.face = tex(smilerFace())),
    exitSign: () => cache.exit || (cache.exit = tex(exitSign())),
    almondLabel: () => cache.label || (cache.label = tex(almondLabel())),
  };
})();
