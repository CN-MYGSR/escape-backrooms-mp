/* ============ BSP 迷宫生成器：二叉空间分割 + 环形回路 ============
 * 思路：
 *  1. 整张网格初始全为墙；用 BSP 递归切分地图区域，得到叶子区域。
 *  2. 每个叶子内凿出一间房间（大叶子有概率变成带立柱的开放大厅）。
 *  3. 后序遍历 BSP 树：每对兄弟子树之间凿一条 L 形走廊相连，
 *     形成"生成树"结构——此时迷宫是完美迷宫（任意两点唯一路径）。
 *  4. 环形回路：在已连通的房间对之间额外凿走廊制造环路（每条都会产生一个环），
 *     再对死角做"编织"(braiding)二次补环，并保证不会破坏外墙。
 * 结果：既有 BSP 的层次感，又有大量环形回路可以绕圈周旋。
 */
(function () {
  const WALL = 0, OPEN = 1, PILLAR = 2;

  function generate(seed, opts) {
    const R = new U.RNG(seed);
    const W = opts.W, H = opts.H;
    const grid = Array.from({ length: H }, () => new Array(W).fill(WALL));
    const rooms = [];
    const stats = { leaves: 0, halls: 0, loops: 0, braids: 0 };

    const oddInt = (lo, hi) => { // [lo,hi] 均为奇数
      const n = (hi - lo) / 2 + 1;
      return lo + 2 * Math.floor(R.next() * n);
    };

    // ---- 凿房间 ----
    function makeRoom(node) {
      stats.leaves++;
      const lw = node.x1 - node.x0 + 1, lh = node.y1 - node.y0 + 1;
      const hall = lw >= 5 && lh >= 5 && R.chance(opts.hallChance);
      let rx0, ry0, rx1, ry1;
      if (hall) {
        // 大厅：铺满整个叶子，内部按网格立柱
        rx0 = node.x0; ry0 = node.y0; rx1 = node.x1; ry1 = node.y1;
        stats.halls++;
      } else {
        const rw = oddInt(3, lw), rh = oddInt(3, lh);
        rx0 = oddInt(node.x0, node.x1 - rw + 1);
        ry0 = oddInt(node.y0, node.y1 - rh + 1);
        rx1 = rx0 + rw - 1; ry1 = ry0 + rh - 1;
      }
      for (let y = ry0; y <= ry1; y++)
        for (let x = rx0; x <= rx1; x++) grid[y][x] = OPEN;
      if (hall) {
        for (let y = ry0 + 2; y <= ry1 - 2; y += 2)
          for (let x = rx0 + 2; x <= rx1 - 2; x += 2) grid[y][x] = PILLAR;
      }
      const room = { x0: rx0, y0: ry0, x1: rx1, y1: ry1, cx: (rx0 + rx1) >> 1, cy: (ry0 + ry1) >> 1, hall };
      rooms.push(room);
      node.rooms = [room];
    }

    // ---- BSP 递归切分（子区域至少 3 格宽，7 格以下不再切该轴）----
    function build(node, depth) {
      const w = node.x1 - node.x0 + 1, h = node.y1 - node.y0 + 1;
      if ((w <= opts.maxLeaf && h <= opts.maxLeaf) || depth > 10) { makeRoom(node); return node; }
      let vertical;
      if (w > h) vertical = true;
      else if (h > w) vertical = false;
      else vertical = R.chance(0.5);
      if (vertical && w < 7) vertical = false;
      if (!vertical && h < 7) { if (w < 7) { makeRoom(node); return node; } vertical = true; }

      let a, b;
      if (vertical) {
        const cut = 2 * R.int((node.x0 + 3) / 2, (node.x1 - 3) / 2);
        a = build({ x0: node.x0, y0: node.y0, x1: cut - 1, y1: node.y1 }, depth + 1);
        b = build({ x0: cut + 1, y0: node.y0, x1: node.x1, y1: node.y1 }, depth + 1);
      } else {
        const cut = 2 * R.int((node.y0 + 3) / 2, (node.y1 - 3) / 2);
        a = build({ x0: node.x0, y0: node.y0, x1: node.x1, y1: cut - 1 }, depth + 1);
        b = build({ x0: node.x0, y0: cut + 1, x1: node.x1, y1: node.y1 }, depth + 1);
      }
      return { left: a, right: b, rooms: [] };
    }
    const root = build({ x0: 1, y0: 1, x1: W - 2, y1: H - 2 }, 0);

    // ---- L 形走廊 ----
    function corridor(ax, ay, bx, by) {
      if (R.chance(0.5)) {
        for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) grid[ay][x] = OPEN;
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) grid[y][bx] = OPEN;
      } else {
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) grid[y][ax] = OPEN;
        for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) grid[by][x] = OPEN;
      }
    }

    // ---- 连接 BSP 树（生成树）----
    (function connect(node) {
      if (!node.left) return; // 叶子已在 makeRoom 里生成房间
      connect(node.left); connect(node.right);
      const L = node.left.rooms, Rr = node.right.rooms;
      // 取分割线两侧彼此最近的房间相连，走廊更自然
      let best = null, bestD = Infinity;
      for (const ra of L) for (const rb of Rr) {
        const d = Math.abs(ra.cx - rb.cx) + Math.abs(ra.cy - rb.cy);
        if (d < bestD) { bestD = d; best = [ra, rb]; }
      }
      if (best) corridor(best[0].cx, best[0].cy, best[1].cx, best[1].cy);
      node.rooms = L.concat(Rr);
    })(root);

    // ---- BFS：两点间开放路径长度（带上限剪枝）----
    function pathLen(ax, ay, bx, by, cap) {
      if (grid[ay][ax] === WALL || grid[by][bx] === WALL) return Infinity;
      const seen = new Int32Array(W * H).fill(-1);
      const qx = new Int16Array(W * H), qy = new Int16Array(W * H);
      let head = 0, tail = 0;
      qx[tail] = ax; qy[tail] = ay; seen[ay * W + ax] = 0; tail++;
      while (head < tail) {
        const x = qx[head], y = qy[head], d = seen[y * W + x]; head++;
        if (d >= cap) continue;
        if (x === bx && y === by) return d;
        const nbs = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (const [nx, ny] of nbs) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (grid[ny][nx] === WALL || seen[ny * W + nx] !== -1) continue;
          seen[ny * W + nx] = d + 1;
          qx[tail] = nx; qy[tail] = ny; tail++;
        }
      }
      return Infinity;
    }

    // ---- 环形回路：在已连通的房间之间额外开洞 ----
    const loopTarget = Math.max(8, Math.round(rooms.length * opts.loopFactor));
    let tries = 0;
    while (stats.loops < loopTarget && tries < loopTarget * 40) {
      tries++;
      const a = R.pick(rooms), b = R.pick(rooms);
      if (a === b) continue;
      const manh = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
      if (manh > opts.maxLoopLen || manh < 3) continue;
      // 若两者本来就有很短的通路，再凿就是重复；跳过
      if (pathLen(a.cx, a.cy, b.cx, b.cy, manh + 2) !== Infinity) continue;
      corridor(a.cx, a.cy, b.cx, b.cy);
      stats.loops++;
    }

    // ---- 编织死角：把部分死胡同打通成环 ----
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (grid[y][x] !== OPEN) continue;
        let openN = 0;
        for (const [dx, dy] of dirs) if (grid[y + dy][x + dx] === OPEN) openN++;
        if (openN !== 1 || !R.chance(opts.braidChance)) continue;
        const cand = [];
        for (const [dx, dy] of dirs) {
          const wx = x + dx, wy = y + dy, bx = x + 2 * dx, by = y + 2 * dy;
          if (bx <= 0 || by <= 0 || bx >= W - 1 || by >= H - 1) continue;
          if (grid[wy][wx] === WALL && grid[by][bx] === OPEN) cand.push([wx, wy]);
        }
        if (cand.length) {
          const [wx, wy] = R.pick(cand);
          grid[wy][wx] = OPEN;
          stats.braids++;
        }
      }
    }

    // ---- 外墙保护 ----
    for (let x = 0; x < W; x++) { grid[0][x] = WALL; grid[H - 1][x] = WALL; }
    for (let y = 0; y < H; y++) { grid[y][0] = WALL; grid[y][W - 1] = WALL; }

    // ---- 连通性安全网：若有房间不可达，硬凿一条走廊 ----
    const reach = bfsDistances(grid, rooms[0].cx, rooms[0].cy);
    for (const r of rooms) {
      if (reach[r.cy * W + r.cx] < 0) {
        let near = null, nd = Infinity;
        for (const o of rooms) {
          if (o === r || reach[o.cy * W + o.cx] < 0) continue;
          const d = Math.abs(o.cx - r.cx) + Math.abs(o.cy - r.cy);
          if (d < nd) { nd = d; near = o; }
        }
        if (near) { corridor(r.cx, r.cy, near.cx, near.cy); stats.loops++; }
      }
    }

    return { W, H, grid, rooms, stats };
  }

  // 全图 BFS 距离场（-1 = 不可达），grid[ny][nx] !== WALL 视为可走
  function bfsDistances(grid, sx, sy) {
    const W = grid[0].length, H = grid.length;
    const dist = new Int32Array(W * H).fill(-1);
    const q = new Int32Array(W * H);
    let head = 0, tail = 0;
    if (grid[sy][sx] === WALL) return dist;
    dist[sy * W + sx] = 0; q[tail++] = sy * W + sx;
    while (head < tail) {
      const c = q[head++]; const x = c % W, y = (c / W) | 0, d = dist[c];
      const nbs = [c + 1, c - 1, c + W, c - W];
      for (let i = 0; i < 4; i++) {
        const n = nbs[i];
        if (i === 0 && x === W - 1) continue;
        if (i === 1 && x === 0) continue;
        if (n < 0 || n >= W * H) continue;
        const nx = n % W, ny = (n / W) | 0;
        if (grid[ny][nx] === WALL || dist[n] !== -1) continue;
        dist[n] = d + 1; q[tail++] = n;
      }
    }
    return dist;
  }

  // BFS 寻路：返回从 start 到 goal 的格子路径（含首尾），不可达返回 null
  function findPath(grid, sx, sy, gx, gy) {
    const W = grid[0].length, H = grid.length;
    if (sx === gx && sy === gy) return [[sx, sy]];
    if (grid[gy][gx] === WALL || grid[sy][sx] === WALL) return null;
    const prev = new Int32Array(W * H).fill(-2);
    const q = new Int32Array(W * H);
    let head = 0, tail = 0;
    const s = sy * W + sx, g = gy * W + gx;
    prev[s] = -1; q[tail++] = s;
    while (head < tail) {
      const c = q[head++];
      if (c === g) break;
      const x = c % W, y = (c / W) | 0;
      const nbs = [c + 1, c - 1, c + W, c - W];
      for (let i = 0; i < 4; i++) {
        if (i === 0 && x === W - 1) continue;
        if (i === 1 && x === 0) continue;
        const n = nbs[i];
        if (n < 0 || n >= W * H || prev[n] !== -2) continue;
        const nx = n % W, ny = (n / W) | 0;
        if (grid[ny][nx] === WALL) continue;
        prev[n] = c; q[tail++] = n;
      }
    }
    if (prev[g] === -2) return null;
    const path = [];
    for (let c = g; c !== -1; c = prev[c]) path.push([c % W, (c / W) | 0]);
    path.reverse();
    return path;
  }

  window.MZ = { generate, bfsDistances, findPath, WALL, OPEN, PILLAR };
})();
