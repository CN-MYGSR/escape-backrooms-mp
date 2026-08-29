# Escape Backrooms 创意工坊开发约定

## 1. Mod 能做什么

当前游戏是静态多脚本 Three.js 网页游戏。创意工坊 Mod 可以通过公开的 `window.EscapeBackroomsWorkshop` 注册表扩展：

- 玩家第一人称装饰和远端玩家化身外观。
- 本地音效与怪物音效；Mod 自己决定何时播放，不覆盖游戏内部音频函数。
- 迷宫和 B1 停车场中的装饰模型、灯光和非碰撞视觉道具。
- 本地规则数值，例如玩家移动速度、手电消耗、理智消耗、怪物速度和攻击伤害。
- 自定义道具：可恢复生命、理智、体力、电量，也可以作为本地武器对怪物造成伤害。
- 工坊 HUD 小组件和公开事件监听。

地图 Mod 只能添加装饰和道具，不能替换核心碰撞网格、网络协议、账号系统或房间状态机。

## 2. 公共对象和注册函数

唯一公共入口：`window.EscapeBackroomsWorkshop`。游戏同时公开 `window.Game` 作为运行时上下文，但 Mod 不应修改其私有字段。

所有注册 ID 必须使用小写英文、数字、`.`、`-`、`_`，并且在所有启用 Mod 中唯一。重复 ID 会被拒绝，不会静默覆盖。

### 外观

```js
EscapeBackroomsWorkshop.registerPlayerAppearance({
  id: 'my-mod.yellow-suit',
  create({ THREE, host, context }) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.8, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xe0b52a })
    );
    mesh.position.y = 1.1;
    return mesh;
  },
});
```

`create` 返回的 `THREE.Object3D` 会挂到本地玩家或远端玩家化身上。`context.kind` 为 `local-player` 或 `remote-player`。

### 音效

```js
EscapeBackroomsWorkshop.registerSound({
  id: 'my-mod.reload',
  src: './mods/my-mod/reload.mp3',
  volume: 0.8,
});
EscapeBackroomsWorkshop.registerMonsterSound({
  id: 'my-mod.smiler-roar',
  src: './mods/my-mod/smiler-roar.mp3',
});
EscapeBackroomsWorkshop.playSound('my-mod.reload');
```

`src` 应指向工坊 Mod 自己携带的静态资源。不要使用账号凭据、Token、管理接口或私有网络资源。

### 地图装饰

```js
EscapeBackroomsWorkshop.registerProp({
  id: 'my-mod.warning-lamp',
  zones: ['maze', 'garage'],
  create({ THREE, group, world, zone }) {
    const lamp = new THREE.PointLight(0xff3344, 1.2, 8);
    lamp.position.set(0, 2.3, 0);
    group.add(lamp);
    return { dispose() { group.remove(lamp); } };
  },
});
```

`world` 是当前区域的公开世界对象；装饰必须自行清理，不能修改 `world.maze.grid` 的碰撞值。

### 自定义道具

```js
EscapeBackroomsWorkshop.registerItem({
  id: 'my-mod.medkit',
  name: '急救包',
  icon: '急救',
  color: 0xff3355,
  createMesh({ THREE }) {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.18, 0.22),
      new THREE.MeshStandardMaterial({ color: 0xff3355 })
    );
  },
  onUse({ heal, message }) {
    heal(35);
    message('急救包：生命 +35');
  },
});

EscapeBackroomsWorkshop.on('round:start', ({ game }) => {
  const world = game.worlds[0];
  EscapeBackroomsWorkshop.spawnItem({
    itemId: 'my-mod.medkit',
    zone: 0,
    position: { x: world.toWX(3), y: 0, z: world.toWZ(3) },
  });
});
```

道具 `onUse` 可以调用 `heal(amount)`、`restoreSan(amount)`、`restoreStamina(amount)`、`restoreBattery(amount)`；也可以调用 `damageMonster(monsterId, amount)`。怪物伤害只在本地练习模式有效。

### 规则

```js
EscapeBackroomsWorkshop.registerRule({
  id: 'player.battery-drain',
  defaultValue: 1,
  min: 0,
  max: 5,
});
EscapeBackroomsWorkshop.setRule('player.battery-drain', 0.5);
```

当前游戏读取的稳定规则 ID：

- `player.walk-speed`
- `player.sprint-speed`
- `player.battery-drain`
- `player.sanity-drain`
- `monster.speed-multiplier`
- `monster.humanoid-damage`
- `monster.smiler-damage`

规则值会被 Mod 自己声明和修改；能力声明不是安全沙箱。

### HUD 和事件

```js
const off = EscapeBackroomsWorkshop.on('monster:attack', ({ monsterId, damage }) => {
  EscapeBackroomsWorkshop.playSound('my-mod.alert');
});
off();

EscapeBackroomsWorkshop.registerHudWidget({
  id: 'my-mod.status',
  mount(element) { element.textContent = 'Mod 已加载'; },
  update(element, { zone }) { element.textContent = `区域：${zone}`; },
});
```

