/* ============ 联机版玩家：本地移动（客户端权威自身位置，房主校验） ============
 * 保留：八字摇晃、晕 3D 友好模式、体力、手电筒、理智减速。
 * 新增：影者形态——高速、无限体力、夜视（由 game.js 控制环境光与化身发光）。
 */
(function () {
  const { clamp, damp } = U;

  class Player {
    constructor(camera, world) {
      this.cam = camera;
      this.world = world;
      this.keys = {};
      this.yaw = 0; this.pitch = 0;
      this.vel = new THREE.Vector3();
      this.kb = new THREE.Vector3();
      this.stamina = 100; this.health = 100;
      this.exhausted = false;
      this.bob = 0; this._sway = 0; this._t = 0;
      this.sprinting = false; this.moving = false; this.speed = 0;
      this.sprintRegenCd = 0;
      this.eyeH = 1.62;
      this.baseFov = 75;
      this.enabled = false;
      this.isShadow = false;   // 影者形态（逃脱/被抓/理智归零后）
      this._dragging = false;
      this._locked = false;

      this.holder = new THREE.Object3D();
      this.holder.add(camera);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(0, 0, 0);
      camera.position.set(0, 0, 0);

      this.flashOn = true;
      this.battery = 100;          // 手电电量：开启时 1/秒，捡电池 +50；影者夜视不耗电
      this._flickT = 0;            // 闪烁爆发剩余时长
      this.slots = [{ k: 'flash' }, null, null]; // 1=手电（常驻） 2/3=物品槽
      this.selSlot = 0;            // 当前选中槽位（E 使用）
      this.flashlight = new THREE.SpotLight(0xffedc0, 2.6, 34, 0.46, 0.42, 1.4);
      this.flashlight.castShadow = false;
      this.flashlight.shadow.mapSize.set(1024, 1024);
      this.flashlight.shadow.camera.near = 0.4;
      this.flashlight.shadow.camera.far = 34;
      this.flashlight.shadow.bias = -0.004;
      this.flTarget = new THREE.Object3D();
      this.flashlight.target = this.flTarget;
      this.glow = new THREE.PointLight(0x9a8b62, 0.22, 6, 1.5);

      this._bindInput();
    }

    _bindInput() {
      const canvas = document.getElementById('c');
      window.addEventListener('keydown', (e) => {
        if (window.Game && Game.chatOpen) { this.keys = {}; return; } // 聊天输入中不响应游戏键
        this.keys[e.code] = true;
        if (e.code === 'KeyT') { // 聊天（对局内）
          e.preventDefault();
          if (window.Game && (Game.phase === 'playing' || Game.phase === 'countdown')) UI.openChat();
          return;
        }
        if (!this.enabled) return;
        if (e.code === 'KeyF' && !this.isShadow) this.toggleFlash();
        else if (e.code === 'Digit1' || e.code === 'Numpad1') this.selSlot = 0;
        else if (e.code === 'Digit2' || e.code === 'Numpad2') this.selSlot = 1;
        else if (e.code === 'Digit3' || e.code === 'Numpad3') this.selSlot = 2;
        else if (e.code === 'KeyE') this.useItem();
      });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      document.addEventListener('mousemove', (e) => {
        if (!this.enabled) return;
        if (window.Game && Game.chatOpen) return; // 打字时不转视角
        if (this._locked || this._dragging) {
          this.yaw -= e.movementX * 0.0022;
          this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
        }
      });
      canvas.addEventListener('mousedown', () => { this._dragging = true; });
      window.addEventListener('mouseup', () => { this._dragging = false; });
      document.addEventListener('pointerlockchange', () => {
        this._locked = document.pointerLockElement === canvas;
      });
    }

    requestLock() {
      const canvas = document.getElementById('c');
      if (canvas.requestPointerLock) canvas.requestPointerLock();
    }
    toggleFlash() {
      if (!this.flashOn && this.battery <= 0 && !this.isShadow) {
        UI.msg('手电筒没电了，找找电池。', 'warn', 2400);
        SFX.click();
        return;
      }
      this.flashOn = !this.flashOn; SFX.click();
    }

    /** 使用当前选中槽位：1=手电开关；2/3=消耗品（杏仁水/电池）；空槽视为手电 */
    useItem() {
      if (this.isShadow) return; // 影者夜视内置，无物品
      const s = this.slots[this.selSlot];
      if (!s || s.k === 'flash') { this.toggleFlash(); return; }
      if (s.k === 'water') {
        this.stamina = Math.min(100, this.stamina + 45);
        this.health = Math.min(100, this.health + 25);
        if (window.Game) Game.san = Math.min(100, Game.san + 40);
        UI.msg('杏仁水：理智 +40，体力与生命恢复。', null, 2600);
      } else if (s.k === 'battery') {
        this.battery = Math.min(100, this.battery + 50);
        UI.msg('电池：手电电量 +50。', null, 2400);
      }
      SFX.pickup();
      this.slots[this.selSlot] = null;
    }

    get pos() { return this.holder.position; }
    get cx() { return this.world.toCX(this.pos.x); }
    get cy() { return this.world.toCY(this.pos.z); }
    get forward() {
      const cp = Math.cos(this.pitch);
      return new THREE.Vector3(
        -Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp
      );
    }

    reset(x, z) {
      this.pos.set(x, this.eyeH, z);
      this.cam.position.set(0, 0, 0);
      this.cam.rotation.set(0, 0, 0);
      this.vel.set(0, 0, 0); this.kb.set(0, 0, 0);
      this.yaw = 0; this.pitch = 0;
      this.stamina = 100; this.health = 100;
      this.battery = 100;
      this.slots = [{ k: 'flash' }, null, null];
      this.selSlot = 0;
      this.exhausted = false;
      this.flashOn = true;
      this.isShadow = false;
      this.bob = 0; this._sway = 0; this._t = 0;
      this.cam.fov = this.baseFov; this.cam.updateProjectionMatrix();
    }

    becomeShadow() {
      this.isShadow = true;
      this.stamina = 100;
      this.exhausted = false;
      this.battery = 100; // 夜视不耗电，条回满表示可用状态
      this.flashOn = true; // 影者自带夜视，手电保持开
    }

    hurt(amount, quiet) {
      if (this.isShadow) return; // 影者不会再受伤
      this.health = Math.max(0, this.health - amount);
      if (quiet) return;
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
      const g = window.Game;
      const friendly = !!(g && g.settings && g.settings.friendly);
      const san = g ? g.san : 100;

      let mx = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
      let mz = (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0);
      const moving = mx !== 0 || mz !== 0;
      this.moving = moving;

      // 速度：影者 > 人类冲刺 > 人类步行；理智 ≤75 人类再 -20%
      const wantSprint = (k.ShiftLeft || k.ShiftRight) && !this.exhausted;
      const sprinting = wantSprint && moving && (this.stamina > 0 || this.isShadow);
      this.sprinting = sprinting;
      let speed;
      if (this.isShadow) {
        speed = sprinting ? 8.6 : 7.0;
      } else {
        const sanSlow = san <= 75 ? 0.8 : 1;
        speed = (sprinting ? 6.3 : 3.7) * sanSlow;
      }

      // 体力（影者无限）
      if (sprinting && !this.isShadow) {
        this.stamina = Math.max(0, this.stamina - 21 * dt);
        this.sprintRegenCd = 0.8;
        if (this.stamina <= 0) this.exhausted = true;
      } else if (!this.isShadow) {
        this.sprintRegenCd -= dt;
        if (this.sprintRegenCd <= 0) this.stamina = Math.min(100, this.stamina + 13 * dt);
        if (this.exhausted && this.stamina > 26) this.exhausted = false;
      } else {
        this.stamina = 100;
      }

      // 目标速度：局部方向绕 Y 轴按 yaw 旋转（W 恒朝视角正前方）
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let tx = 0, tz = 0;
      if (moving) {
        const l = Math.hypot(mx, mz); mx /= l; mz /= l;
        tx = (mx * cos + mz * sin) * speed;
        tz = (mz * cos - mx * sin) * speed;
      }
      this.vel.x = damp(this.vel.x, tx, 11, dt);
      this.vel.z = damp(this.vel.z, tz, 11, dt);
      this.kb.multiplyScalar(Math.exp(-6 * dt));

      let nx = this.pos.x + (this.vel.x + this.kb.x) * dt;
      let nz = this.pos.z + (this.vel.z + this.kb.z) * dt;
      const p1 = this.world.resolveCircle(nx, nz, this.isShadow ? 0.46 : 0.42);
      this.pos.x = p1.x; this.pos.z = p1.z;
      this.pos.y = this.eyeH;
      this.speed = Math.hypot(this.vel.x, this.vel.z);

      this.holder.rotation.y = this.yaw;

      // ---- 行走视角摇晃（晕 3D 友好模式直接关闭）----
      this._t += dt;
      const targetSway = (moving && this.speed > 0.5) && !friendly ? (sprinting ? 1 : 0.7) : 0;
      this._sway = damp(this._sway, targetSway, 6, dt);
      const s = this._sway;
      const half = this.bob * 0.5;
      this.cam.position.set(
        Math.cos(half) * 0.11 * s,
        Math.sin(this.bob) * 0.115 * s + (friendly ? 0 : Math.sin(this._t * 1.5) * 0.004),
        0
      );
      this.cam.rotation.x = this.pitch + Math.sin(half + 1.3) * 0.016 * s;
      this.cam.rotation.y = 0;
      this.cam.rotation.z = -mx * 0.02 + Math.sin(half) * 0.046 * s;

      if (moving && this.speed > 0.5) {
        const rate = sprinting ? 12.4 : 9.2;
        const prev = this.bob;
        this.bob += dt * rate;
        if (Math.floor(prev / Math.PI) !== Math.floor(this.bob / Math.PI)) SFX.step(sprinting);
      } else {
        this.bob = 0;
      }

      // FOV 冲刺拉伸（影者常态广角感；友好模式关闭）
      const targetFov = (sprinting && !friendly) ? this.baseFov + (this.isShadow ? 10 : 8) : this.baseFov;
      if (Math.abs(this.cam.fov - targetFov) > 0.05) {
        this.cam.fov = damp(this.cam.fov, targetFov, 6, dt);
        this.cam.updateProjectionMatrix();
      }

      // 手电筒（影者强制常亮——夜视光源，不耗电）
      if (this.flashOn && !this.isShadow) {
        this.battery = Math.max(0, this.battery - dt);
        if (this.battery <= 0) {
          this.flashOn = false;
          UI.msg('手电筒没电了', 'warn', 2600);
          SFX.click();
        }
      }
      const f = this.forward;
      this.flashlight.position.copy(this.pos).addScaledVector(f, 0.25);
      this.flashlight.position.y -= 0.12;
      const aim = this.pos.clone().addScaledVector(f, 14);
      this.flTarget.position.lerp(aim, 1 - Math.exp(-9 * dt));
      let flInt = this.flashOn ? 2.6 : 0;
      // 闪烁：电量充足(≥40)偶发老化式闪烁；≤25 电量越低越频繁剧烈；影者夜视不受影响
      if (flInt > 0 && !this.isShadow) {
        if (this._flickT > 0) {
          this._flickT -= dt;
          flInt *= this.battery < 25 ? (0.15 + Math.random() * 0.3) : (0.35 + Math.random() * 0.55);
        } else if (this.battery < 25) {
          if (Math.random() < (25 - this.battery) / 25 * 0.35) this._flickT = 0.08 + Math.random() * 0.14;
        } else if (this.battery >= 40) {
          if (Math.random() < 0.004) this._flickT = 0.08 + Math.random() * 0.1; // 约 4~6 秒一次
        }
      }
      this.flashlight.intensity = flInt;
      this.glow.position.copy(this.pos);
    }
  }

  window.Player = Player;
})();
