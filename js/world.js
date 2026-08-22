/* ============ 世界构建：把 BSP 网格渲染成后室场景 ============ */
(function () {
  const { clamp } = U;

  class World {
    constructor(scene, maze, quality) {
      this.maze = maze;
      this.CELL = 3.2;
      this.WALL_H = 3.3;
      const size = maze.W * this.CELL;
      this.offX = -size / 2; this.offZ = -size / 2;

      this.group = new THREE.Group();
      scene.add(this.group);

      this.panelPos = [];   // 灯板位置（供点光源池取用）
      this.bottles = [];
      this.exit = null;
      this._lightT = 0;
      this._flicker = { idx: -1, t: 0 };

      this._buildBase(quality);
      this._buildWalls();
      this._buildLights();
      this._buildExit();
      this._buildBottles();
    }

    // ---- 坐标换算 ----
    toCX(wx) { return clamp(Math.floor((wx - this.offX) / this.CELL), 0, this.maze.W - 1); }
    toCY(wz) { return clamp(Math.floor((wz - this.offZ) / this.CELL), 0, this.maze.H - 1); }
    toWX(cx) { return this.offX + (cx + 0.5) * this.CELL; }
    toWZ(cy) { return this.offZ + (cy + 0.5) * this.CELL; }
    los(x0, y0, z0, x1, y1, z1) { // 只做 XZ 平面探测
      return U.gridLOS(x0, z0, x1, z1, this.maze.grid, this.CELL, this.offX, this.offZ);
    }

    // ---- 地基 / 环境光 / 雾 ----
    _buildBase(quality) {
      const size = this.maze.W * this.CELL;

      const floorTex = TEX.carpet(); floorTex.repeat.set(size / 2.7, size / 2.7);
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.group.add(floor);

      const ceilTex = TEX.ceiling(); ceilTex.repeat.set(size / 1.7, size / 1.7);
      const ceil = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.95 })
      );
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = this.WALL_H;
      ceil.receiveShadow = true;
      this.group.add(ceil);

      // 后室永远亮着一半，暗着一半
      this.group.add(new THREE.AmbientLight(0x4a4330, 0.62));
      const hemi = new THREE.HemisphereLight(0x8a7c4a, 0x201c10, 0.5);
      this.group.add(hemi);
    }

    // ---- 墙体与立柱（实例化，一个 draw call）----
    _buildWalls() {
      const { grid, W, H } = this.maze;
      const C = this.CELL;
      const isOpen = (x, y) => x >= 0 && y >= 0 && x < W && y < H && grid[y][x] !== MZ.WALL;
      const wallCells = [], pillarCells = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (grid[y][x] === MZ.WALL) {
            // 只渲染贴着开放区的墙面，省掉迷宫内部看不见的实心块
            if (isOpen(x + 1, y) || isOpen(x - 1, y) || isOpen(x, y + 1) || isOpen(x, y - 1))
              wallCells.push([x, y]);
          } else if (grid[y][x] === MZ.PILLAR) {
            pillarCells.push([x, y]);
          }
        }
      }
      const dummy = new THREE.Object3D();
      const wallTex = TEX.wallpaper();
      const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.92 });
      const walls = new THREE.InstancedMesh(
        new THREE.BoxGeometry(C, this.WALL_H, C), wallMat, wallCells.length
      );
      walls.castShadow = walls.receiveShadow = true;
      wallCells.forEach(([x, y], i) => {
        dummy.position.set(this.toWX(x), this.WALL_H / 2, this.toWZ(y));
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        walls.setMatrixAt(i, dummy.matrix);
      });
      walls.instanceMatrix.needsUpdate = true;
      this.group.add(walls);

      if (pillarCells.length) {
        const s = C * 0.34;
        const pillars = new THREE.InstancedMesh(
          new THREE.BoxGeometry(s, this.WALL_H, s), wallMat.clone(), pillarCells.length
        );
        pillars.castShadow = pillars.receiveShadow = true;
        pillarCells.forEach(([x, y], i) => {
          dummy.position.set(this.toWX(x), this.WALL_H / 2, this.toWZ(y));
          dummy.updateMatrix();
          pillars.setMatrixAt(i, dummy.matrix);
        });
        pillars.instanceMatrix.needsUpdate = true;
        this.group.add(pillars);
      }
      this.wallCount = wallCells.length;
    }

    // ---- 天花板荧光灯板 + 流动点光源池 ----
    _buildLights() {
      const { grid, W, H } = this.maze;
      const dummy = new THREE.Object3D();
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++)
          if (grid[y][x] !== MZ.WALL && x % 3 === 1 && y % 3 === 1)
            this.panelPos.push(new THREE.Vector3(this.toWX(x), this.WALL_H - 0.03, this.toWZ(y)));

      const panels = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(this.CELL * 0.55, this.CELL * 0.34),
        new THREE.MeshBasicMaterial({ color: 0xfff3c2 }),
        this.panelPos.length
      );
      this.panelPos.forEach((p, i) => {
        dummy.position.copy(p);
        dummy.rotation.set(Math.PI / 2, 0, 0);
        dummy.updateMatrix();
        panels.setMatrixAt(i, dummy.matrix);
      });
      panels.instanceMatrix.needsUpdate = true;
      this.group.add(panels);

      // 只有 5 盏"真实"的点光源跟随玩家附近的灯板
      this.lightPool = [];
      for (let i = 0; i < 5; i++) {
        const l = new THREE.PointLight(0xffe9a8, 0.85, 11, 1.5);
        this.group.add(l);
        this.lightPool.push(l);
      }
    }

    // ---- 出口门（贴在出口房间的一面墙上）----
    _buildExit() {
      const { grid, W, H } = this.maze;
      const room = this.maze.rooms[this.maze.rooms.length - 1]; // 最远房间（main 里已排序）
      // 找与房间中心相邻的一面墙
      let dir = null, wx = room.cx, wy = room.cy;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = room.cx + dx, ny = room.cy + dy;
        if (nx <= 0 || ny <= 0 || nx >= W - 1 || ny >= H - 1) continue;
        if (grid[ny][nx] === MZ.WALL) { dir = { x: dx, z: dy }; wx = nx; wy = ny; break; }
      }
      if (!dir) dir = { x: 0, z: -1 }; // 兜底：朝北悬空门

      const g = new THREE.Group();
      const faceX = this.toWX(wx) + dir.x * (this.CELL / 2);
      const faceZ = this.toWZ(wy) + dir.z * (this.CELL / 2);
      g.position.set(faceX + dir.x * 0.05, 0, faceZ + dir.z * 0.05);
      g.rotation.y = Math.atan2(dir.x, dir.z);

      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 2.5, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x1c241d, roughness: 0.6, metalness: 0.4 })
      );
      frame.position.set(0, 1.25, 0.1);
      frame.castShadow = true;
      g.add(frame);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(1.34, 2.28, 0.1),
        new THREE.MeshStandardMaterial({ color: 0x2c4a34, roughness: 0.5, metalness: 0.3 })
      );
      door.position.set(0, 1.2, 0.2);
      g.add(door);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(1.3, 0.62),
        new THREE.MeshBasicMaterial({ map: TEX.exitSign(), fog: false })
      );
      sign.position.set(0, 2.72, 0.28);
      g.add(sign);
      const glow = new THREE.PointLight(0x55ff99, 0.9, 9, 1.6);
      glow.position.set(0, 2.2, 1.1);
      g.add(glow);
      this.group.add(g);

      this.exit = {
        cx: room.cx, cy: room.cy,
        pos: new THREE.Vector3(g.position.x, 1.2, g.position.z),
        trigger: new THREE.Vector3(faceX + dir.x * 0.9, 1.2, faceZ + dir.z * 0.9),
        discovered: false, glow,
      };
    }

    // ---- 杏仁水补给 ----
    _buildBottles() {
      const rooms = this.maze.rooms.filter(r => !r.spawn && !r.isExit);
      const used = new Set();
      const bodyGeo = new THREE.CylinderGeometry(0.07, 0.078, 0.27, 10);
      const capGeo = new THREE.CylinderGeometry(0.034, 0.034, 0.05, 8);
      const capMat = new THREE.MeshStandardMaterial({ color: 0x8a8468, roughness: 0.6 });
      const bodyMat = new THREE.MeshStandardMaterial({
        map: TEX.almondLabel(), roughness: 0.35, transparent: true, opacity: 0.92,
        emissive: 0x1a3038, emissiveIntensity: 0.5,
      });
      let placed = 0, guard = 0;
      while (placed < Math.min(6, rooms.length) && guard++ < 200) {
        const r = rooms[Math.floor(Math.random() * rooms.length)];
        const x = r.x0 + 2 * Math.ceil((r.x1 - r.x0) / 4) + (guard % 3);
        const y = r.y0 + 2 * Math.ceil((r.y1 - r.y0) / 4) + (guard % 2);
        if (x > r.x1 || y > r.y1) continue;
        if (this.maze.grid[y][x] !== MZ.OPEN) continue;
        const key = x + ',' + y;
        if (used.has(key)) continue;
        used.add(key);
        const g = new THREE.Group();
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.y = 0.16;
        g.add(body); g.add(cap);
        g.position.set(this.toWX(x), 0.5, this.toWZ(y));
        this.group.add(g);
        this.bottles.push({ g, x: g.position.x, z: g.position.z, taken: false, ph: Math.random() * 6 });
        placed++;
      }
      this.bottleTotal = this.bottles.length;
    }

    // ---- 随机选房间（怪物巡逻用）----
    randomRoom(avoidCx, avoidCy) {
      const rooms = this.maze.rooms;
      for (let i = 0; i < 8; i++) {
        const r = rooms[Math.floor(Math.random() * rooms.length)];
        if (Math.abs(r.cx - avoidCx) + Math.abs(r.cy - avoidCy) > 8) return r;
      }
      return rooms[Math.floor(Math.random() * rooms.length)];
    }

    // ---- 在 (cx,cy) 曼哈顿 minD~maxD 格范围内随机选一个房间（导演系统/徘徊用）----
    roomNear(cx, cy, minD, maxD) {
      const cands = this.maze.rooms.filter(r => {
        const d = Math.abs(r.cx - cx) + Math.abs(r.cy - cy);
        return d >= minD && d <= maxD && !r.spawn;
      });
      if (!cands.length) return this.randomRoom(cx, cy);
      return cands[Math.floor(Math.random() * cands.length)];
    }

    // ---- 圆形碰撞：墙壁（整格）与立柱（内缩方块）----
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
          if (v === MZ.OPEN) continue;
          let hw, hh;
          if (v === MZ.WALL) { hw = hh = C / 2; }
          else { hw = hh = C * 0.17; } // 立柱
          const bx = this.toWX(cx), bz = this.toWZ(cy);
          const nx = clamp(x, bx - hw, bx + hw);
          const nz = clamp(z, bz - hh, bz + hh);
          let dx = x - nx, dz = z - nz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          if (d2 < 1e-9) {
            // 圆心陷入方块内：沿最浅方向推出
            const pushX = (dx === 0 ? 1 : 0), px = x - bx, pz = z - bz;
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

    update(dt, playerPos, t) {
      // 点光源池跟随玩家
      this._lightT -= dt;
      if (this._lightT <= 0) {
        this._lightT = 0.35;
        const sorted = this.panelPos
          .map(p => ({ p, d: p.distanceToSquared(playerPos) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, this.lightPool.length);
        sorted.forEach((s, i) => {
          this.lightPool[i].position.copy(s.p).setY(this.WALL_H - 0.35);
          this.lightPool[i].intensity = 0.85;
          this.lightPool[i].userData.panel = s.p;
        });
        // 随机挑一盏闪烁
        if (Math.random() < 0.35) {
          this._flicker.idx = Math.floor(Math.random() * this.lightPool.length);
          this._flicker.t = 0.4 + Math.random() * 0.8;
          if (Math.random() < 0.5 &&
              playerPos.distanceTo(this.lightPool[this._flicker.idx].position) < 16)
            SFX.buzzFlicker();
        }
      }
      if (this._flicker.t > 0) {
        this._flicker.t -= dt;
        const l = this.lightPool[this._flicker.idx];
        if (l) l.intensity = 0.85 * (Math.random() < 0.55 ? 1 : 0.25);
      }
      // 杏仁水漂浮
      for (const b of this.bottles) {
        if (b.taken) continue;
        b.g.position.y = 0.55 + Math.sin(t * 2 + b.ph) * 0.08;
        b.g.rotation.y = t * 1.2 + b.ph;
      }
      // 出口绿光呼吸
      if (this.exit) this.exit.glow.intensity = 0.75 + Math.sin(t * 2.4) * 0.25;
    }

    dispose(scene) {
      this.group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        }
      });
      scene.remove(this.group);
    }
  }

  window.World = World;
})();
