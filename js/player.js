/* ============ 玩家：第一人称控制 / 碰撞 / 体力 / 手电筒 / 行走视角摇晃 ============ */
(function () {
  const { clamp, damp } = U;

  class Player {
    constructor(camera, world) {
      this.cam = camera;
      this.world = world;
      this.keys = {};
      this.yaw = 0; this.pitch = 0;
      this.vel = new THREE.Vector3();
      this.kb = new THREE.Vector3(); // 击退冲量
      this.stamina = 100; this.health = 100;
      this.exhausted = false;
      this.bob = 0;          // 行走摆动相位
      this._sway = 0;        // 摇晃强度（平滑淡入淡出）
      this._t = 0;           // 待机呼吸计时
      this.sprinting = false; this.moving = false; this.speed = 0;
      this.sprintRegenCd = 0;
      this.eyeH = 1.62;
      this.baseFov = 75;
      this.enabled = false;
      this._dragging = false;
      this._locked = false;

      // 相机装在"支架"上：支架承担逻辑位置与 yaw（碰撞、AI 都读它），
      // 子相机只叠加摇晃偏移——摇晃不影响碰撞与怪物判定。
      this.holder = new THREE.Object3D();
      this.holder.add(camera);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(0, 0, 0);
      camera.position.set(0, 0, 0);

      // 手电筒
      this.flashOn = true;
      this.flashlight = new THREE.SpotLight(0xffedc0, 2.6, 34, 0.46, 0.42, 1.4);
      this.flashlight.castShadow = false; // 由画质选项决定
      this.flashlight.shadow.mapSize.set(1024, 1024);
      this.flashlight.shadow.camera.near = 0.4;
      this.flashlight.shadow.camera.far = 34;
      this.flashlight.shadow.bias = -0.004;
      this.flTarget = new THREE.Object3D();
      this.flashlight.target = this.flTarget;
      // 手里的一点暖光，避免全黑
      this.glow = new THREE.PointLight(0x9a8b62, 0.22, 6, 1.5);

      this._bindInput();
    }

    _bindInput() {
      const canvas = document.getElementById('c');
      window.addEventListener('keydown', (e) => {
        this.keys[e.code] = true;
        if (e.code === 'KeyF' && this.enabled) this.toggleFlash();
      });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      document.addEventListener('mousemove', (e) => {
        if (!this.enabled) return;
        if (this._locked || this._dragging) {
          this.yaw -= e.movementX * 0.0022;
          this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
        }
      });
      canvas.addEventListener('mousedown', () => { this._dragging = true; });
      window.addEventListener('mouseup', () => { this._dragging = false; });
      document.addEventListener('pointerlockchange', () => {
        this._locked = document.pointerLockElement === canvas;
        if (!this._locked && this.enabled && window.Game && Game.state === 'playing') {
          Game.pause(); // 松开鼠标即暂停
        }
      });
    }

    requestLock() {
      const canvas = document.getElementById('c');
      if (canvas.requestPointerLock) canvas.requestPointerLock();
    }

    toggleFlash() {
      this.flashOn = !this.flashOn;
      SFX.click();
    }

    get pos() { return this.holder.position; }
    get cx() { return this.world.toCX(this.pos.x); }
    get cy() { return this.world.toCY(this.pos.z); }
    // 视线方向（由 yaw/pitch 解析计算，不依赖相机世界矩阵）
    get forward() {
      const cp = Math.cos(this.pitch);
      return new THREE.Vector3(
        -Math.sin(this.yaw) * cp,
        Math.sin(this.pitch),
        -Math.cos(this.yaw) * cp
      );
    }

    reset(x, z) {
      this.pos.set(x, this.eyeH, z);
      this.cam.position.set(0, 0, 0);
      this.cam.rotation.set(0, 0, 0);
      this.vel.set(0, 0, 0); this.kb.set(0, 0, 0);
      this.yaw = 0; this.pitch = 0;
      this.stamina = 100; this.health = 100;
      this.exhausted = false;
      this.flashOn = true;
      this.bob = 0; this._sway = 0; this._t = 0;
      this.cam.fov = this.baseFov; this.cam.updateProjectionMatrix();
    }

    hurt(amount, quiet) {
      this.health = Math.max(0, this.health - amount);
      if (quiet) return; // 持续伤害（黑雾）不刷屏
      UI.damageFlash();
      SFX.hurt();
    }

    knockback(fromX, fromZ, power) {
      const dx = this.pos.x - fromX, dz = this.pos.z - fromZ;
      const len = Math.hypot(dx, dz) || 1;
      this.kb.x += dx / len * power;
      this.kb.z += dz / len * power;
    }

    update(dt) {
      if (!this.enabled) return;
      const k = this.keys;
      const wantSprint = (k.ShiftLeft || k.ShiftRight) && !this.exhausted;
      let mx = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
      let mz = (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0);
      const moving = mx !== 0 || mz !== 0;
      this.moving = moving;

      // 体力
      const sprinting = wantSprint && moving && this.stamina > 0;
      this.sprinting = sprinting;
      if (sprinting) {
        this.stamina = Math.max(0, this.stamina - 21 * dt);
        this.sprintRegenCd = 0.8;
        if (this.stamina <= 0) this.exhausted = true;
      } else {
        this.sprintRegenCd -= dt;
        if (this.sprintRegenCd <= 0)
          this.stamina = Math.min(100, this.stamina + 13 * dt);
      }
      if (this.exhausted && this.stamina > 26) this.exhausted = false;

      // 目标速度：局部方向绕 Y 轴按 yaw 旋转
      // W(mz=-1) 恒朝视角正前方，S 恒朝身后，A/D 恒为视角左右平移
      // 理智 ≤75 时移速下降 20%
      const sanSlow = (window.Game && Game.san <= 75) ? 0.8 : 1;
      const speed = (sprinting ? 6.3 : 3.7) * sanSlow;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let tx = 0, tz = 0;
      if (moving) {
        const l = Math.hypot(mx, mz); mx /= l; mz /= l;
        tx = (mx * cos + mz * sin) * speed;
        tz = (mz * cos - mx * sin) * speed;
      }
      this.vel.x = damp(this.vel.x, tx, 11, dt);
      this.vel.z = damp(this.vel.z, tz, 11, dt);
      // 击退衰减
      this.kb.multiplyScalar(Math.exp(-6 * dt));

      // 位移 + 碰撞（圆形推挤）。逻辑位置只存在支架上。
      let nx = this.pos.x + (this.vel.x + this.kb.x) * dt;
      let nz = this.pos.z + (this.vel.z + this.kb.z) * dt;
      const r = 0.42;
      const p1 = this.world.resolveCircle(nx, nz, r);
      this.pos.x = p1.x; this.pos.z = p1.z;
      this.pos.y = this.eyeH;
      this.speed = Math.hypot(this.vel.x, this.vel.z);

      // 支架朝向（逻辑 yaw）
      this.holder.rotation.y = this.yaw;

      // ---- 行走视角摇晃（只作用于子相机；晕 3D 友好模式直接关闭）----
      this._t += dt;
      const friendly = !!(window.Game && Game.settings && Game.settings.friendly);
      const targetSway = (moving && this.speed > 0.5) && !friendly ? (sprinting ? 1 : 0.7) : 0;
      this._sway = damp(this._sway, targetSway, 6, dt);
      const s = this._sway;
      const half = this.bob * 0.5; // 横向摆动频率为纵向一半 → 经典"八"字轨迹
      this.cam.position.set(
        Math.cos(half) * 0.11 * s,                                         // 横向左右晃
        Math.sin(this.bob) * 0.115 * s + (friendly ? 0 : Math.sin(this._t * 1.5) * 0.004), // 纵向起伏 + 待机呼吸
        0
      );
      this.cam.rotation.x = this.pitch + Math.sin(half + 1.3) * 0.016 * s;
      this.cam.rotation.y = 0;
      this.cam.rotation.z = -mx * 0.02 + Math.sin(half) * 0.046 * s; // 摇摆侧倾 + 移动侧身压低

      // 摆动相位推进 & 脚步声（每半个纵向周期一步；友好模式下相位照常走，仅画面不动）
      if (moving && this.speed > 0.5) {
        const rate = sprinting ? 12.4 : 9.2;
        const prev = this.bob;
        this.bob += dt * rate;
        if (Math.floor(prev / Math.PI) !== Math.floor(this.bob / Math.PI)) SFX.step(sprinting);
      } else {
        this.bob = 0;
      }

      // FOV 冲刺拉伸（晕 3D 友好模式下关闭）
      const targetFov = (sprinting && !friendly) ? this.baseFov + 8 : this.baseFov;
      if (Math.abs(this.cam.fov - targetFov) > 0.05) {
        this.cam.fov = damp(this.cam.fov, targetFov, 6, dt);
        this.cam.updateProjectionMatrix();
      }

      // 手电筒跟随逻辑视线（带延迟摆动）
      const f = this.forward;
      this.flashlight.position.copy(this.pos).addScaledVector(f, 0.25);
      this.flashlight.position.y -= 0.12;
      const aim = this.pos.clone().addScaledVector(f, 14);
      this.flTarget.position.lerp(aim, 1 - Math.exp(-9 * dt));
      this.flashlight.intensity = this.flashOn ? 2.6 : 0;
      this.glow.position.copy(this.pos);
    }
  }

  window.Player = Player;
})();
