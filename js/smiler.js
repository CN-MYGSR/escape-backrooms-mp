/* ============ 联机版 笑靥（AI 迷雾怪物）============
 * 双模式：房主 updateHost() 演算漂移/危害（onHit 回调）；
 * 客户端 applyNet()+updateRemote() 只做视觉。幻觉体只做视觉。
 */
(function () {
  const { clamp, damp, dist2D } = U;

  const P_COUNT = 340;

  class Smiler {
    constructor(scene, world) {
      this.world = world;
      this.pos = new THREE.Vector3();
      this.seen = false;
      this.dormant = 0;
      this.speedBonus = 0;
      this.fade = 1;
      this.onHit = null;      // 房主：持续伤害回调（targetId, dps）
      this.isHallucination = false;
      this._buildMesh(scene);
    }

    _buildMesh(scene) {
      const g = new THREE.Group();
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
      this.face = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 1.2),
        new THREE.MeshBasicMaterial({
          map: TEX.smilerFace(), transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, fog: false,
        })
      );
      this.face.position.z = 0.3;
      g.add(this.face);
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

    // 是否被目标（最近人类）的手电照住；target 含 {pos, forward, flashOn}
    isLit(target) {
      if (!target.flashOn) return false;
      const d = dist2D(this.pos.x, this.pos.z, target.pos.x, target.pos.z);
      if (d > 18) return false;
      const f = target.forward;
      const dx = this.pos.x - target.pos.x, dz = this.pos.z - target.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (f.x * dx + f.z * dz) / len;
      if (dot < 0.82) return false;
      return this.world.los(target.pos.x, target.pos.y, target.pos.z,
        this.pos.x, this.pos.y + 1.5, this.pos.z);
    }

    /** 房主演算：向最近人类漂移 */
    updateHost(dt, target, camera, t) {
      this.dormant = Math.max(0, this.dormant - dt);
      const d = dist2D(this.pos.x, this.pos.z, target.pos.x, target.pos.z);
      const hasLos = this.world.los(this.pos.x, this.pos.y + 1.5, this.pos.z,
        target.pos.x, target.pos.y, target.pos.z);
      const lit = this.isLit(target);

      let speed = 1.15 + this.speedBonus;
      if (this.dormant <= 0) {
        if (hasLos && d < 15) speed = lit ? 0.16 : (2.0 + this.speedBonus) * clamp(1.4 - d / 15, 0.55, 1);
        if (d < 1.6) speed = Math.min(speed, 1.0);
      }
      const dx = target.pos.x - this.pos.x, dz = target.pos.z - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const sideX = -dz / len, sideZ = dx / len;
      const sway = Math.sin(t * 0.6) * 0.4;
      this.pos.x += (dx / len * speed + sideX * sway * 0.3) * dt;
      this.pos.z += (dz / len * speed + sideZ * sway * 0.3) * dt;

      if (d < 1.35 && this.dormant <= 0 && this.onHit) {
        this.onHit(target.id, 26 * dt); // 持续伤害（目标客户端本地扣血）
      }
      this._visual(t, camera, d, lit);
      return { d, hasLos, lit };
    }

    applyNet(x, z) { this.pos.set(x, 0, z); }
    updateRemote(dt, camera, t) {
      camera.getWorldPosition(this._camW || (this._camW = new THREE.Vector3()));
      const d = dist2D(this.pos.x, this.pos.z, this._camW.x, this._camW.z);
      this._visual(t, camera, d, false);
    }

    _visual(t, camera, d, lit) {
      const f = this.fade;
      this.core.mat.opacity = 0.85 * f;
      this.wisp.mat.opacity = 0.25 * f;
      this.group.position.set(this.pos.x, 1.15 + Math.sin(t * 0.9) * 0.14, this.pos.z);
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
