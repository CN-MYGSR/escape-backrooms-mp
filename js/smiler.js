/* ============ 怪物二：笑靥 —— 黑色迷雾实体，正面悬浮发光笑脸 ============
 * 一团缓慢旋转的黑雾，正面永远对着你——那张笑得很开的脸。
 * 行为：无视墙壁、缓慢而坚定地向你漂移；黑暗中加速，被手电筒照住会被逼退。
 * 幻觉体（低理智时）只调用 updateVisualOnly：不移动、不伤害。
 */
(function () {
  const { clamp, damp, dist2D } = U;

  const P_COUNT = 340;

  class Smiler {
    constructor(scene, world) {
      this.world = world;
      this.pos = new THREE.Vector3();
      this.seen = false;       // 本局是否触发过初见惊吓
      this.dormant = 0;
      this.speedBonus = 0;
      this.fade = 1;           // 整体透明度（幻觉淡入淡出用）
      this._buildMesh(scene);
    }

    _buildMesh(scene) {
      const g = new THREE.Group();

      // 两层粒子构成烟柱
      const mkLayer = (count, size, opacity, color) => {
        const geo = new THREE.BufferGeometry();
        const arr = new Float32Array(count * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.PointsMaterial({
          color, size, transparent: true, opacity,
          depthWrite: false, sizeAttenuation: true,
        });
        const pts = new THREE.Points(geo, mat);
        pts.frustumCulled = false;
        g.add(pts);
        return { pts, mat, arr, seeds: [], count };
      };
      this.core = mkLayer(P_COUNT * 0.6 | 0, 0.17, 0.85, 0x121216);
      this.wisp = mkLayer(P_COUNT * 0.4 | 0, 0.46, 0.25, 0x0c0c10);
      for (const layer of [this.core, this.wisp]) {
        for (let i = 0; i < layer.count; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.pow(Math.random(), 0.6) * 0.85;
          layer.seeds.push({
            ax: Math.cos(a), az: Math.sin(a), r,
            y: (Math.random() - 0.5) * 2.7,
            ph: Math.random() * Math.PI * 2,
            sp: 0.6 + Math.random() * 1.6,
          });
        }
      }

      // 正面的笑脸（始终朝向玩家）
      this.face = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 1.2),
        new THREE.MeshBasicMaterial({
          map: TEX.smilerFace(), transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, fog: false,
        })
      );
      this.face.position.z = 0.3;
      g.add(this.face);
      // 笑脸散出的冷光
      this.light = new THREE.PointLight(0xbfe8ff, 0.55, 7, 1.6);
      this.light.position.z = 0.7;
      g.add(this.light);

      this.group = g;
      scene.add(g);
    }

    reset(x, z) {
      this.pos.set(x, 0, z);
      this.seen = false;
      this.dormant = 4;
      this.speedBonus = 0;
      this.fade = 1;
      this.group.visible = true;
    }

    get cx() { return this.world.toCX(this.pos.x); }
    get cy() { return this.world.toCY(this.pos.z); }

    // 是否被玩家手电筒照住
    isLit(player) {
      if (!player.flashOn) return false;
      const d = dist2D(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
      if (d > 18) return false;
      const f = player.forward;
      const dx = this.pos.x - player.pos.x, dz = this.pos.z - player.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (f.x * dx + f.z * dz) / len;
      if (dot < 0.82) return false; // 约 35° 光锥
      return this.world.los(player.pos.x, player.pos.y, player.pos.z, this.pos.x, this.pos.y + 1.5, this.pos.z);
    }

    update(dt, player, camera, t) {
      this.dormant = Math.max(0, this.dormant - dt);
      const d = dist2D(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
      const hasLos = this.world.los(this.pos.x, this.pos.y + 1.5, this.pos.z, player.pos.x, player.pos.y, player.pos.z);
      const lit = this.isLit(player);

      // ---- 漂移速度：基础稳定逼近；黑暗中有视线则大幅加速；被照住被逼退 ----
      let speed = 1.15 + this.speedBonus;
      if (this.dormant <= 0) {
        if (hasLos && d < 15) speed = lit ? 0.16 : (2.0 + this.speedBonus) * clamp(1.4 - d / 15, 0.55, 1);
        if (d < 1.6) speed = Math.min(speed, 1.0); // 贴脸时留一点活路
      }
      // 直线漂移（穿墙）+ 轻微侧摆
      const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const sideX = -dz / len, sideZ = dx / len;
      const sway = Math.sin(t * 0.6) * 0.4;
      this.pos.x += (dx / len * speed + sideX * sway * 0.3) * dt;
      this.pos.z += (dz / len * speed + sideZ * sway * 0.3) * dt;

      // ---- 危害 ----
      if (d < 1.35 && this.dormant <= 0 && !(window.Game && Game.spectate)) {
        Game.attacker('黑色迷雾「笑靥」');
        player.hurt(26 * dt, true);
      }

      // ---- 初见惊吓 ----
      if (!this.seen && d < 12 && hasLos && !(window.Game && Game.spectate)) {
        const f = player.forward;
        const dot = (f.x * -dx + f.z * -dz) / len;
        if (dot > 0.55) {
          this.seen = true;
          SFX.sting();
          UI.msg('……它在笑。', 'danger', 2600);
        }
      }

      // ---- 手电筒被它干扰闪烁 ----
      if (player.flashOn && d < 8 && Math.random() < 0.25) {
        player.flashlight.intensity = 2.6 * (0.25 + Math.random() * 0.75);
      }

      this._visual(t, camera, d, lit);
      return { d, hasLos, lit };
    }

    // 纯视觉刷新：幻觉体使用（不移动、不伤害、不照灯判定）
    updateVisualOnly(t, camera) {
      camera.getWorldPosition(this._camW || (this._camW = new THREE.Vector3()));
      const d = dist2D(this.pos.x, this.pos.z, this._camW.x, this._camW.z);
      this._visual(t, camera, d, false);
    }

    _visual(t, camera, d, lit) {
      const f = this.fade;
      // 烟雾层整体透明度跟随 fade（幻觉淡入淡出用）
      this.core.mat.opacity = 0.85 * f;
      this.wisp.mat.opacity = 0.25 * f;
      this.group.position.set(this.pos.x, 1.15 + Math.sin(t * 0.9) * 0.14, this.pos.z);
      // 粒子涡旋
      for (const layer of [this.core, this.wisp]) {
        const a = layer.arr;
        for (let i = 0; i < layer.count; i++) {
          const s = layer.seeds[i];
          const ang = s.ph + t * s.sp;
          const r = s.r * (1 + Math.sin(t * 1.3 + s.ph) * 0.14);
          a[i * 3] = s.ax * r + Math.sin(t * 0.7 + s.y * 2.1) * 0.1;
          a[i * 3 + 1] = s.y * (0.9 + Math.sin(t * 0.5 + s.ph) * 0.1);
          a[i * 3 + 2] = s.az * r + Math.cos(t * 0.7 + s.y * 2.1) * 0.1;
        }
        layer.pts.geometry.attributes.position.needsUpdate = true;
      }
      // 笑脸永远面向玩家（相机在支架下，取世界坐标），随距离呼吸
      camera.getWorldPosition(this._camW || (this._camW = new THREE.Vector3()));
      this.face.lookAt(this._camW);
      const pulse = 1 + Math.sin(t * 2.2) * 0.06 + (lit ? -0.15 : 0.08);
      this.face.scale.setScalar(pulse);
      this.face.material.opacity = clamp(0.55 + (1 - clamp(d / 22, 0, 1)) * 0.45, 0, 1) * f;
      this.light.intensity = (0.3 + Math.sin(t * 2.2) * 0.12 + (lit ? 0.25 : 0)) * f;
    }
  }

  window.Smiler = Smiler;
})();
