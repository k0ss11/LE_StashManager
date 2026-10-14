// StashManager Frida agent (Last Epoch, Unity 6 / IL2CPP).
//
// Read path: plain memory reads (safe from the Frida thread).
// Write path: commands are queued and executed inside UpdateSystem.Update on the game's
// main thread via il2cpp_runtime_invoke (managed exceptions are caught, not fatal).
// Never call managed code from the Frida thread directly - it crashes the game.

'use strict';

const GA = Process.getModuleByName('GameAssembly.dll');
const nf = (n, r, a) => new NativeFunction(GA.getExportByName(n), r, a);

const il2cpp = {
  domain_get: nf('il2cpp_domain_get', 'pointer', []),
  thread_attach: nf('il2cpp_thread_attach', 'pointer', ['pointer']),
  get_assemblies: nf('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']),
  assembly_get_image: nf('il2cpp_assembly_get_image', 'pointer', ['pointer']),
  image_get_name: nf('il2cpp_image_get_name', 'pointer', ['pointer']),
  class_from_name: nf('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']),
  class_get_method_from_name: nf('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']),
  class_get_field_from_name: nf('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']),
  class_get_parent: nf('il2cpp_class_get_parent', 'pointer', ['pointer']),
  field_get_offset: nf('il2cpp_field_get_offset', 'size_t', ['pointer']),
  object_new: nf('il2cpp_object_new', 'pointer', ['pointer']),
  string_new: nf('il2cpp_string_new', 'pointer', ['pointer']),
  runtime_invoke: nf('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']),
  method_get_pointer: m => m.readPointer(),
};

// IL2CPP thread registration for calls made from the Frida thread.
// IMPORTANT: never leave the Frida thread attached. An attached foreign thread keeps the game from
// exiting (Unity waits for it on shutdown). Attach only for the duration of one call, then detach.
const thread_detach = nf('il2cpp_thread_detach', 'void', ['pointer']);
const _tc = GA.findExportByName('il2cpp_thread_current');
const thread_current = _tc ? new NativeFunction(_tc, 'pointer', []) : () => ptr(0);
let scopeDepth = 0;
function il2cppScope(fn) {
  // already attached: game main thread (tick) or a nested scope
  if (scopeDepth > 0 || !thread_current().isNull()) return fn();
  const t = il2cpp.thread_attach(il2cpp.domain_get());
  scopeDepth++;
  try { return fn(); } finally { scopeDepth--; thread_detach(t); }
}

// ---------------------------------------------------------------- metadata helpers

const images = {};
il2cppScope(function loadImages() {
  const size = Memory.alloc(8);
  const arr = il2cpp.get_assemblies(il2cpp.domain_get(), size);
  for (let i = 0; i < size.readU32(); i++) {
    const img = il2cpp.assembly_get_image(arr.add(i * 8).readPointer());
    images[il2cpp.image_get_name(img).readUtf8String()] = img;
  }
});

const classCache = {};
function cls(name, ns = '', image = 'LE.dll') {
  const key = image + '|' + ns + '|' + name;
  if (!classCache[key]) {
    const k = il2cpp.class_from_name(images[image], Memory.allocUtf8String(ns), Memory.allocUtf8String(name));
    if (k.isNull()) throw new Error('class not found: ' + ns + '.' + name);
    classCache[key] = k;
  }
  return classCache[key];
}

// Field offset by name, searching parent classes too.
const fieldCache = {};
function off(klass, name) {
  const key = klass + '|' + name;
  if (fieldCache[key] === undefined) {
    let k = klass, f = ptr(0);
    while (!k.isNull() && (f = il2cpp.class_get_field_from_name(k, Memory.allocUtf8String(name))).isNull())
      k = il2cpp.class_get_parent(k);
    if (f.isNull()) throw new Error('field not found: ' + name);
    fieldCache[key] = Number(il2cpp.field_get_offset(f));
  }
  return fieldCache[key];
}

function method(klass, name, argc) {
  const m = il2cpp.class_get_method_from_name(klass, Memory.allocUtf8String(name), argc);
  if (m.isNull()) throw new Error('method not found: ' + name + '/' + argc);
  return m;
}

const staticBase = klass => klass.add(0xB8).readPointer();

