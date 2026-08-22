/* ============ 工具库：种子随机数 / 数学 / 网格探测 ============ */
(function () {
  // mulberry32 种子随机数——保证同一张地图可以复现
  function RNG(seed) {
    let s = seed >>> 0;
    this.seed = function (n) { s = n >>> 0; };
    this.next = function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.range = (a, b) => a + this.next() * (b - a);
    this.int = (a, b) => Math.floor(this.range(a, b + 1)); // 含两端
    this.chance = (p) => this.next() < p;
    this.pick = (arr) => arr[Math.floor(this.next() * arr.length)];
  }

  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  // 与帧率无关的阻尼插值
  const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
  const dist2D = (x0, z0, x1, z1) => Math.hypot(x1 - x0, z1 - z0);

  /**
   * 网格直线探测（Amanatides & Woo DDA）。
   * grid[y][x]：0=墙。返回从 (x0,z0) 到 (x1,z1) 的世界坐标连线是否无墙阻挡。
   */
  function gridLOS(x0, z0, x1, z1, grid, cell, offX, offZ) {
    const toCX = (wx) => Math.floor((wx - offX) / cell);
    const toCY = (wz) => Math.floor((wz - offZ) / cell);
    let cx = toCX(x0), cy = toCY(z0);
    const ex = toCX(x1), ey = toCY(z1);
    const dx = x1 - x0, dz = z1 - z0;
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(cell / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(cell / dz) : Infinity;
    const nextBoundX = offX + (cx + (dx > 0 ? 1 : 0)) * cell;
    const nextBoundZ = offZ + (cy + (dz > 0 ? 1 : 0)) * cell;
    let tMaxX = dx !== 0 ? Math.abs((nextBoundX - x0) / dx) : Infinity;
    let tMaxZ = dz !== 0 ? Math.abs((nextBoundZ - z0) / dz) : Infinity;
    let guard = 0;
    while (guard++ < 400) {
      if (cx === ex && cy === ey) return true;
      if (tMaxX < tMaxZ) {
        if (tMaxX > 1) return true; // 目标格之前无阻挡
        cx += stepX; tMaxX += tDeltaX;
      } else {
        if (tMaxZ > 1) return true;
        cy += stepZ; tMaxZ += tDeltaZ;
      }
      if (cy < 0 || cy >= grid.length || cx < 0 || cx >= grid[0].length) return false;
      if (grid[cy][cx] === 0) return false; // 撞墙
    }
    return false;
  }

  window.U = { RNG, clamp, lerp, damp, dist2D, gridLOS };
})();
