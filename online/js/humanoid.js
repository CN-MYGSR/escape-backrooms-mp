/* ============ 联机版 影者（AI 怪物）============
 * 双模式：
 *  - 房主：updateHost() 跑完整 AI（永续追击：始终向最近人类寻路逼近，无游荡），
 *    攻击通过 onHit 回调（由房主广播 hit 事件，不直接改目标客户端的本地状态）。
 *  - 客户端：applyNet() 接收房主快照位置，updateRemote() 只做动画。
 * 低理智幻觉体：只调用 updateRemote（无 AI、不移动、不伤害）。
 */
(function () {
  const { clamp, damp, dist2D } = U;

  const ST = { CHASE: 2, INVESTIGATE: 1 }; // 全速追击 / 巡航追踪（均持续寻路）

  class Humanoid {
    constructor(scene, world) {
      this.world = world;
      this.state = ST.PATROL;
      this.pos = new THREE.Vector3();
      this.yaw = 0;
      this.path = null; this.wp = 0;
      this.repathT = 0;
      this.attackCd = 0; this.attackAnim = 0;
      this.stepPhase = 0;
      this.dormant = 0;
      this.speedBonus = 0;
      this.chaseLostT = 0;
      this.curSpeed = 0;      // 当前实际移动速度（广播给客户端做动画）
      this.onHit = null;      // 房主：攻击回调（target, dmg, knockback）
      this.isHallucination = false;
      this._buildMesh(scene);
    }

    _buildMesh(scene) {
      const g = new THREE.Group();
      const black = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95, metalness: 0 });
      const mk = (geo, x, y, z) => {
        const m = new THREE.Mesh(geo, black);
        m.position.set(x, y, z);
        m.castShadow = true;
        g.add(m); return m;
      };
      mk(new THREE.CylinderGeometry(0.16, 0.23, 1.05, 7), 0, 1.38, 0);
      this.head = mk(new THREE.SphereGeometry(0.155, 10, 8), 0, 2.06, 0);
      this.head.scale.set(1, 1.32, 1.06);
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xd9d9c8, fog: false });
      for (const ex of [-0.055, 0.055]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.023, 6, 6), eyeMat);
        e.position.set(ex, 0.03, 0.13);
        this.head.add(e);
      }
      this.arms = [];
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(sx * 0.27, 1.86, 0);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.058, 1.18, 6), black);
        arm.position.y = -0.59; arm.castShadow = true;
        pivot.add(arm); g.add(pivot); this.arms.push(pivot);
      }
      this.legs = [];
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(sx * 0.12, 0.95, 0);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.075, 0.95, 6), black);
        leg.position.y = -0.475; leg.castShadow = true;
        pivot.add(leg); g.add(pivot); this.legs.push(pivot);
      }
      g.scale.setScalar(1.14);
      this.group = g;
      scene.add(g);
    }

    reset(x, z) {
      this.pos.set(x, 0, z);
      this.state = ST.CHASE;
      this.path = null;
      this.dormant = 6;
      this.speedBonus = 0;
      this.attackCd = 0;
      this.chaseLostT = 99;   // 开局先按巡航速逼近，目视确认后再全速
      this.curSpeed = 0;
      this.group.visible = true;
    }

    get cx() { return this.world.toCX(this.pos.x); }
    get cy() { return this.world.toCY(this.pos.z); }

    setPathTo(cx, cy) {
      this.path = MZ.findPath(this.world.maze.grid, this.cx, this.cy, cx, cy);
      this.wp = 1;
    }

    canSee(player, range) {
      if (player.hidden) return false;
      const d = dist2D(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
      if (d > range) return false;
      const toP = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
      let dyaw = toP - this.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      if (Math.abs(dyaw) > 1.35 && d > 2.2) return false;
      return this.world.los(this.pos.x, 1.9, this.pos.z, player.pos.x, player.pos.y, player.pos.z);
    }

    /** 房主演算：target 为「最近人类」的玩家代理 {pos, cx, cy, sprinting, id}
     *  永续追击：任何时刻都向玩家所在格持续寻路，永不游荡；
     *  近 8 秒内目视/听到 → 全速（5.1+加成），长期脱离接触 → 巡航速（4.2）继续逼近。 */
    updateHost(dt, target, t) {
      const d = dist2D(this.pos.x, this.pos.z, target.pos.x, target.pos.z);
      this.attackCd = Math.max(0, this.attackCd - dt);
      this.dormant = Math.max(0, this.dormant - dt);
      if (this.dormant > 0) { this.curSpeed = 0; this._animate(dt, 0, t); return; }

      const sees = this.canSee(target, 30);
      const hears = target.sprinting && d < 20;
      if (sees || hears) {
        if (this.state !== ST.CHASE) {
          this.state = ST.CHASE;
          SFX.buzzFlicker();
        }
        this.chaseLostT = 0;
      } else {
        this.chaseLostT += dt;
        this.state = ST.INVESTIGATE; // 巡航追踪档：仍持续向玩家寻路
      }

      const hot = this.chaseLostT < 8;
      const speed = (hot ? 5.1 : 4.2) + this.speedBonus * (hot ? 1 : 0.5);

      let moved = 0;
      this.repathT -= dt;
      if (sees && d < 11) {
        this._steer(dt, target.pos.x, target.pos.z, speed);
        this.path = null;
        moved = speed;
      } else {
        if (this.repathT <= 0 || !this.path) {
          this.setPathTo(target.cx, target.cy);
          this.repathT = 0.45;
        }
        if (!this._pathDone()) {
          moved = this._follow(dt, speed);
        } else {
          // 同格或路径走尽：直接贴向玩家，等下次重寻路纠正
          this._steer(dt, target.pos.x, target.pos.z, speed);
          moved = speed;
        }
      }

      // 攻击：通知房主（由房主发 hit 事件给目标客户端）
      if (d < 1.3 && this.attackCd <= 0 &&
          this.world.los(this.pos.x, 1.9, this.pos.z, target.pos.x, target.pos.y, target.pos.z)) {
        this.attackCd = 1.7;
        this.attackAnim = 0.4;
        if (this.onHit) this.onHit(target.id, 34, this.pos.x, this.pos.z);
      }

      this.curSpeed = moved;
      this._animate(dt, moved, t);
    }

    /** 客户端：应用房主快照（x,z,yaw,state 速度近似）后只做动画 */
    applyNet(x, z, yaw, speed) {
      this.pos.set(x, 0, z);
      this.yaw = yaw;
      this._netSpeed = speed || 0;
    }
    updateRemote(dt, t) { this._animate(dt, this._netSpeed || 0, t); }

    _pathDone() { return !this.path || this.wp >= this.path.length; }

    _follow(dt, speed) {
      if (!this.path || this._pathDone()) return 0;
      const [wx, wy] = this.path[this.wp];
      const tx = this.world.toWX(wx), tz = this.world.toWZ(wy);
      const d = dist2D(this.pos.x, this.pos.z, tx, tz);
      if (d < 0.5) { this.wp++; return this._follow(dt, speed); }
      this._steer(dt, tx, tz, speed);
      return speed;
    }

    _steer(dt, tx, tz, speed) {
      const dx = tx - this.pos.x, dz = tz - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = this.pos.x + dx / len * speed * dt;
      const nz = this.pos.z + dz / len * speed * dt;
      const p = this.world.resolveCircle(nx, nz, 0.38);
      this.pos.x = p.x; this.pos.z = p.z;
      const targetYaw = Math.atan2(dx, dz);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, dt * 8);
      this.stepPhase += speed * dt * 0.62;
      if (this.stepPhase > 1) {
        this.stepPhase = 0;
        const px = window.Game ? Game.player.pos.x : 0;
        const pz = window.Game ? Game.player.pos.z : 0;
        SFX.monsterStep(clamp(1 - dist2D(this.pos.x, this.pos.z, px, pz) / 26, 0, 1) * 0.9);
      }
    }

    _animate(dt, speed, t) {
      this.group.position.copy(this.pos);
      this.group.rotation.y = this.yaw;
      const run = clamp(speed / 5, 0, 1);
      const ph = t * (4 + run * 8);
      const amp = 0.15 + run * 0.75;
      if (this.attackAnim > 0) {
        this.attackAnim -= dt;
        for (const a of this.arms) a.rotation.x = damp(a.rotation.x, -2.2, 20, dt);
      } else {
        this.arms[0].rotation.x = Math.sin(ph) * amp;
        this.arms[1].rotation.x = -Math.sin(ph) * amp;
      }
      this.legs[0].rotation.x = -Math.sin(ph) * amp * 0.9;
      this.legs[1].rotation.x = Math.sin(ph) * amp * 0.9;
      const lean = run * 0.14;
      this.group.rotation.x = damp(this.group.rotation.x, lean, 6, dt);
      this.group.position.y = Math.abs(Math.sin(ph)) * run * 0.09;
      if (speed < 0.1) this.head.rotation.y = Math.sin(t * 0.8) * 0.7;
      else this.head.rotation.y = damp(this.head.rotation.y, 0, 8, dt);
    }
  }

  Humanoid.STATES = ST;
  window.Humanoid = Humanoid;
})();