// Overload-safe lookup: non-generic method whose parameter types match exactly (type names).
function methodExact(klass, name, paramTypes) {
  const getMethods = nf('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
  const mName = nf('il2cpp_method_get_name', 'pointer', ['pointer']);
  const mCount = nf('il2cpp_method_get_param_count', 'uint32', ['pointer']);
  const mParam = nf('il2cpp_method_get_param', 'pointer', ['pointer', 'uint32']);
  const isGeneric = nf('il2cpp_method_is_generic', 'bool', ['pointer']);
  const tName = nf('il2cpp_type_get_name', 'pointer', ['pointer']);
  const it = Memory.alloc(8); it.writePointer(ptr(0));
  let m;
  while (!(m = getMethods(klass, it)).isNull()) {
    if (mName(m).readUtf8String() !== name || mCount(m) !== paramTypes.length || isGeneric(m)) continue;
    if (paramTypes.every((t, i) => tName(mParam(m, i)).readUtf8String() === t)) return m;
  }
  throw new Error('method not found: ' + name + '(' + paramTypes.join(', ') + ')');
}

// ---------------------------------------------------------------- memory readers

const readStr = p => {
  if (p.isNull()) return null;
  const len = p.add(0x10).readS32();
  return len > 0 && len < 4096 ? p.add(0x14).readUtf16String(len) : '';
};
const readList = p => {
  if (p.isNull()) return [];
  const items = p.add(0x10).readPointer();
  const n = p.add(0x18).readS32();
  if (items.isNull() || n < 0 || n > 100000) return [];
  const r = [];
  for (let i = 0; i < n; i++) r.push(items.add(0x20 + i * 8).readPointer());
  return r;
};
const readArray = p => {
  if (p.isNull()) return [];
  const n = p.add(0x18).readS32();
  const r = [];
  for (let i = 0; i < n && i < 100000; i++) r.push(p.add(0x20 + i * 8).readPointer());
  return r;
};
const readBytes = p => {
  if (p.isNull()) return [];
  const n = p.add(0x18).readS32();
  return n > 0 && n < 4096 ? Array.from(new Uint8Array(p.add(0x20).readByteArray(n))) : [];
};

// ---------------------------------------------------------------- game objects

const C = {
  get ICM() { return cls('ItemContainersManager'); },
  get LocalPlayer() { return cls('LocalPlayer'); },
  get PlayerSync() { return cls('PlayerSync'); },
  get UIBase() { return cls('UIBase'); },
  get StashPriority() { return cls('StashPriority'); },
};

const ContainerID = { INVENTORY: 1, CURSOR: 19, STASH: 21 };

function icmInstance() {
  return staticBase(C.ICM).add(off(C.ICM, '_instance')).readPointer();
}
function stashHolder() {
  const icm = icmInstance();
  return icm.isNull() ? ptr(0) : icm.add(off(C.ICM, 'stash')).readPointer();
}
function activeStashContainer() {
  const holder = stashHolder();
  const kHolder = cls('StashHolderItemContainer');
  const idx = holder.add(off(kHolder, '<CurrentStashIndex>k__BackingField')).readS32();
  return readArray(holder.add(off(kHolder, 'stashItemContainers')).readPointer())[idx];
}
function playerSyncLocal() {
  return staticBase(C.PlayerSync).add(off(C.PlayerSync, 'local')).readPointer();
}
function clientStashInfo() {
  const lp = staticBase(C.LocalPlayer).add(off(C.LocalPlayer, 'instance')).readPointer();
  return lp.isNull() ? ptr(0) : lp.add(off(C.LocalPlayer, 'stashInfo')).readPointer();
}

function readItem(entry) {
  const kEntry = cls('ItemContainerEntry');
  const kData = cls('ItemData');
  const kAffix = cls('ItemAffix');
  const kUnpacked = cls('ItemDataUnpacked');
  const d = entry.add(off(kEntry, 'data')).readPointer();
  const pos = entry.add(off(kEntry, '<Position>k__BackingField'));
  const size = entry.add(off(kEntry, 'size'));
  const item = {
    x: pos.readS32(), y: pos.add(4).readS32(),
    w: size.readS32(), h: size.add(4).readS32(),
    qty: entry.add(off(kEntry, 'quantity')).readS32(),
  };
  if (d.isNull()) return item;
  Object.assign(item, {
    type: d.add(off(kData, 'itemType')).readU8(),
    subType: d.add(off(kData, 'subType')).readU16(),
    rarity: d.add(off(kData, 'rarity')).readU8(),
    uniqueId: d.add(off(kData, 'uniqueID')).readU16(),
    corrupted: d.add(off(kData, 'corrupted')).readU8() !== 0,
    fp: d.add(off(kData, 'forgingPotential')).readU8(),
    lp: d.add(off(kData, 'legendaryPotential')).readU8(),
    ww: d.add(off(kData, 'weaversWill')).readU8(),
    implicitRolls: readBytes(d.add(off(kData, 'implicitRolls')).readPointer()),
    uniqueRolls: readBytes(d.add(off(kData, 'uniqueRolls')).readPointer()),
    id: readBytes(d.add(off(kData, 'id')).readPointer()).map(b => b.toString(16).padStart(2, '0')).join(''),
    affixes: readList(d.add(off(kData, 'affixes')).readPointer()).map(a => ({
      id: a.add(off(kAffix, 'affixId')).readU16(),
      tier: a.add(off(kAffix, 'affixTier')).readU8() + 1,
      roll: a.add(off(kAffix, 'affixRoll')).readU8(),
      name: readStr(a.add(off(kAffix, 'affixName')).readPointer()),
      sealed: a.add(off(kAffix, 'sealedAffixType')).readS32(),
    })),
  });
  // Name is cached lazily by the game; only present after the item was displayed.
  try { item.name = readStr(d.add(off(kUnpacked, '_fullName')).readPointer()); } catch (e) {}
  try { item.lvlReq = d.add(off(kUnpacked, '<LvlReq>k__BackingField')).readS32(); } catch (e) {}
  return item;
}

function readContainerItems(container) {
  const kIC = cls('ItemContainer');
  return readList(container.add(off(kIC, 'content')).readPointer()).map(e => {
    try { return readItem(e); } catch (err) { return { error: String(err) }; }
  });
}

// ---------------------------------------------------------------- stash priority (auto-stash rules)
//
// StashPriority holds 8 optional condition objects (null = condition unused). The game's
// "Tab Priority" checkbox is simply StashPriority.HasValue(): an all-empty priority is stored as null.

const PRIO_FIELDS = {
  potential: ['PotentialStashPriorityCondition', '<PotentialStashPriority>k__BackingField'],
  rarity: ['RarityStashPriorityCondition', '<RarityStashPriority>k__BackingField'],
  type: ['TypeStashPriorityCondition', '<TypeStashPriority>k__BackingField'],
  classReq: ['ClassStashPriorityCondition', '<ClassStashPriority>k__BackingField'],
  level: ['LevelStashPriorityCondition', '<LevelStashPriority>k__BackingField'],
  faction: ['FactionStashPriorityCondition', '<FactionStashPriority>k__BackingField'],
  uniques: ['UniquesStashPriorityCondition', '<UniquesStashPriority>k__BackingField'],
  corruption: ['CorruptionStashPriorityCondition', '<CorruptionStashPriority>k__BackingField'],
};
const POTENTIAL_KEYS = ['MinLegendaryPotential', 'MaxLegendaryPotential', 'MinWeaversWill', 'MaxWeaversWill',
  'MinWeaversTouch', 'MaxWeaversTouch', 'MinForgingPotential', 'MaxForgingPotential'];

const klassOf = obj => obj.readPointer();
const readNullable = p => p.readU8() ? p.add(4).readS32() : null;
const writeNullable = (p, v) => {
  if (v === null || v === undefined || v === '') { p.writeU8(0); p.add(4).writeS32(0); }
  else { p.writeU8(1); p.add(4).writeS32(+v); }
};

// HashSet<T> (Unity System.Core): _slots = Slot{int hashCode; int next; T value}[], used up to _lastIndex
function readHashSet(set, valueSize) {
  if (set.isNull()) return [];
  const k = klassOf(set);
  const slots = set.add(off(k, '_slots')).readPointer();
  const last = set.add(off(k, '_lastIndex')).readS32();
  const out = [];
  for (let i = 0; i < last; i++) {
    const slot = slots.add(0x20 + i * 12);
    if (slot.readS32() < 0) continue; // free slot
    out.push(valueSize === 2 ? slot.add(8).readU16() : slot.add(8).readS32());
  }
  return out;
}

function readPriority(prio) {
  if (prio.isNull()) return null;
  const kP = C.StashPriority;
  const cond = key => prio.add(off(kP, PRIO_FIELDS[key][1])).readPointer();
  const out = {};
  let c;
  if (!(c = cond('potential')).isNull()) {
    const k = klassOf(c);
    out.potential = Object.fromEntries(POTENTIAL_KEYS.map(n => [n, readNullable(c.add(off(k, n)))]));
  }
  if (!(c = cond('rarity')).isNull()) out.rarity = c.add(off(klassOf(c), 'rarity')).readS32();
  if (!(c = cond('type')).isNull()) {
    const k = klassOf(c);
    out.type = { types: readHashSet(c.add(off(k, 'type')).readPointer(), 4),
                 subTypes: readHashSet(c.add(off(k, 'subTypes')).readPointer(), 4) };
  }
  if (!(c = cond('classReq')).isNull()) out.classReq = c.add(off(klassOf(c), 'req')).readS32();
  if (!(c = cond('level')).isNull()) {
    const k = klassOf(c);
    out.level = { min: readNullable(c.add(off(k, '<MinLevel>k__BackingField'))),
                  max: readNullable(c.add(off(k, '<MaxLevel>k__BackingField'))) };
  }
  if (!(c = cond('faction')).isNull()) {
    const list = c.add(off(klassOf(c), 'EligibleFactions')).readPointer();
    out.faction = list.isNull() ? [] : (() => {
      const items = list.add(0x10).readPointer(), n = list.add(0x18).readS32(), r = [];
      for (let i = 0; i < n; i++) r.push(items.add(0x20 + i * 4).readS32());
      return r;
    })();
  }
  if (!(c = cond('uniques')).isNull()) out.uniques = readHashSet(c.add(off(klassOf(c), 'uniqueIds')).readPointer(), 2);
  if (!(c = cond('corruption')).isNull()) out.corruption = c.add(off(klassOf(c), 'Corruption')).readS32();
  return out;
}

// Main thread only. spec: same shape as readPriority() output; missing/null keys = condition unused.
function buildPriority(spec) {
  const prio = il2cpp.object_new(C.StashPriority);
  invoke(method(C.StashPriority, '.ctor', 0), prio, []);
  if (!spec) return prio;
  const fieldClass = nf('il2cpp_field_get_type', 'pointer', ['pointer']);
  const classFromType = nf('il2cpp_class_from_type', 'pointer', ['pointer']);

  const make = key => {
    const k = cls(PRIO_FIELDS[key][0]);
    const o = il2cpp.object_new(k);
    invoke(method(k, '.ctor', 0), o, []);
    prio.add(off(C.StashPriority, PRIO_FIELDS[key][1])).writePointer(o);
    return o;
  };
  // collection field: create with its default ctor if the condition's ctor left it null
  const collection = (obj, name) => {
    const k = klassOf(obj);
    let col = obj.add(off(k, name)).readPointer();
    if (col.isNull()) {
      let kk = k, fld = ptr(0);
      while (!kk.isNull() && (fld = il2cpp.class_get_field_from_name(kk, Memory.allocUtf8String(name))).isNull())
        kk = il2cpp.class_get_parent(kk);
      const colClass = classFromType(fieldClass(fld));
      col = il2cpp.object_new(colClass);
      invoke(method(colClass, '.ctor', 0), col, []);
      obj.add(off(k, name)).writePointer(col);
    }
    return col;
  };
  const addAll = (col, values, size) => {
    const add = method(klassOf(col), 'Add', 1);
    for (const v of values) {
      const p = Memory.alloc(4);
      if (size === 2) p.writeU16(v); else p.writeS32(v);
      invoke(add, col, [p]);
    }
  };

  if (spec.potential && Object.values(spec.potential).some(v => v !== null && v !== '')) {
    const o = make('potential'), k = klassOf(o);
    for (const n of POTENTIAL_KEYS) writeNullable(o.add(off(k, n)), spec.potential[n]);
  }
  if (spec.rarity) { const o = make('rarity'); o.add(off(klassOf(o), 'rarity')).writeS32(spec.rarity); }
  if (spec.type && ((spec.type.types || []).length || (spec.type.subTypes || []).length)) {
    const o = make('type');
    addAll(collection(o, 'type'), spec.type.types || [], 4);
    addAll(collection(o, 'subTypes'), spec.type.subTypes || [], 4);
  }
  if (spec.classReq) { const o = make('classReq'); o.add(off(klassOf(o), 'req')).writeS32(spec.classReq); }
  if (spec.level && (spec.level.min != null || spec.level.max != null)) {
    const o = make('level'), k = klassOf(o);
    writeNullable(o.add(off(k, '<MinLevel>k__BackingField')), spec.level.min);
    writeNullable(o.add(off(k, '<MaxLevel>k__BackingField')), spec.level.max);
  }
  if (spec.faction && spec.faction.length) addAll(collection(make('faction'), 'EligibleFactions'), spec.faction, 4);
  if (spec.uniques && spec.uniques.length) addAll(collection(make('uniques'), 'uniqueIds'), spec.uniques, 2);
  if (spec.corruption) { const o = make('corruption'); o.add(off(klassOf(o), 'Corruption')).writeS32(spec.corruption); }
  return prio;
}

function readStashMeta() {
  const si = clientStashInfo();
  if (si.isNull()) return { categories: [], tabs: [] };
  const kSI = cls('ClientStashInfo');
  const kCat = cls('StashCategory', 'LE.Data');
  const kTab = cls('StashTab', 'LE.Data');
  return {
    categories: readList(si.add(off(kSI, 'categories')).readPointer()).map(c => ({
      id: c.add(off(kCat, '_categoryId')).readS32(),
      icon: c.add(off(kCat, '_iconId')).readS32(),
      color: c.add(off(kCat, '_colorId')).readS32(),
      name: readStr(c.add(off(kCat, '_displayName')).readPointer()),
      order: c.add(off(kCat, '_displayOrder')).readS32(),
      hasPriority: !c.add(off(kCat, '_folderPriority')).readPointer().isNull(),
      priority: readPriority(c.add(off(kCat, '_folderPriority')).readPointer()),
    })),
    tabs: readList(si.add(off(kSI, 'tabs')).readPointer()).map(t => ({
      id: t.add(off(kTab, '_tabId')).readS32(),
      categoryId: t.add(off(kTab, '_categoryId')).readS32(),
      icon: t.add(off(kTab, '_iconId')).readS32(),
      color: t.add(off(kTab, '_colorId')).readS32(),
      name: readStr(t.add(off(kTab, '_displayName')).readPointer()),
      order: t.add(off(kTab, 'DisplayOrder')).readS32(),
      hasPriority: !t.add(off(kTab, '_tabPriority')).readPointer().isNull(),
      priority: readPriority(t.add(off(kTab, '_tabPriority')).readPointer()),
      ignoreFolderPriority: t.add(off(kTab, '_ignoreFolderPriority')).readU8() !== 0,
    })),
  };
}

function snapshot(withItems) {
  const holder = stashHolder();
  if (holder.isNull()) return { ok: false, error: 'not in game (no ItemContainersManager)' };
  const kHolder = cls('StashHolderItemContainer');
  const kTabbed = cls('TabbedItemContainer');
  const kIC = cls('ItemContainer');
  const stashIndex = holder.add(off(kHolder, '<CurrentStashIndex>k__BackingField')).readS32();
  const stashes = readArray(holder.add(off(kHolder, 'stashItemContainers')).readPointer());
  const sc = stashes[stashIndex];
  const out = {
    ok: true, stashIndex, stashCount: stashes.length,
    stashOpen: state.stashOpen, cursorItem: null,
    activeTab: -1, containers: [], ...readStashMeta(),
  };
  if (sc && !sc.isNull()) {
    out.activeTab = sc.add(off(kTabbed, 'currentlyActiveTab')).readS32();
    out.containers = readList(sc.add(off(kTabbed, 'containers')).readPointer()).map((c, i) => {
      const size = c.add(off(kIC, 'size'));
      const r = { index: i, w: size.readS32(), h: size.add(4).readS32() };
      if (withItems) r.items = readContainerItems(c);
      else r.count = readList(c.add(off(kIC, 'content')).readPointer()).length;
      return r;
    });
  }
  const icm = icmInstance();
  const cursor = icm.add(off(C.ICM, 'cursor')).readPointer();
  if (!cursor.isNull()) {
    // OneSlotItemContainer: single ItemContainerEntry, not a list.
    const entry = cursor.add(off(cls('OneSlotItemContainer'), 'content')).readPointer();
    out.cursorItem = entry.isNull() ? null : readItem(entry);
  }
  // ItemContainersManager.goldTracker is server-side only; client has it on LocalPlayer.
  const lp = staticBase(C.LocalPlayer).add(off(C.LocalPlayer, 'instance')).readPointer();
  const gold = lp.isNull() ? ptr(0) : lp.add(off(C.LocalPlayer, 'goldTracker')).readPointer();
  out.gold = gold.isNull() ? null : gold.add(off(cls('GoldTracker'), 'value')).readS32();
  const inv = icm.add(off(C.ICM, 'inventory')).readPointer();
  if (withItems && !inv.isNull()) out.inventory = readContainerItems(inv);
  if (!inv.isNull()) {
    const sz = inv.add(off(kIC, 'size'));
    out.inventorySize = [sz.readS32(), sz.add(4).readS32()];
  }
  return out;
}

// ---------------------------------------------------------------- game databases

// Static game data (bases, subtypes, uniques, affixes with tier ranges). Read from the
// GlobalAssets master lists; if not loaded yet, the main-thread 'loadMasterLists' op loads them.
function masterList(name) {
  const k = cls('GlobalAssets', 'LE.AssetManagement');
  return staticBase(k).add(off(k, '_storage_' + name)).readPointer();
}

function readGameData() {
  const items = masterList('MasterItemsList');
  const affixes = masterList('MasterAffixesList');
  const uniques = staticBase(cls('UniqueList')).add(off(cls('UniqueList'), 'instance')).readPointer();
  if (items.isNull() || affixes.isNull() || uniques.isNull())
    return { ok: false, missing: { items: items.isNull(), affixes: affixes.isNull(), uniques: uniques.isNull() } };
  return { ok: true, build: GA.size, ...readItemList(items), uniques: readUniques(uniques), affixes: readAffixes(affixes) };
}

function nested(outer, inner) {
  // il2cpp_class_from_name does not resolve nested types; walk declaring type's nested list.
  const key = 'nested|' + outer + '|' + inner;
  if (!classCache[key]) {
    const it = Memory.alloc(8); it.writePointer(ptr(0));
    const getNested = nf('il2cpp_class_get_nested_types', 'pointer', ['pointer', 'pointer']);
    const getName = nf('il2cpp_class_get_name', 'pointer', ['pointer']);
    let k;
    while (!(k = getNested(cls(outer), it)).isNull())
      if (getName(k).readUtf8String() === inner) { classCache[key] = k; break; }
    if (!classCache[key]) throw new Error('nested class not found: ' + outer + '/' + inner);
  }
  return classCache[key];
}

function readItemList(il) {
  const kIL = cls('ItemList');
  const kBase = nested('ItemList', 'BaseItem');
  const kBaseEq = nested('ItemList', 'BaseEquipmentItem');
  const kBaseNon = nested('ItemList', 'BaseNonEquipmentItem');
  const kSub = nested('ItemList', 'SubItem');
  const kEqItem = nested('ItemList', 'EquipmentItem');
  const sub = (s, withClass) => {
    const r = {
      id: s.add(off(kSub, 'subTypeID')).readS32(),
      name: readStr(s.add(off(kSub, 'name')).readPointer()),
      display: readStr(s.add(off(kSub, 'displayName')).readPointer()),
      lvl: s.add(off(kSub, 'levelRequirement')).readS32(),
    };
    if (withClass) r.classReq = s.add(off(kEqItem, 'classRequirement')).readS32();
    return r;
  };
  const base = (b, eq) => {
    const grid = b.add(off(kBase, 'gridSize'));
    return {
      id: b.add(off(kBase, 'baseTypeID')).readS32(),
      name: readStr(b.add(off(kBase, 'BaseTypeName')).readPointer()),
      display: readStr(b.add(off(kBase, 'displayName')).readPointer()),
      w: grid.readS32(), h: grid.add(4).readS32(),
      equippable: eq,
      subs: readList(b.add(off(eq ? kBaseEq : kBaseNon, 'subItems')).readPointer()).map(s => sub(s, eq)),
    };
  };
  return {
    bases: readArray(il.add(off(kIL, 'EquippableItems')).readPointer()).map(b => base(b, true))
      .concat(readArray(il.add(off(kIL, 'nonEquippableItems')).readPointer()).map(b => base(b, false))),
  };
}

function readUniques(ul) {
  const kUL = cls('UniqueList');
  const kE = nested('UniqueList', 'Entry');
  return readList(ul.add(off(kUL, 'uniques')).readPointer()).map(e => ({
    id: e.add(off(kE, 'uniqueID')).readU16(),
    name: readStr(e.add(off(kE, 'name')).readPointer()),
    display: readStr(e.add(off(kE, 'displayName')).readPointer()),
    isSet: e.add(off(kE, 'isSetItem')).readU8() !== 0,
    setId: e.add(off(kE, 'setID')).readU8(),
    baseType: e.add(off(kE, 'baseType')).readU8(),
    legendaryType: e.add(off(kE, 'legendaryType')).readS32(),
    hidden: e.add(off(kE, 'hideFromPlayers')).readU8() !== 0,
  }));
}

function readAffixes(al) {
  const kAL = cls('AffixList');
  const kA = nested('AffixList', 'Affix');
  const kT = nested('AffixList', 'Tier');
  const one = a => ({
    id: a.add(off(kA, 'affixId')).readS32(),
    name: readStr(a.add(off(kA, 'affixName')).readPointer()),
    display: readStr(a.add(off(kA, 'affixDisplayName')).readPointer()),
    title: readStr(a.add(off(kA, 'affixTitle')).readPointer()),
    type: a.add(off(kA, 'type')).readS32(),                    // AffixList.AffixType
    special: a.add(off(kA, 'specialAffixType')).readS32(),
    classSpec: a.add(off(kA, 'classSpecificity')).readS32(),
    rollsOn: a.add(off(kA, 'rollsOn')).readS32(),
    lvl: a.add(off(kA, 'levelRequirement')).readS32(),
    tiers: readList(a.add(off(kA, 'tiers')).readPointer())
      .map(t => [t.add(off(kT, 'minRoll')).readFloat(), t.add(off(kT, 'maxRoll')).readFloat()]),
  });
  const kSingle = nested('AffixList', 'SingleAffix');
  return readArray(al.add(off(kAL, 'singleAffixes')).readPointer())
    .map(a => Object.assign(one(a), { modType: a.add(off(kSingle, 'modifierType')).readS32() })) // BaseStats.ModType

    .concat(readArray(al.add(off(kAL, 'multiAffixes')).readPointer()).map(a => Object.assign(one(a), { multi: true })));
}

// ---------------------------------------------------------------- main-thread invoke

const exc = Memory.alloc(8);
function invoke(m, obj, args) {
  // args: array of NativePointer (already pointing to value or object)
  const argv = Memory.alloc(Math.max(8, args.length * 8));
  args.forEach((a, i) => argv.add(i * 8).writePointer(a));
  exc.writePointer(ptr(0));
  const r = il2cpp.runtime_invoke(m, obj, argv, exc);
  if (!exc.readPointer().isNull()) throw new Error('managed exception in ' + m);
  return r;
}
const i32 = v => { const p = Memory.alloc(4); p.writeS32(v); return p; };
const bool = v => { const p = Memory.alloc(4); p.writeU8(v ? 1 : 0); return p; };
const v2i = (x, y) => { const p = Memory.alloc(8); p.writeS32(x); p.add(4).writeS32(y); return p; };
const str = s => il2cpp.string_new(Memory.allocUtf8String(s));

function newStashPriority() {
  const o = il2cpp.object_new(C.StashPriority);
  invoke(method(C.StashPriority, '.ctor', 0), o, []);
  return o;
}

function findTabObj(tabId) {
  const si = clientStashInfo();
  const kSI = cls('ClientStashInfo');
  const kTab = cls('StashTab', 'LE.Data');
  return readList(si.add(off(kSI, 'tabs')).readPointer())
    .find(t => t.add(off(kTab, '_tabId')).readS32() === tabId) || null;
}
function findCatObj(catId) {
  const si = clientStashInfo();
  const kSI = cls('ClientStashInfo');
  const kCat = cls('StashCategory', 'LE.Data');
  return readList(si.add(off(kSI, 'categories')).readPointer())
    .find(c => c.add(off(kCat, '_categoryId')).readS32() === catId) || null;
}

// Each op runs on the main thread. Returns a plain value or throws.
const ops = {
  ping: () => 'pong',

  // Force-load the master lists through their getters (main thread only).
  loadMasterLists: () => {
    const k = cls('GlobalAssets', 'LE.AssetManagement');
    invoke(method(k, 'get_MasterItemsList', 0), ptr(0), []);
    invoke(method(k, 'get_MasterAffixesList', 0), ptr(0), []);
  },

  // Same path as clicking a tab: switches client container and notifies the server.
  switchTab: ({ tabId }) => {
    const kTabbed = cls('TabbedItemContainer');
    const boxed = invoke(method(kTabbed, 'TrySwitchToTab', 2), activeStashContainer(), [i32(tabId), bool(true)]);
    return !boxed.isNull() && boxed.add(0x10).readU8() !== 0;
  },
  pickup: ({ container = ContainerID.STASH, x, y }) => {
    invoke(method(C.PlayerSync, 'SendPickupItemToCursor', 2), playerSyncLocal(), [i32(container), v2i(x, y)]);
  },
  drop: ({ container = ContainerID.STASH, x, y }) => {
    // positionInInventory = destination; no swap.
    invoke(method(C.PlayerSync, 'SendTryDropItemFromCursor', 5), playerSyncLocal(),
      [i32(container), v2i(x, y), bool(false), v2i(x, y), v2i(-1, -1)]);
  },
  returnCursor: () => {
    invoke(method(C.PlayerSync, 'SendTryReturnCursorItemToSource', 0), playerSyncLocal(), []);
  },
  quickMove: ({ src, dst, x, y }) => {
    invoke(method(C.PlayerSync, 'SendTryManualQuickMove', 3), playerSyncLocal(), [i32(src), i32(dst), v2i(x, y)]);
  },
  sortTab: ({ tabId }) => {
    invoke(method(C.PlayerSync, 'SendStashSort', 2), playerSyncLocal(), [i32(state.stashIndex), i32(tabId)]);
  },
  categoryCreate: ({ name }) => {
    invoke(method(C.PlayerSync, 'SendStashCategoryCreate', 2), playerSyncLocal(), [i32(state.stashIndex), str(name)]);
  },
  categoryConfigure: ({ id, name, icon, color, priority }) => {
    const kCat = cls('StashCategory', 'LE.Data');
    const cur = findCatObj(id);
    if (!cur) throw new Error('no category ' + id);
    let prio = priority !== undefined ? buildPriority(priority) : cur.add(off(kCat, '_folderPriority')).readPointer();
    if (prio.isNull()) prio = newStashPriority();
    invoke(method(C.PlayerSync, 'SendStashCategoryConfigure', 6), playerSyncLocal(), [
      i32(state.stashIndex), i32(id),
      i32(icon ?? cur.add(off(kCat, '_iconId')).readS32()),
      i32(color ?? cur.add(off(kCat, '_colorId')).readS32()),
      str(name ?? readStr(cur.add(off(kCat, '_displayName')).readPointer())),
      prio,
    ]);
  },
  categoryDelete: ({ id }) => {
    invoke(method(C.PlayerSync, 'SendStashCategoryDelete', 2), playerSyncLocal(), [i32(state.stashIndex), i32(id)]);
  },
  categoryReorder: ({ id, order }) => {
    invoke(method(C.PlayerSync, 'SendStashCategoryReorder', 3), playerSyncLocal(), [i32(state.stashIndex), i32(id), i32(order)]);
  },
  tabConfigure: ({ id, name, icon, color, parentId, ignoreFolderPriority, priority }) => {
    const kTab = cls('StashTab', 'LE.Data');
    const cur = findTabObj(id);
    if (!cur) throw new Error('no tab ' + id);
    let prio = priority !== undefined ? buildPriority(priority) : cur.add(off(kTab, '_tabPriority')).readPointer();
    if (prio.isNull()) prio = newStashPriority();
    invoke(method(C.PlayerSync, 'SendStashTabConfigure', 8), playerSyncLocal(), [
      i32(state.stashIndex), i32(id),
      i32(icon ?? cur.add(off(kTab, '_iconId')).readS32()),
      i32(color ?? cur.add(off(kTab, '_colorId')).readS32()),
      i32(parentId ?? cur.add(off(kTab, '_categoryId')).readS32()),
      str(name ?? readStr(cur.add(off(kTab, '_displayName')).readPointer())),
      prio,
      bool(ignoreFolderPriority ?? (cur.add(off(kTab, '_ignoreFolderPriority')).readU8() !== 0)),
    ]);
  },
  tabUpdateParent: ({ id, parentId }) => {
    invoke(method(C.PlayerSync, 'SendStashTabUpdateParent', 3), playerSyncLocal(), [i32(state.stashIndex), i32(id), i32(parentId)]);
  },
  tabReorder: ({ id, order }) => {
    invoke(method(C.PlayerSync, 'SendStashTabReorder', 3), playerSyncLocal(), [i32(state.stashIndex), i32(id), i32(order)]);
  },
  // Resolve item icons to (bundle file, object index) via the game's own lookup + asset catalog.
  // reqs: [{ type, sub, unique, uniqueId }]. No asset loading happens here.
  iconRefs: ({ reqs }) => {
    const getSprite = method(cls('ItemData'), 'GetItemSprite', 5);
    const kSoft = cls('SoftRef', 'LE.AssetBundles', 'LE.Addressables.dll');
    const kMgr = cls('AssetBundlesManager', 'LE.AssetBundles', 'LE.Addressables.dll');
    const kCat = cls('LEAssetBundlesCatalog', '', 'LE.Addressables.dll');
    const mgr = staticBase(kMgr).add(off(kMgr, '_instance')).readPointer();
    const catalog = mgr.add(off(kMgr, 'catalog')).readPointer();
    const getLoc = method(kCat, 'GetObjectLocation', 2);
    const getFile = method(kCat, 'GetBundleFileName', 1);
    const u8 = v => { const p = Memory.alloc(4); p.writeU8(v); return p; };
    const u16 = v => { const p = Memory.alloc(4); p.writeU16(v); return p; };
    return reqs.map(r => {
      try {
        const soft = invoke(getSprite, ptr(0), [u8(r.type), u16(r.sub), bool(!!r.unique), u16(r.uniqueId || 0), i32(0)]);
        if (soft.isNull()) return null;
        const guid = soft.add(off(kSoft, 'guid'));
        const subPathObj = soft.add(off(kSoft, 'subPath')).readPointer();
        const loc = invoke(getLoc, catalog, [guid, subPathObj]); // boxed ValueTuple<BundleId, BundledObjectIndex>
        const bundleId = loc.add(0x10).readU16(), objIndex = loc.add(0x12).readU16();
        const file = readStr(invoke(getFile, catalog, [u16(bundleId)]));
        return {
          guid: guid.readU64().toString(16) + ':' + guid.add(8).readU64().toString(16),
          subPath: readStr(subPathObj), bundleId, objIndex, file,
        };
      } catch (e) { return { error: String(e) }; }
    });
  },
  // Tab colour palette + icon sprite names from the stash UI component (main thread: uses FindObjectsOfType).
  tabStyles: () => {
    const kObj = cls('Object', 'UnityEngine', 'UnityEngine.CoreModule.dll');
    const kRes = cls('Resources', 'UnityEngine', 'UnityEngine.CoreModule.dll');
    const typeOf = k => nf('il2cpp_type_get_object', 'pointer', ['pointer'])(nf('il2cpp_class_get_type', 'pointer', ['pointer'])(k));
    const findAll = methodExact(kRes, 'FindObjectsOfTypeAll', ['System.Type']); // includes inactive
    // new UI first (NewStashTabbedUIControls), legacy StashTabbedUIControls as fallback
    for (const [name, colorsField, iconsField] of [['NewStashTabbedUIControls', '_tabColors', '_tabIcons'],
                                                   ['StashTabbedUIControls', 'tabColors', 'tabIcons']]) {
      const k = cls(name);
      const ctl = readArray(invoke(findAll, ptr(0), [typeOf(k)])).find(p => !p.isNull());
      if (!ctl) continue;
      const colorsList = ctl.add(off(k, colorsField)).readPointer();
      const colors = [];
      const items = colorsList.add(0x10).readPointer(), n = colorsList.add(0x18).readS32();
      for (let i = 0; i < n; i++) {
        const c = items.add(0x20 + i * 16);
        colors.push([c.readFloat(), c.add(4).readFloat(), c.add(8).readFloat(), c.add(12).readFloat()]);
      }
      const getName = method(kObj, 'get_name', 0);
      const icons = readList(ctl.add(off(k, iconsField)).readPointer())
        .map(sp => sp.isNull() ? null : readStr(invoke(getName, sp, [])));
      return { source: name, colors, icons };
    }
    throw new Error('stash UI component not found');
  },
  // Gold cost of buying `count` more tabs (game formula, tab by tab).
  tabCosts: ({ count }) => {
    const tabs = readStashMeta().tabs.length;
    const m = method(cls('StashHelpers'), 'NextTabCost', 1);
    const costs = [];
    for (let i = 0; i < count; i++) costs.push(invoke(m, ptr(0), [i32(tabs + i)]).add(0x10).readS32());
    return costs;
  },
  // Gold cost of the next tab given the current tab count (game formula).
  nextTabCost: () => {
    const tabs = readStashMeta().tabs.length;
    const boxed = invoke(method(cls('StashHelpers'), 'NextTabCost', 1), ptr(0), [i32(tabs)]);
    return boxed.add(0x10).readS32();
  },
  // Costs gold and tabs cannot be deleted - host must require explicit confirmation.
  tabPurchase: ({ parentId, order, name, copyFromTabId = -1 }) => {
    invoke(method(C.PlayerSync, 'SendStashTabPurchase', 5), playerSyncLocal(),
      [i32(state.stashIndex), i32(parentId), i32(order), str(name), i32(copyFromTabId)]);
  },
};

// ---------------------------------------------------------------- queue + tick

const state = { stashOpen: null, stashIndex: 0, lastTick: 0, ticks: 0 };
const queue = [];
const results = {};
let nextId = 1;
let notBefore = 0;

function refreshState() {
  const holder = stashHolder();
  if (!holder.isNull())
    state.stashIndex = holder.add(off(cls('StashHolderItemContainer'), '<CurrentStashIndex>k__BackingField')).readS32();
  const ui = staticBase(C.UIBase).add(off(C.UIBase, 'instance')).readPointer();
  if (ui.isNull()) { state.stashOpen = null; return; }
  const boxed = invoke(method(C.UIBase, 'IsStashOpen', 0), ui, []);
  state.stashOpen = !boxed.isNull() && boxed.add(0x10).readU8() !== 0;
}

function tick() {
  const now = Date.now();
  state.ticks++;
  if (now - state.lastTick > 250) {
    state.lastTick = now;
    try { refreshState(); } catch (e) { state.error = String(e); }
  }
  if (!queue.length || now < notBefore) return;
  const cmd = queue.shift();
  try {
    results[cmd.id] = { ok: true, value: ops[cmd.op](cmd.args || {}) ?? null };
  } catch (e) {
    results[cmd.id] = { ok: false, error: String(e) };
  }
  notBefore = now + (cmd.delayMs ?? 150);
}

const updateMethod = il2cppScope(() => method(cls('UpdateSystem', 'LE.CustomUpdate'), 'Update', 0));
const updateHook = Interceptor.attach(updateMethod.readPointer(), { onEnter() { tick(); } });

// Let the game exit cleanly: drop the hook as soon as Unity starts quitting.
try {
  const kApp = il2cppScope(() => cls('Application', 'UnityEngine', 'UnityEngine.CoreModule.dll'));
  const quit = il2cppScope(() => method(kApp, 'Internal_ApplicationQuit', 0));
  Interceptor.attach(quit.readPointer(), { onEnter() { updateHook.detach(); queue.length = 0; } });
} catch (e) { /* method name differs on this build: hook stays until the script unloads */ }

rpc.exports = {
  snapshot: withItems => il2cppScope(() => snapshot(!!withItems)),
  gameData: () => il2cppScope(() => readGameData()),
  dispose() { updateHook.detach(); queue.length = 0; return true; },
  state: () => Object.assign({ queued: queue.length, build: GA.size }, state),
  enqueue(op, args, delayMs) {
    if (!ops[op]) throw new Error('unknown op ' + op);
    const id = nextId++;
    queue.push({ id, op, args, delayMs });
    return id;
  },
  result(id) {
    const r = results[id];
    if (r) delete results[id];
    return r || null;
  },
  clearQueue() { const n = queue.length; queue.length = 0; return n; },
};
