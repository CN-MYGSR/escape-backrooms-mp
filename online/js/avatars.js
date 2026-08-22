/* ============ 远端玩家化身 ============
 * 人类形态：带个人颜色的剪影 + 名牌；影者形态：黑影 + 暗红眼。
 * 位置由 game.js 的插值缓冲喂入 applyState()；本类只负责外观与动画。
 * 本地玩家是影者时，人类化身会被标记发光（夜视提示）。
 */
(function () {
  const { clamp, damp } = U;

  const PALETTE = [0x5ac8fa, 0xff9f68, 0x9d8df1, 0x63d471, 0xff6b81, 0xf5d76e];

  function nameSprite(name, colorCss) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(8,7,4,0.72)';
    roundRect(x, 58, 12, 188, 40, 10);
    x.fill();
    x.fillStyle = colorCss;
    x.beginPath(); x.arc(80, 32, 10, 0, Math.PI * 2); x.fill();
    x.font = 'bold 26px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    x.fillStyle = '#e8e0c0';
    x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText(String(name).slice(0, 7), 100, 33);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function roundRect(x, a, b, w, h, r) {
    x.beginPath();
    x.moveTo(a + r, b);
    x.arcTo(a + w, b, a + w, b + h, r);
    x.arcTo(a + w, b + h, a, b + h, r);
    x.arcTo(a, b + h, a, b, r);
    x.arcTo(a, b, a + w, b, r);
    x.closePath();
  }

  class Avatar {
    constructor(scene, name, colorIdx) {
      this.name = name;
      this.colorIdx = colorIdx;
      this.shadow = false;
      this.x = 0; this.z = 0; this.yaw = 0; this.speed = 0;
      this._phase = 0;

      this.group = new THREE.Group();
      const colorHex = PALETTE[colorIdx % PALETTE.length];
      this.colorCss = '#' + new THREE.Color(colorHex).getHexString();

      // —— 人类形态 ——
      this.humanG = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: colorHex, roughness: 0.85, emissive: colorHex, emissiveIntensity: 0.08,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.0, 10), mat);
      body.position.y = 0.95; body.castShadow = true;
      this.humanG.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mat);
      head.position.y = 1.68; head.castShadow = true;
      this.humanG.add(head);
      this.humanMat = mat;
      this.group.add(this.humanG);

      // —— 影者形态（复用黑色人形轮廓，暗红眼区分 AI 影者）——
      this.shadowG = new THREE.Group();
      const black = new THREE.MeshStandardMaterial({ color: 0x070707, roughness: 0.95 });
      const mk = (geo, y) => {
        const m = new THREE.Mesh(geo, black);
        m.position.y = y; m.castShadow = true;
        this.shadowG.add(m); return m;
      };
      mk(new THREE.CylinderGeometry(0.16, 0.23, 1.05, 7), 1.28);
      const sh = mk(new THREE.SphereGeometry(0.155, 10, 8), 1.92);
      sh.scale.set(1, 1.32, 1.06);
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xc05050, fog: false });
      for (const ex of [-0.055, 0.055]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), eyeMat);
        e.position.set(ex, 0.03, 0.13);
        sh.add(e);
      }
      this.shadowArms = [];
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(sx * 0.27, 1.76, 0);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.058, 1.18, 6), black);
        arm.position.y = -0.59;
        pivot.add(arm); this.shadowG.add(pivot); this.shadowArms.push(pivot);
      }
      this.shadowG.scale.setScalar(1.14);
      this.shadowG.visible = false;
      this.group.add(this.shadowG);

      // —— 名牌 ——
      this.tagTex = nameSprite(name, this.colorCss);
      this.tag = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.tagTex, transparent: true, depthTest: true,
      }));
      this.tag.scale.set(1.7, 0.42, 1);
      this.tag.position.y = 2.25;
      this.group.add(this.tag);

      scene.add(this.group);
    }

    setShadow(on) {
      this.shadow = on;
      this.humanG.visible = !on;
      this.shadowG.visible = !!on;
    }

    applyState(x, z, yaw, speed, shadow) {
      this.x = x; this.z = z; this.yaw = yaw; this.speed = speed || 0;
      if (shadow !== this.shadow) this.setShadow(shadow);
    }

    // 本地影者视角：人类发光，穿透迷雾也隐约可见
    setGlow(on) {
      this.humanMat.emissiveIntensity = on ? 0.85 : 0.08;
    }

    update(dt, t, camPos) {
      this.group.position.set(this.x, 0, this.z);
      const targetYaw = this.yaw + Math.PI; // 模型面朝 +Z，玩家 yaw 0 = -Z
      this.group.rotation.y = targetYaw;
      // 行走动画
      const run = clamp(this.speed / 5, 0, 1);
      if (this.speed > 0.3) this._phase += dt * (5 + run * 7);
      const sw = Math.sin(this._phase) * (0.3 + run * 0.7);
      if (!this.shadow) {
        this.humanG.position.y = Math.abs(Math.sin(this._phase)) * run * 0.07;
      } else {
        for (let i = 0; i < 2; i++) this.shadowArms[i].rotation.x = i === 0 ? sw : -sw;
        this.shadowG.position.y = Math.abs(Math.sin(this._phase)) * run * 0.08;
      }
      // 名牌随距离淡出
      if (camPos) {
        const d = Math.hypot(camPos.x - this.x, camPos.z - this.z);
        this.tag.material.opacity = clamp(1.4 - d / 16, 0, 1);
        this.tag.visible = this.tag.material.opacity > 0.03;
      }
    }

    dispose(scene) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      this.tagTex.dispose();
      scene.remove(this.group);
    }
  }

  window.Avatar = Avatar;
  window.AVATAR_PALETTE = PALETTE;
})();