事件：`game:start`、`round:start`、`round:end`、`zone:changed`、`monster:attack`、`monster:defeated`、`item:used`、`tick`。
事件参数是普通对象，事件监听器抛出的异常会记录到 `EscapeBackroomsWorkshop.errors`，不会覆盖游戏主循环。

## 3. 最小可运行 Mod

```html
<script>
  EscapeBackroomsWorkshop.registerItem({
    id: 'example.water',
    name: '示例杏仁水',
    icon: '水',
    onUse({ restoreSan, restoreStamina, restoreBattery, message }) {
      restoreSan(20);
      restoreStamina(20);
      restoreBattery(10);
      message('示例道具已使用');
    },
  });

  EscapeBackroomsWorkshop.on('round:start', ({ game }) => {
    const world = game.worlds[0];
    EscapeBackroomsWorkshop.spawnItem({
      itemId: 'example.water',
      zone: 0,
      position: { x: world.toWX(2), y: 0, z: world.toWZ(2) },
    });
  });
</script>
```

## 4. 启动前和启动后

启动顺序由游戏固定为：

1. 加载官方 `https://vibe.lumigrav.space/workshop/loader/v1.js`。
2. 加载并暴露 `window.EscapeBackroomsWorkshop`。
3. 建立 Three.js 场景、玩家对象和 `Game.gl`，但不启动逻辑循环和网络初始化。
4. 等待 `window.VibeHubWorkshop.beforeStart`；工坊 Mod 应在此之前完成注册。
5. 调用 `EscapeBackroomsWorkshop.startGame()`，启动渲染循环和游戏网络初始化。
6. 游戏初始化完成后调用 `window.VibeHubWorkshop.markGameReady()`，再等待 `afterStart`。

外观、音效、规则、地图装饰和道具注册应在启动前完成。HUD 小组件可以在启动后注册，但建议仍在启动前注册以避免闪烁。回合内只通过 `round:start` 创建位置相关道具。

## 5. 公共前置 Mod 与跨阶段依赖

可作为公共前置依赖的内容：

- 只注册公开 ID 的外观包、音效包、规则包、道具包和 HUD 小组件。
- 只通过 `EscapeBackroomsWorkshop.on(...)` 监听事件。
- 只通过 `spawnItem` 创建回合道具，并在 `round:end` 后允许游戏清理。

禁止跨阶段依赖：

- `beforeStart` 不能假设玩家已经进入房间、已经生成迷宫或已经存在怪物。
- `round:start` 不能假设玩家已经逃脱，也不能保存上一局的对象引用。
- `afterStart` 不能要求重新执行启动前注册，也不能阻塞游戏主循环。
- 不要让一个 Mod 通过未声明的全局变量依赖另一个 Mod；若必须依赖，应在 Mod 元数据中声明，并使用稳定 ID。

## 6. 多 Mod 规则

- ID 是命名空间；推荐使用 `作者或 Mod slug.功能`，例如 `alice.medkit`。
- 同一 ID 重复注册会失败，后加载者不能覆盖先加载者。
- 外观和装饰可以叠加；同一位置的视觉冲突由加载顺序决定，但游戏不会替 Mod 自动解决。
- 规则由最后一次显式 `setRule` 决定，作者应避免多个 Mod 同时修改同一规则。
- 道具 ID 冲突、音效 ID 冲突、事件处理器 ID 冲突都会被拒绝。
- Mod 应在注册失败时检查返回值，不应静默继续使用未注册能力。

## 7. 存档、联机和兼容性

- 当前游戏没有 Mod 存档 API；Mod 不应直接写账号存档或房间数据。
- 联机策略为 `mods-disabled`：检测到启用 Mod 时，游戏拒绝创建或加入联机房间；本地练习可以使用 Mod。
- 该策略由游戏依据 `VibeHubWorkshop.getEnabledMods()` 执行，不是平台代码扫描，也不是安全沙箱。平台不会阻止越权 Mod 代码。
- Mod 道具、规则和怪物伤害只保证本地练习一致性，不进入联机快照协议。
- Mod 应声明兼容的游戏版本和 API 版本 `1.0.0`；依赖私有字段的 Mod 不保证兼容。
- 加载顺序由官方 Loader 管理；不要通过 DOM 插入脚本、覆盖 `window.Game` 或重复加载游戏脚本。

## 8. 明确禁止

Mod 不得：

- 读取、导出、上传账号凭据、Token、Cookie、房间密钥或管理接口数据。
- 调用 VibeHub 管理 API、部署 API 或任何未公开给游戏 Mod 的接口。
- 覆盖 `Game.tick`、`Net`、`Player.update`、内部 DOM 事件、Three.js 渲染器或网络消息处理器。
- 修改 `world.maze.grid`、强行改变其他玩家位置、伪造联机事件或绕过 `mods-disabled`。
- 使用无限循环、同步阻塞、跨源私有资源或动态执行远程代码。
- 把本地 Mod 能力描述成平台提供的安全隔离能力。