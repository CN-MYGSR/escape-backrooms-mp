/* ============ Escape Backrooms 创意工坊公开 API ============
 * 这是作者与 Mod 创作者之间的开发约定，不是安全沙箱。
 * 联机策略由游戏设置为 mods-disabled：检测到启用 Mod 时拒绝进入联机房间。
 */
(function () {
  const VERSION = '1.0.0';
  const registries = {
    appearance: new Map(), sounds: new Map(), monsterSounds: new Map(),
    props: new Map(), items: new Map(), rules: new Map(), widgets: new Map(),
  };
  const listeners = new Map();
  const active = { props: [], items: [], round: null, started: false };
  const errors = [];

  function fail(message) {
    errors.push(String(message));
    console.warn('[Workshop]', message);
    return false;
  }
  function validId(id) {
    return typeof id === 'string' && /^[a-z0-9._-]+$/.test(id) && id.length <= 80;
  }
  function add(registry, entry, kind) {
    if (!entry || !validId(entry.id)) return fail(`${kind} requires a stable lowercase id`);
    if (registry.has(entry.id)) return fail(`${kind} id already registered: ${entry.id}`);
    registry.set(entry.id, { ...entry });
    return { id: entry.id, kind };
  }
  function phaseAllowsContent() {
    return !active.started;
  }
  function on(event, id, handler) {
    if (typeof id === 'function') { handler = id; id = `anonymous.${Math.random().toString(36).slice(2)}`; }
    if (typeof handler !== 'function') return fail(`event handler missing: ${event}`);
    const set = listeners.get(event) || new Map();
    if (set.has(id)) return fail(`event handler already registered: ${event}/${id}`);
    set.set(id, handler); listeners.set(event, set);
    return () => set.delete(id);
  }
  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const [id, handler] of set) {
      try { handler(payload); } catch (err) { fail(`${event}/${id}: ${err.stack || err}`); }
    }
  }
  function officialEnabledMods() {
    try {
      const result = window.VibeHubWorkshop && window.VibeHubWorkshop.getEnabledMods;
      const mods = typeof result === 'function' ? result.call(window.VibeHubWorkshop) : [];
      return Array.isArray(mods) ? mods : [];
    } catch (err) { fail(`getEnabledMods failed: ${err.message}`); return []; }
  }
  function itemRecord(itemId) { return registries.items.get(itemId) || null; }
  function worldFor(zone) {
    const game = window.Game;
    return game && game.worlds && game.worlds[zone];
  }
  function defaultItemMesh(item) {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: item.color || 0xc56bff, emissive: item.color || 0x53216f, emissiveIntensity: 0.65,
      roughness: 0.42,
    });
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), material);
    mesh.position.y = 0.55; group.add(mesh);
    return group;
  }
  function disposeObject(object) {
    if (!object) return;
    object.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach((mat) => mat.dispose());
    });
    if (object.parent) object.parent.remove(object);
  }
  function spawnItem(spec) {
    if (!spec || !validId(spec.itemId)) return fail('spawnItem requires a registered itemId');
    const item = itemRecord(spec.itemId);
    const world = worldFor(spec.zone || 0);
    if (!item || !world || !spec.position) return fail(`cannot spawn item: ${spec.itemId}`);
    const group = typeof item.createMesh === 'function'
      ? item.createMesh({ THREE, item, zone: spec.zone || 0, world, api })
      : defaultItemMesh(item);
    if (!group || !group.position) return fail(`item mesh must return a THREE.Object3D: ${spec.itemId}`);
    group.position.set(spec.position.x, spec.position.y || 0, spec.position.z);
    world.group.add(group);
    const record = {
      index: active.items.length, itemId: spec.itemId, zone: spec.zone || 0,
      x: spec.position.x, z: spec.position.z, group, taken: false,
    };
    active.items.push(record);
    return { ...record };
  }
  function nearbyItem(zone, x, z, radius) {
    const limit = radius || 0.95;
    return active.items.find((item) => !item.taken && item.zone === zone && Math.hypot(item.x - x, item.z - z) < limit) || null;
  }
  function takeItem(index, zone) {
    const item = active.items[index];
    if (!item || item.taken || item.zone !== zone) return null;
    item.taken = true; item.group.visible = false;
    return item;
  }
  function contextForItem(itemId, extra) {
    const game = window.Game;
    return {
      ...extra, item: itemRecord(itemId), itemId, Game: game, api,
      player: game && game.player,
      heal(amount) { if (game && game.player) game.player.health = Math.min(100, game.player.health + Math.max(0, amount || 0)); },
      restoreSan(amount) { if (game) game.san = Math.min(100, game.san + Math.max(0, amount || 0)); },
      restoreStamina(amount) { if (game && game.player) game.player.stamina = Math.min(100, game.player.stamina + Math.max(0, amount || 0)); },
      restoreBattery(amount) { if (game && game.player) game.player.battery = Math.min(100, game.player.battery + Math.max(0, amount || 0)); },
      damageMonster(monsterId, amount) { return api.damageMonster(monsterId, amount); },
      message(text, type, duration) { if (window.UI) UI.msg(String(text), type, duration || 2400); },
    };
  }
  function damageMonster(monsterId, amount) {
    const game = window.Game;
    if (!game || !game.solo) return false;
    const target = monsterId === 'smiler' ? game.smiler : monsterId === 'mimic' ? game.mimic : game.humanoid;
    if (!target || !target.group || !Number.isFinite(amount) || amount <= 0) return false;
    target.workshopHealth = Number.isFinite(target.workshopHealth) ? target.workshopHealth - amount : 100 - amount;
    if (target.workshopHealth <= 0) {
      target.group.visible = false;
      target.workshopDisabledUntil = game.time + 8;
      emit('monster:defeated', { monsterId, amount, target });
    }
    return true;
  }
  function applyAppearance(host, context) {
    for (const [id, entry] of registries.appearance) {
      if (typeof entry.create !== 'function') continue;
      try {
        const object = entry.create({ THREE, host, context, api });
        if (object && object !== host && host && host.add) host.add(object);
      } catch (err) { fail(`appearance/${id}: ${err.stack || err}`); }
    }
  }
  function attachProps(zone, world, game) {
    for (const [id, entry] of registries.props) {
      if (!phaseAllowsContent() && !active.round) continue;
      if (Array.isArray(entry.zones) && !entry.zones.includes(zone)) continue;
      if (typeof entry.create !== 'function') continue;
      try {
        const result = entry.create({ THREE, zone, world, game, group: world.group, api });
        if (result && typeof result.dispose === 'function') active.props.push(result);
      } catch (err) { fail(`prop/${id}: ${err.stack || err}`); }
    }
  }
  function mountWidgets() {
    const root = document.getElementById('workshopHud');
    if (!root) return;
    root.replaceChildren();
    for (const [id, entry] of registries.widgets) {
      const element = document.createElement('div');
      element.className = 'workshop-widget';
      element.dataset.workshopId = id;
      root.appendChild(element);
      entry.element = element;
      if (typeof entry.mount === 'function') {
        try { entry.mount(element, { api, Game: window.Game }); } catch (err) { fail(`widget/${id}: ${err.stack || err}`); }
      }
    }
  }
  function updateWidgets(payload) {
    for (const entry of registries.widgets.values()) {
      if (typeof entry.update !== 'function' || !entry.element) continue;
      try { entry.update(entry.element, payload); } catch (err) { fail(`widget update: ${err.stack || err}`); }
    }
  }
  function clearRound() {
    for (const disposable of active.props.splice(0)) { try { disposable.dispose(); } catch (_) {} }
    for (const item of active.items.splice(0)) disposeObject(item.group);
    active.round = null;
  }

  const api = {
    version: VERSION,
    multiplayerPolicy: 'mods-disabled',
    getEnabledMods: officialEnabledMods,
    isMultiplayerAllowed() { return officialEnabledMods().length === 0; },
    errors,
    on,
    emit,
    registerPlayerAppearance(entry) { if (!phaseAllowsContent()) return fail('player appearances must register before start'); return add(registries.appearance, entry, 'appearance'); },
    registerSound(entry) { if (!phaseAllowsContent()) return fail('sounds must register before start'); return add(registries.sounds, entry, 'sound'); },
    registerMonsterSound(entry) { if (!phaseAllowsContent()) return fail('monster sounds must register before start'); return add(registries.monsterSounds, entry, 'monster-sound'); },
    registerProp(entry) { if (!phaseAllowsContent()) return fail('props must register before start'); return add(registries.props, entry, 'prop'); },
    registerItem(entry) { if (!phaseAllowsContent()) return fail('items must register before start'); return add(registries.items, entry, 'item'); },
    registerRule(entry) { if (!phaseAllowsContent()) return fail('rules must register before start'); return add(registries.rules, { ...entry, value: entry.defaultValue }, 'rule'); },
    registerHudWidget(entry) { return add(registries.widgets, entry, 'widget'); },
    setRule(id, value) {
      const rule = registries.rules.get(id);
      if (!rule) return fail(`unknown rule: ${id}`);
      if (rule.min !== undefined && value < rule.min || rule.max !== undefined && value > rule.max) return fail(`rule out of range: ${id}`);
      rule.value = value; return true;
    },
    getRule(id, fallback) { const rule = registries.rules.get(id); return rule && rule.value !== undefined ? rule.value : fallback; },
    playSound(id, options) {
      const sound = registries.sounds.get(id) || registries.monsterSounds.get(id);
      if (!sound || !sound.src) return false;
      const audio = new Audio(sound.src);
      audio.volume = Math.max(0, Math.min(1, options && options.volume !== undefined ? options.volume : (sound.volume === undefined ? 1 : sound.volume)));
      audio.loop = !!(options && options.loop !== undefined ? options.loop : sound.loop);
      audio.play().catch(() => {}); return true;
    },
    spawnItem,
    nearbyItem,
    takeItem,
    getActiveItem(index, zone) { const item = active.items[index]; return item && item.zone === zone ? item : null; },
    getItem: itemRecord,
    useItem(itemId, extra) {
      const item = itemRecord(itemId);
      if (!item || typeof item.onUse !== 'function') return false;
      const result = item.onUse(contextForItem(itemId, extra));
      emit('item:used', { itemId, result });
      return result !== false;
    },
    damageMonster,
    applyAppearance,
    startRound(context) {
      clearRound(); active.round = context; active.started = true;
      attachProps('maze', context.worlds[0], context.game);
      attachProps('garage', context.worlds[1], context.game);
      emit('round:start', context); mountWidgets();
    },
    endRound(context) { emit('round:end', context); clearRound(); },
    startGame() { active.started = true; mountWidgets(); emit('game:start', { Game: window.Game, api }); },
    tick(context) {
      const game = window.Game;
      for (const monster of [game && game.humanoid, game && game.smiler, game && game.mimic]) {
        if (monster && monster.workshopDisabledUntil && game.time >= monster.workshopDisabledUntil) {
          monster.workshopDisabledUntil = 0; monster.workshopHealth = 100; monster.group.visible = true;
        }
      }
      updateWidgets(context); emit('tick', context);
    },
  };

  window.EscapeBackroomsWorkshop = Object.freeze(api);
  window.EscapeBackroomsWorkshopState = active;
})();