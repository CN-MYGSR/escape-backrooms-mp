/* ============ 联机版世界构建 ============
 * 与单机版的差异：杏仁水等道具摆放改用「房主下发的种子」驱动，
 * 保证所有客户端从 (seed, spawnIdx) 生成完全一致的世界。
 * 灯光池的随机闪烁是纯本地视觉，不影响一致性。
 */
(function () {
  const { clamp } = U;

  class World {
    constructor(scene, maze, propSeed, quality) {
      this.maze = maze;
      this.CELL = 3.2;
      this.WALL_H = 3.3;
      const size = maze.W * this.CELL;
      this.offX = -size / 2; this.offZ = -size / 2;

      this.group = new THREE.Group();
      scene.add(this.group);

      this.panelPos = [];
      this.bottles = [];
      this.batteries = [];
      this.exit = null;
      this._lightT = 0;
      this._flicker = { idx: -1, t: 0 };
      this._propRng = new U.RNG((propSeed >>> 0) || 1); // 道具摆放专用种子

      this._buildBase(quality);
      this._buildWalls();
      this._buildLights();
      this._buildExit();
      this._buildBottles();
      this._buildBatteries();
    }

    toCX(wx) { return clamp(Math.floor((wx - this.offX) / this.CELL), 0, this.maze.W - 1); }
    toCY(wz) { return clamp(Math.floor((wz - this.offZ) / this.CELL), 0, this.maze.H - 1); }
    toWX(cx) { return this.offX + (cx + 0.5) * this.CELL; }
    toWZ(cy) { return this.offZ + (cy + 0.5) * this.CELL; }
    los(x0, y0, z0, x1, y1, z1) {
      return U.gridLOS(x0, z0, x1, z1, this.maze.grid, this.CELL, this.offX, this.offZ);
    }

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

      this.group.add(new THREE.AmbientLight(0x4a4330, 0.62));
      this.group.add(new THREE.HemisphereLight(0x8a7c4a, 0x201c10, 0.5));
      // 影者的夜视：略抬环境光（客户端本地视觉）
      this.ambient = this.group.children[this.group.children.length - 2];
    }

    _buildWalls() {
      const { grid, W, H } = this.maze;
      const C = this.CELL;
      const isOpen = (x, y) => x >= 0 && y >= 0 && x < W && y < H && grid[y][x] !== MZ.WALL;
      const wallCells = [], pillarCells = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (grid[y][x] === MZ.WALL) {
            if (isOpen(x + 1, y) || isOpen(x - 1, y) || isOpen(x, y + 1) || isOpen(x, y - 1))
              wallCells.push([x, y]);
          } else if (grid[y][x] === MZ.PILLAR) pillarCells.push([x, y]);
        }
      }
      const dummy = new THREE.Object3D();
      const wallMat = new THREE.MeshStandardMaterial({ map: TEX.wallpaper(), roughness: 0.92 });
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
    }

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

      this.lightPool = [];
      for (let i = 0; i < 5; i++) {
        const l = new THREE.PointLight(0xffe9a8, 0.85, 11, 1.5);
        this.group.add(l);
        this.lightPool.push(l);
      }
    }

    _buildExit() {
      const { grid, W, H } = this.maze;
      const room = this.maze.rooms[this.maze.rooms.length - 1]; // 出口房（game.js 已排序）
      let dir = null, wx = room.cx, wy = room.cy;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = room.cx + dx, ny = room.cy + dy;
        if (nx <= 0 || ny <= 0 || nx >= W - 1 || ny >= H - 1) continue;
        if (grid[ny][nx] === MZ.WALL) { dir = { x: dx, z: dy }; wx = nx; wy = ny; break; }
      }
      if (!dir) dir = { x: 0, z: -1 };

      const g = new THREE.Group();
      const faceX = this.toWX(wx) + dir.x * (this.CELL / 2);
      const faceZ = this.toWZ(wy) + dir.z * (this.CELL / 2);
      g.position.set(faceX + dir.x * 0.05, 0, faceZ + dir.z * 0.05);
      g.rotation.y = Math.atan2(dir.x, dir.z);

      // 电梯（通往 B1 停车场；真出口在停车场）
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 2.6, 0.26),
        new THREE.MeshStandardMaterial({ color: 0x3a3e46, roughness: 0.4, metalness: 0.65 })
      );
      frame.position.set(0, 1.3, 0.1);
      frame.castShadow = true;
      g.add(frame);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 2.34, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x6a6e78, roughness: 0.3, metalness: 0.75, emissive: 0x2a2e38, emissiveIntensity: 0.5 })
      );
      door.position.set(0, 1.24, 0.22);
      g.add(door);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 0.4),
        new THREE.MeshBasicMaterial({ color: 0xffd24a, fog: false })
      );
      sign.position.set(0, 2.72, 0.3);
      g.add(sign);
      const glow = new THREE.PointLight(0xffd24a, 0.9, 9, 1.6);
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

    _buildBottles() {
      const R = this._propRng;
      const rooms = this.maze.rooms.filter((r) => !r.spawn && !r.isExit);
      const used = new Set();
      const bodyGeo = new THREE.CylinderGeometry(0.07, 0.078, 0.27, 10);
      const capGeo = new THREE.CylinderGeometry(0.034, 0.034, 0.05, 8);
      const capMat = new THREE.MeshStandardMaterial({ color: 0x8a8468, roughness: 0.6 });
      const bodyMat = new THREE.MeshStandardMaterial({
        map: TEX.almondLabel(), roughness: 0.35, transparent: true, opacity: 0.92,
        emissive: 0x1a3038, emissiveIntensity: 0.5,
      });
      let placed = 0, guard = 0;
      while (placed < Math.min(6, rooms.length) && guard++ < 300) {
        const r = rooms[Math.floor(R.next() * rooms.length)];
        const span = (r.x1 - r.x0) >> 1;
        const x = r.x0 + 2 * Math.floor(R.next() * (span + 1));
        const y = r.y0 + 2 * Math.floor(R.next() * (((r.y1 - r.y0) >> 1) + 1));
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
        this.bottles.push({ g, x: g.position.x, z: g.position.z, taken: false, ph: R.next() * 6 });
        placed++;
      }
      this.bottleTotal = this.bottles.length;
      this._propUsed = used; // 电池道具复用同一占位集合，避免与杏仁水重叠
    }

    _buildBatteries() {
      const R = this._propRng;
      const rooms = this.maze.rooms.filter((r) => !r.spawn && !r.isExit);
      const used = this._propUsed;
      const bodyGeo = new THREE.CylinderGeometry(0.072, 0.072, 0.24, 10);
      const nubGeo = new THREE.CylinderGeometry(0.026, 0.026, 0.045, 8);
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xd8a01e, roughness: 0.4,
        emissive: 0x6a4a10, emissiveIntensity: 0.75,
      });
      const nubMat = new THREE.MeshStandardMaterial({ color: 0xc8c8d0, roughness: 0.3, metalness: 0.7 });
      let placed = 0, guard = 0;
      while (placed < Math.min(4, rooms.length) && guard++ < 300) {
        const r = rooms[Math.floor(R.next() * rooms.length)];
        const span = (r.x1 - r.x0) >> 1;
        const x = r.x0 + 2 * Math.floor(R.next() * (span + 1));
        const y = r.y0 + 2 * Math.floor(R.next() * (((r.y1 - r.y0) >> 1) + 1));
        if (this.maze.grid[y][x] !== MZ.OPEN) continue;
        const key = x + ',' + y;
        if (used.has(key)) continue;
        used.add(key);
        const g = new THREE.Group();
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        const nub = new THREE.Mesh(nubGeo, nubMat);
        nub.position.y = 0.14;
        g.add(body); g.add(nub);
        g.position.set(this.toWX(x), 0.5, this.toWZ(y));
        this.group.add(g);
        this.batteries.push({ g, x: g.position.x, z: g.position.z, taken: false, ph: R.next() * 6 });
        placed++;
      }
      this.batteryTotal = this.batteries.length;
    }

    randomRoom(avoidCx, avoidCy) {
      const rooms = this.maze.rooms;
      for (let i = 0; i < 8; i++) {
        const r = rooms[Math.floor(Math.random() * rooms.length)];
        if (Math.abs(r.cx - avoidCx) + Math.abs(r.cy - avoidCy) > 8) return r;
      }
      return rooms[Math.floor(Math.random() * rooms.length)];
    }

    roomNear(cx, cy, minD, maxD) {
      const cands = this.maze.rooms.filter((r) => {
        const d = Math.abs(r.cx - cx) + Math.abs(r.cy - cy);
        return d >= minD && d <= maxD && !r.spawn;
      });
      if (!cands.length) return this.randomRoom(cx, cy);
      return cands[Math.floor(Math.random() * cands.length)];
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
          if (v === MZ.OPEN) continue;
          let hw, hh;
          if (v === MZ.WALL) { hw = hh = C / 2; }
          else { hw = hh = C * 0.17; }
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

    update(dt, playerPos, t) {
      this._lightT -= dt;
      if (this._lightT <= 0) {
        this._lightT = 0.35;
        const sorted = this.panelPos
          .map((p) => ({ p, d: p.distanceToSquared(playerPos) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, this.lightPool.length);
        sorted.forEach((s, i) => {
          this.lightPool[i].position.copy(s.p).setY(this.WALL_H - 0.35);
          this.lightPool[i].intensity = 0.85;
        });
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
      if (this.exit) this.exit.glow.intensity = 0.75 + Math.sin(t * 2.4) * 0.25;
    }

    dispose(scene) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      scene.remove(this.group);
    }
  }

  window.World = World;
})();
