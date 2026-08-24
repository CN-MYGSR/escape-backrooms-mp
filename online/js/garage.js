/* ============ 联机版 B1 停车场（第二区域）============
 * 由迷宫尽头的电梯进入（双向可返）。真正的出口在这里。
 * 确定性生成：所有客户端从 garageSeed 生成完全一致的布局与道具。
 * 网格值：0=墙(外围) 1=空 2=柱 3=车（碰撞半宽 ~1.0m）。
 * 实体（房主演算，客户端纯视觉）：
 *  - Mimic 伪装者：伪装成玩家的怪物，被注视时移动极慢，不被看时快速贴近；
 *    被搜救队驱赶；攻击瞬间短暂现出影者形态。
 *  - Rescuer 搜救队：黄色重型防化服 NPC，跟随附近人类、头灯照明、驱赶伪装者，
 *    靠近时缓慢恢复体力。
 */
(function () {
  const { clamp, damp, dist2D } = U;

  const WALL = 0, OPEN = 1, PILLAR = 2, CAR = 3;
  const GW = 24, GH = 16; // 76.8 × 51.2 m

  const CAR_COLORS = [0x5a6068, 0x3a4048, 0x6a5a40, 0x48584a, 0x584848, 0x2e3440];

  class GarageWorld {
    constructor(scene, seed, settings) {
      this.CELL = 3.2;
      this.maze = { W: GW, H: GH, grid: null, rooms: [] };
      this.offX = -(GW * this.CELL) / 2;
      this.offZ = -(GH * this.CELL) / 2;
      this.group = new THREE.Group();
      this.bottles = [];
      this.batteries = [];
      this.exit = null;   // 真出口（右侧墙）
      this.lift = null;   // 返回迷宫的电梯厅（左侧）
      this.lights = [];
      this._rng = new U.RNG((seed >>> 0) || 7);
      this._flickT = 0;
      this._buildGrid();
      this._buildShell();
      this._buildProps();
      this._buildExit();
      this._buildLift();
      this.group.visible = false;
      scene.add(this.group);
    }

    // ---------- 坐标 / 碰撞（与迷宫 World 同构） ----------
    toCX(wx) { return clamp(Math.floor((wx - this.offX) / this.CELL), 0, GW - 1); }
    toCY(wz) { return clamp(Math.floor((wz - this.offZ) / this.CELL), 0, GH - 1); }
    toWX(cx) { return this.offX + (cx + 0.5) * this.CELL; }
    toWZ(cy) { return this.offZ + (cy + 0.5) * this.CELL; }
    los(x0, y0, z0, x1, y1, z1) {
      return U.gridLOS(x0, z0, x1, z1, this.maze.grid, this.CELL, this.offX, this.offZ);
    }
    isOpen(cx, cy) {
      return cx > 0 && cy > 0 && cx < GW - 1 && cy < GH - 1 && this.maze.grid[cy][cx] === OPEN;
    }
    openCell() {
      for (let i = 0; i < 60; i++) {
        const cx = 2 + Math.floor(this._rng.next() * (GW - 4));
        const cy = 2 + Math.floor(this._rng.next() * (GH - 4));
        if (this.isOpen(cx, cy)) return { cx, cy };
      }
      return { cx: (GW / 2) | 0, cy: 2 };
    }
    resolveCircle(x, z, r) {
      const { grid, W, H } = this.maze;
      const C = this.CELL;
      const minCX = Math.floor((x - r - this.offX) / C);
      const maxCX = Math.floor((x + r - this.offX) / C);
      const minCY = Math.floor((z - r - this.offZ) / C);
      const maxCY = Math.floor((z + r - this.offZ) / C);
      for (let cy = minCY; cy <= maxCY; cy++) {
        for (let cx = minCX; cx <= maxCX; cx++) {
          if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
          const v = grid[cy][cx];
          if (v === OPEN) continue;
          let hw, hh;
          if (v === WALL) { hw = hh = C / 2; }
          else if (v === CAR) { hw = hh = 1.02; }   // 车身比柱大得多
          else { hw = hh = C * 0.17; }              // 柱
          const bx = this.toWX(cx), bz = this.toWZ(cy);
          const nx = clamp(x, bx - hw, bx + hw);
          const nz = clamp(z, bz - hh, bz + hh);
          let dx = x - nx, dz = z - nz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          if (d2 < 1e-9) {
            const px = x - bx, pz = z - bz;
            if (Math.abs(px) / (hw + r) > Math.abs(pz) / (hh + r))
              x = bx + Math.sign(px || 1) * (hw + r);
            else
              z = bz + Math.sign(pz || 1) * (hh + r);
          } else {
            const d = Math.sqrt(d2);
            x = nx + dx / d * r;
            z = nz + dz / d * r;
          }
        }
      }
      return { x, z };
    }

    // ---------- 生成 ----------
    _buildGrid() {
      const R = this._rng;
      const grid = [];
      for (let y = 0; y < GH; y++) {
        const row = new Array(GW).fill(OPEN);
        grid.push(row);
      }
      // 外围墙
      for (let x = 0; x < GW; x++) { grid[0][x] = WALL; grid[GH - 1][x] = WALL; }
      for (let y = 0; y < GH; y++) { grid[y][0] = WALL; grid[y][GW - 1] = WALL; }
      // 柱网：每 4 格一根（跳过电梯厅与出口开口）
      for (let y = 3; y < GH - 2; y += 4) {
        for (let x = 3; x < GW - 2; x += 4) {
          if (Math.abs(y - 8) <= 1 && x < 6) continue;    // 电梯厅留空
          if (Math.abs(y - 8) <= 1 && x > GW - 4) continue; // 出口通道留空
          grid[y][x] = PILLAR;
        }
      }
      // 停车位（车辆）：柱网行之间的偶数列，约 45% 有车
      for (let y = 1; y < GH - 1; y++) {
        if ((y - 2) % 4 === 0) continue; // 行车道
        for (let x = 2; x < GW - 2; x += 2) {
          if (grid[y][x] !== OPEN) continue;
          if (Math.abs(y - 8) <= 1) continue; // 中间主通道保持畅通
          if (R.next() < 0.45) grid[y][x] = CAR;
        }
      }
      this.maze.grid = grid;
    }

    _buildShell() {
      const size = GW * this.CELL, depth = GH * this.CELL;
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(size, depth),
        new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.92 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.group.add(floor);

      // 顶棚（低矮压抑）
      const ceil = new THREE.Mesh(
        new THREE.PlaneGeometry(size, depth),
        new THREE.MeshStandardMaterial({ color: 0x191b1e, roughness: 0.95 })
      );
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = 2.75;
      this.group.add(ceil);
      this.group.add(new THREE.AmbientLight(0x69726b, 0.34));
      this.group.add(new THREE.HemisphereLight(0x9aa89b, 0x121519, 0.28));

      // 外墙
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x303338, roughness: 0.85 });
      const mkWall = (w, dx, dz) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 3.0, 0.4), wallMat);
        m.position.set(dx, 1.5, dz);
        this.group.add(m);
      };
      const hx = size / 2, hz = depth / 2;
      mkWall(size + 0.4, 0, -hz); mkWall(size + 0.4, 0, hz);
      mkWall(depth + 0.4, -hx, 0); mkWall(depth + 0.4, hx, 0);

      // 停车位划线（行车道两侧白线）
      const lineMat = new THREE.MeshStandardMaterial({ color: 0x9a9a90, roughness: 0.8, emissive: 0x3a3a36, emissiveIntensity: 0.25 });
      for (let y = 1; y < GH - 1; y++) {
        if ((y - 2) % 4 !== 0 && (y + 2) % 4 !== 0 && y !== 8 && y !== 7) continue;
        const line = new THREE.Mesh(new THREE.PlaneGeometry(size - 1, 0.12), lineMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(0, 0.012, this.toWZ(y) - this.CELL / 2 + 0.06);
        this.group.add(line);
      }

      // 柱
      const colGeo = new THREE.BoxGeometry(0.85, 3.0, 0.85);
      const colMat = new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.8 });
      const colYellow = new THREE.MeshStandardMaterial({ color: 0x8a7a2a, roughness: 0.75 });
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          if (this.maze.grid[y][x] !== PILLAR) continue;
          const c = new THREE.Mesh(colGeo, (x + y) % 2 ? colMat : colYellow);
          c.position.set(this.toWX(x), 1.5, this.toWZ(y));
          c.castShadow = true;
          this.group.add(c);
        }
      }

      // 车辆（哑光旧车，两盒 + 轮轴）
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          if (this.maze.grid[y][x] !== CAR) continue;
          const g = new THREE.Group();
          const color = CAR_COLORS[Math.floor(this._rng.next() * CAR_COLORS.length)];
          const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25 });
          const body = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.62, 4.1), bodyMat);
          body.position.y = 0.55; body.castShadow = true;
          g.add(body);
          const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(1.7, 0.5, 2.1),
            new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 0.25, metalness: 0.4 })
          );
          cabin.position.set(0, 1.05, -0.15);
          g.add(cabin);
          const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.75, 8);
          const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.95 });
          for (const wz of [1.35, -1.35]) {
            const w = new THREE.Mesh(wheelGeo, wheelMat);
            w.rotation.z = Math.PI / 2;
            w.position.set(0, 0.3, wz);
            g.add(w);
          }
          // 车头朝向行车道（左右交替）
          g.rotation.y = (x % 4 === 0 ? 0 : Math.PI) + (this._rng.next() - 0.5) * 0.08;
          g.position.set(this.toWX(x), 0, this.toWZ(y));
          this.group.add(g);
        }
      }

      // 顶灯：主通道灯带 + 四盏顶灯
      const stripMat = new THREE.MeshStandardMaterial({ color: 0xdfe8d8, emissive: 0xcfe0c8, emissiveIntensity: 1.1 });
      for (const ly of [7, 8]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(size - 2, 0.06, 0.24), stripMat);
        strip.position.set(0, 2.7, this.toWZ(ly));
        this.group.add(strip);
        this.lights.push(strip);
      }
      for (const [lx, lz] of [[-24, -14], [24, -14], [-24, 14], [24, 14]]) {
        const lamp = new THREE.PointLight(0xd8e8cc, 0.55, 26, 1.8);
        lamp.position.set(lx, 2.6, lz);
        this.group.add(lamp);
        this.lights.push(lamp);
      }
    }

    _buildProps() {
      const R = this._rng;
      const used = new Set();
      const place = (count, isBattery) => {
        let placed = 0, guard = 0;
        while (placed < count && guard++ < 500) {
          const cx = 1 + Math.floor(R.next() * (GW - 2));
          const cy = 1 + Math.floor(R.next() * (GH - 2));
          if (!this.isOpen(cx, cy)) continue;
          const key = cx + ',' + cy;
          if (used.has(key)) continue;
          used.add(key);
          const g = new THREE.Group();
          if (isBattery) {
            const body = new THREE.Mesh(
              new THREE.CylinderGeometry(0.072, 0.072, 0.24, 10),
              new THREE.MeshStandardMaterial({ color: 0xd8a01e, roughness: 0.4, emissive: 0x6a4a10, emissiveIntensity: 0.75 })
            );
            const nub = new THREE.Mesh(
              new THREE.CylinderGeometry(0.026, 0.026, 0.045, 8),
              new THREE.MeshStandardMaterial({ color: 0xc8c8d0, roughness: 0.3, metalness: 0.7 })
            );
            nub.position.y = 0.14;
            g.add(body); g.add(nub);
          } else {
            const body = new THREE.Mesh(
              new THREE.CylinderGeometry(0.07, 0.078, 0.27, 10),
              new THREE.MeshStandardMaterial({
                map: TEX.almondLabel(), roughness: 0.35, transparent: true, opacity: 0.92,
                emissive: 0x1a3038, emissiveIntensity: 0.5,
              })
            );
            const cap = new THREE.Mesh(
              new THREE.CylinderGeometry(0.034, 0.034, 0.05, 8),
              new THREE.MeshStandardMaterial({ color: 0x8a8468, roughness: 0.6 })
            );
            cap.position.y = 0.16;
            g.add(body); g.add(cap);
          }
          g.position.set(this.toWX(cx), 0.5, this.toWZ(cy));
          this.group.add(g);
          const rec = { g, x: g.position.x, z: g.position.z, taken: false, ph: R.next() * 6 };
          (isBattery ? this.batteries : this.bottles).push(rec);
          placed++;
        }
      };
      place(10, false); // 杏仁水 ×10（极多）
      place(8, true);   // 电池 ×8
      this.bottleTotal = this.bottles.length;
    }

    _buildExit() {
      // 真出口：右墙正中，绿光门
      const g = new THREE.Group();
      const x = this.toWX(GW - 1) + this.CELL / 2, z = this.toWZ(8);
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 2.6, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x1c241d, roughness: 0.6, metalness: 0.4 })
      );
      frame.position.set(x, 1.3, z);
      this.group.add(frame);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 2.3, 1.7),
        new THREE.MeshStandardMaterial({ color: 0x2c4a34, roughness: 0.5, emissive: 0x1a4a2a, emissiveIntensity: 0.8 })
      );
      door.position.set(x - 0.18, 1.2, z);
      this.group.add(door);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(1.3, 0.5),
        new THREE.MeshBasicMaterial({ color: 0x55ff99, fog: false })
      );
      sign.rotation.y = -Math.PI / 2;
      sign.position.set(x - 0.3, 2.75, z);
      this.group.add(sign);
      const glow = new THREE.PointLight(0x55ff99, 1.1, 12, 1.6);
      glow.position.set(x - 1.2, 2.3, z);
      this.group.add(glow);
      this.exit = {
        trigger: new THREE.Vector3(x - 1.1, 1.2, z),
        glow,
      };
    }

    _buildLift() {
      // 电梯厅：左墙正中（返回迷宫）
      const g = new THREE.Group();
      const x = this.toWX(0) + this.CELL / 2, z = this.toWZ(8);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4a4e56, roughness: 0.45, metalness: 0.6 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.0, 3.0), mat);
      box.position.set(x, 1.5, z);
      this.group.add(box);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 2.3, 1.8),
        new THREE.MeshStandardMaterial({ color: 0x6a6e78, roughness: 0.35, metalness: 0.7, emissive: 0x2a2e38, emissiveIntensity: 0.5 })
      );
      door.position.set(x + 0.85, 1.2, z);
      this.group.add(door);
      const glow = new THREE.PointLight(0xffd24a, 0.8, 8, 1.6);
      glow.position.set(x + 1.4, 2.2, z);
      this.group.add(glow);
      this.lift = {
        trigger: new THREE.Vector3(x + 1.5, 1.2, z),
        glow,
      };
    }

    update(dt, playerPos, t) {
      // 道具浮动
      for (const b of this.bottles) {
        if (b.taken) continue;
        b.g.position.y = 0.55 + Math.sin(t * 2 + b.ph) * 0.08;
        b.g.rotation.y = t * 1.2 + b.ph;
      }
      for (const b of this.batteries) {
        if (b.taken) continue;
        b.g.position.y = 0.55 + Math.sin(t * 2 + b.ph) * 0.08;
        b.g.rotation.y = -t * 1.4 + b.ph;
      }
      // 偶发灯光抖动
      this._flickT -= dt;
      if (this._flickT <= 0) {
        this._flickT = 2 + Math.random() * 5;
        const l = this.lights[Math.floor(Math.random() * this.lights.length)];
        if (l) {
          const base = l.intensity;
          l.intensity = base * 0.15;
          setTimeout(() => { l.intensity = base; }, 90 + Math.random() * 140);
        }
      }
      if (this.exit) this.exit.glow.intensity = 0.95 + Math.sin(t * 2.4) * 0.25;
    }

    dispose(scene) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      scene.remove(this.group);
    }
  }

  /* ============ 伪装者：看起来是玩家 ============ */
  class Mimic {
    constructor(parent, seed, name) {
      this.world = null; // 由 game.js 注入
      this.av = new Avatar(parent, name, Math.floor(new U.RNG(seed).next() * 6));
      this.x = 0; this.z = 0; this.yaw = 0;
      this.wp = null;
      this.attackCd = 0;
      this.revealT = 0;
      this.onHit = null;
    }
    _setRevealed(on) { this.av.setShadow(on); }

    /** 房主演算：target 为停车场内最近人类代理（含 forward）；rescuers 为搜救队数组 */
    updateHost(dt, target, rescuers, t, camPos) {
      this.attackCd = Math.max(0, this.attackCd - dt);
      if (this.revealT > 0) {
        this.revealT -= dt;
        if (this.revealT <= 0) this._setRevealed(false);
      }
      let tx = null, tz = null, speed = 0;

      // 搜救队威慑：7m 内逃离
      let flee = null, fd = 7;
      for (const r of rescuers) {
        const d = dist2D(this.x, this.z, r.x, r.z);
        if (d < fd) { fd = d; flee = r; }
      }
      if (flee) {
        const dx = this.x - flee.x, dz = this.z - flee.z, len = Math.hypot(dx, dz) || 1;
        tx = this.x + dx / len * 8; tz = this.z + dz / len * 8;
        speed = 4.6;
      } else if (target) {
        const d = dist2D(this.x, this.z, target.x, target.z);
        // 被注视（在视野方向内且可见）→ 只能缓慢挪动
        const f = target.forward;
        const dot = (f.x * (this.x - target.x) + f.z * (this.z - target.z)) / Math.max(0.01, d);
        const observed = dot > 0.45 && d < 24 &&
          this.world.los(this.x, 1.6, this.z, target.x, target.y, target.z);
        tx = target.x; tz = target.z;
        speed = observed ? 1.05 : (d < 18 ? 4.4 : 2.2);
        if (d < 1.3 && this.attackCd <= 0) {
          this.attackCd = 1.9;
          this._setRevealed(true);
          this.revealT = 2.4;
          if (this.onHit) this.onHit(target.id, 30, this.x, this.z);
        }
      } else {
        // 无目标：游荡
        if (!this.wp || dist2D(this.x, this.z, this.wp.x, this.wp.z) < 1.2) {
          const c = this.world.openCell();
          this.wp = { x: this.world.toWX(c.cx), z: this.world.toWZ(c.cy) };
        }
        tx = this.wp.x; tz = this.wp.z;
        speed = 1.8;
      }

      let moved = 0;
      if (tx !== null) {
        const dx = tx - this.x, dz = tz - this.z, len = Math.hypot(dx, dz) || 1;
        const p = this.world.resolveCircle(this.x + dx / len * speed * dt, this.z + dz / len * speed * dt, 0.34);
        this.x = p.x; this.z = p.z;
        const ty = Math.atan2(dx, dz);
        let dy = ty - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * 7);
        moved = speed;
      }
      this.av.applyState(this.x, this.z, this.yaw, moved, this.revealT > 0);
      this.av.update(dt, t, camPos);
      this.speed = moved;
    }

    applyNet(x, z, yaw, speed, revealed) {
      this._nx = x; this._nz = z; this._nyaw = yaw; this._nspd = speed;
      if (revealed !== undefined) this._nrev = !!revealed;
    }
    updateRemote(dt, t, camPos) {
      if (this._nx !== undefined) {
        this.x = damp(this.x, this._nx, 10, dt);
        this.z = damp(this.z, this._nz, 10, dt);
        let dy = (this._nyaw || 0) - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * 10);
      }
      this.av.applyState(this.x, this.z, this.yaw, this._nspd || 0, this._nrev);
      this.av.update(dt, t, camPos);
    }
    dispose(parent) { this.av.dispose(parent); }
  }

  /* ============ 搜救队：黄色重型防化服（友方） ============ */
  class Rescuer {
    constructor(parent) {
      this.world = null; // 由 game.js 注入
      this.x = 0; this.z = 0; this.yaw = 0;
      this.wp = null;
      this.speed = 0;
      this._phase = 0;

      const g = new THREE.Group();
      const suitMat = new THREE.MeshStandardMaterial({ color: 0xd8b028, roughness: 0.6 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 1.15, 10), suitMat);
      body.position.y = 0.92; body.castShadow = true;
      g.add(body);
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), suitMat);
      helmet.position.y = 1.72;
      g.add(helmet);
      const visor = new THREE.Mesh(
        new THREE.PlaneGeometry(0.26, 0.14),
        new THREE.MeshBasicMaterial({ color: 0x9fe8ff, fog: false })
      );
      visor.position.set(0, 1.72, 0.19);
      g.add(visor);
      const pack = new THREE.Mesh(
        new THREE.BoxGeometry(0.38, 0.52, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x4a4636, roughness: 0.7 })
      );
      pack.position.set(0, 1.15, -0.33);
      g.add(pack);
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.95, 6), suitMat);
        arm.position.set(sx * 0.42, 1.12, 0);
        arm.rotation.z = sx * 0.18;
        g.add(arm);
      }
      // 头灯
      this.lamp = new THREE.SpotLight(0xfff2c8, 1.5, 20, 0.5, 0.45, 1.3);
      this.lamp.position.set(0, 1.74, 0.2);
      const tgt = new THREE.Object3D();
      tgt.position.set(0, 1.4, 10);
      g.add(tgt);
      this.lamp.target = tgt;
      g.add(this.lamp);
      const glow = new THREE.PointLight(0xffe8a8, 0.4, 6, 1.6);
      glow.position.set(0, 1.8, 0.3);
      g.add(glow);

      this.group = g;
      parent.add(g);
    }

    /** 房主演算：humans 为停车场内人类代理数组 */
    updateHost(dt, humans, t) {
      let target = null, td = 12;
      for (const h of humans) {
        const d = dist2D(this.x, this.z, h.x, h.z);
        if (d < td) { td = d; target = h; }
      }
      let tx, tz, speed;
      if (target && td > 2.6) { // 跟随但不贴身
        tx = target.x; tz = target.z; speed = 3.2;
      } else if (target) {
        tx = this.x; tz = this.z; speed = 0;
      } else {
        if (!this.wp || dist2D(this.x, this.z, this.wp.x, this.wp.z) < 1.2) {
          const c = this.world.openCell();
          this.wp = { x: this.world.toWX(c.cx), z: this.world.toWZ(c.cy) };
        }
        tx = this.wp.x; tz = this.wp.z; speed = 2.3;
      }
      let moved = 0;
      if (speed > 0) {
        const dx = tx - this.x, dz = tz - this.z, len = Math.hypot(dx, dz) || 1;
        const p = this.world.resolveCircle(this.x + dx / len * speed * dt, this.z + dz / len * speed * dt, 0.4);
        this.x = p.x; this.z = p.z;
        const ty = Math.atan2(dx, dz);
        let dy = ty - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * 6);
        moved = speed;
      }
      this.speed = moved;
      this._apply(dt, t, moved);
    }

    applyNet(x, z, yaw) {
      this._nx = x; this._nz = z; this._nyaw = yaw;
    }
    updateRemote(dt, t) {
      if (this._nx !== undefined) {
        this.x = damp(this.x, this._nx, 10, dt);
        this.z = damp(this.z, this._nz, 10, dt);
        let dy = (this._nyaw || 0) - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * 10);
      }
      this._apply(dt, t, this.speed || 2);
    }
    _apply(dt, t, speed) {
      this.group.position.set(this.x, 0, this.z);
      this.group.rotation.y = this.yaw;
      const run = clamp(speed / 3.2, 0, 1);
      if (speed > 0.2) this._phase += dt * (4 + run * 5);
      this.group.position.y = Math.abs(Math.sin(this._phase)) * run * 0.06;
      // 呼吸感：静止时轻微起伏
      this.group.scale.y = 1 + Math.sin(t * 1.6) * 0.008;
      this.lamp.intensity = 1.35 + Math.sin(t * 3.1) * 0.15;
    }
    dispose(parent) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      parent.remove(this.group);
    }
  }

  window.GarageWorld = GarageWorld;
  window.Mimic = Mimic;
  window.Rescuer = Rescuer;
})();
