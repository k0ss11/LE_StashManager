// StashManager - tab / folder configuration (mirrors the game's "Configure Tab" window).
// Uses globals from index.html: snap, GD, ICONS, TYPE_GROUPS, $, esc, load, runSearch.
'use strict';

// ---------------------------------------------------------------- game enums

const PRIO_RARITY = [ // ItemFiltering.RarityCondition.Rarity flags
  ['Normal', 1, 'normal'], ['Magic', 2, 'magic'], ['Rare', 4, 'rare'], ['Exalted', 64, 'exalted'],
  ['Unique', 8, 'unique'], ['Set', 16, 'set'], ['Legendary', 32, 'legendary'],
];
const PRIO_CLASS = [['Primalist', 1], ['Mage', 2], ['Sentinel', 4], ['Acolyte', 8], ['Rogue', 16]];
const PRIO_FACTION = [['Circle of Fortune', 0], ['Merchant\'s Guild', 1], ['Forgotten Knights', 2], ['The Weaver', 3]];
const PRIO_CORRUPTION = [['Any', 0], ['Only corrupted', 1], ['Only uncorrupted', 2]];
const POTENTIAL = [['Legendary Potential', 'LegendaryPotential'], ['Forging Potential', 'ForgingPotential'],
  ['Weaver\'s Will', 'WeaversWill'], ['Weaver\'s Touch', 'WeaversTouch']];

// Fallback palette (approximated from the game's configure window) until data/tabstyles.json exists.
const FALLBACK_COLORS = ['#59646b', '#6a6a6a', '#8a8a4a', '#7a5a3a', '#7a4636', '#7a3c4c', '#6e4a78', '#56487a', '#4a5a78',
  '#4c7a78', '#3e8a3e', '#8a8a2a', '#b06a20', '#b03030', '#a0307a', '#6a30a0', '#3050b0', '#20906a'];
let TAB_STYLES = { colors: FALLBACK_COLORS, icons: Array.from({ length: 24 }, () => null) };

async function loadTabStyles() {
  try {
    const r = await fetch('/api/tabstyles');
    const j = await r.json();
    if (j.ok && j.colors?.length) {
      TAB_STYLES = {
        // game colours are tints over a dark tab texture: darken for a similar look
        colors: j.colors.map(([r_, g, b]) => `rgb(${Math.round(r_ * 140)},${Math.round(g * 140)},${Math.round(b * 140)})`),
        icons: j.icons || [],
      };
    }
  } catch {}
}

// ---------------------------------------------------------------- api

async function op(name, args, confirm = false) {
  const r = await fetch('/api/op', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: name, args, confirm }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `${name} failed`);
  return j.value;
}

// wait until predicate(snapshot) holds (server round trip), refreshing the page state
async function waitFor(pred, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await load();
    if (snap && pred(snap)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// ---------------------------------------------------------------- priority <-> form

// JS port of StashPriority.Match (subset we can evaluate client-side) for the live preview.
function priorityMatches(p, it) {
  if (!p) return false;
  if (p.rarity) {
    const flag = it.exalted ? 64 : it.rarity === 0 ? 1 : it.rarity <= 2 ? 2 : it.rarity <= 4 ? 4
      : it.rarity === 7 ? 8 : it.rarity === 8 ? 16 : 32;
    if (!(p.rarity & flag)) return false;
  }
  if (p.type?.types?.length && !p.type.types.includes(it.type)) return false;
  if (p.uniques?.length && !(it.rarity >= 7 && p.uniques.includes(it.uniqueId))) return false;
  if (p.corruption === 1 && !it.corrupted) return false;
  if (p.corruption === 2 && it.corrupted) return false;
  if (p.level) {
    const l = it.lvlReq ?? 0;
    if (p.level.min != null && l < p.level.min) return false;
    if (p.level.max != null && l > p.level.max) return false;
  }
  if (p.potential) {
    const val = { LegendaryPotential: it.lp, ForgingPotential: it.fp, WeaversWill: it.ww, WeaversTouch: null };
    for (const [, k] of POTENTIAL) {
      const v = val[k];
      if (v == null) continue;
      const mn = p.potential['Min' + k], mx = p.potential['Max' + k];
      if (mn != null && v < mn) return false;
      if (mx != null && v > mx) return false;
    }
  }
  if (p.classReq) {
    const sub = GD?.bases.get(it.type)?.subs.get(it.subType);
    if (sub && sub.classReq && !(sub.classReq & p.classReq)) return false;
  }
  return true;
}

function msel(id, groups, selected, placeholder) {
  // groups: [[label, [[value, text], ...]], ...]
  const sel = new Set(selected || []);
  return `<div class="msel cfg-msel" data-msel="${id}">
    <button type="button" class="msel-btn"><span class="lbl">${esc(placeholder)}</span><span>▾</span></button>
    <div class="msel-panel">${groups.length > 1 || groups[0][1].length > 20 ? '<input type="text" class="msel-q" placeholder="filter…">' : ''}
      ${groups.map(([g, opts]) => `<div class="tg">${g ? `<div class="ghead">${esc(g)}</div>` : ''}`
        + opts.map(([v, t]) => `<label class="opt"><input type="checkbox" value="${v}"${sel.has(v) ? ' checked' : ''}>${esc(t)}</label>`).join('')
        + '</div>').join('')}</div></div>`;
}
function mselValues(root, id) {
  return [...root.querySelectorAll(`[data-msel="${id}"] input[type=checkbox]:checked`)].map(c => +c.value);
}
function mselLabel(el, placeholder) {
  const names = [...el.querySelectorAll('input[type=checkbox]:checked')].map(c => c.parentElement.textContent.trim());
  el.querySelector('.lbl').textContent = !names.length ? placeholder
    : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function priorityForm(p) {
  p = p || {};
  const pot = p.potential || {};
  const typeGroups = TYPE_GROUPS.map(([g, ids]) => [g, ids.filter(i => GD.bases.has(i))
    .map(i => [i, GD.bases.get(i).display || GD.bases.get(i).name])]);
  const uniques = [...GD.uniques.values()].filter(u => !u.hidden).sort((a, b) => a.name.localeCompare(b.name));
  return `
  <div class="pgrid">
    <div><label>Uniques</label>${msel('uniques', [['', uniques.map(u => [u.id, u.name])]], p.uniques, 'None')}</div>
    <div><label>Rarity</label>${msel('rarity', [['', PRIO_RARITY.map(([t, v]) => [v, t])]],
      PRIO_RARITY.filter(([, v]) => (p.rarity || 0) & v).map(([, v]) => v), 'None')}</div>
    <div><label>Class requirement</label>${msel('classReq', [['', PRIO_CLASS.map(([t, v]) => [v, t])]],
      PRIO_CLASS.filter(([, v]) => (p.classReq || 0) & v).map(([, v]) => v), 'None')}</div>
    <div><label>Type</label>${msel('type', typeGroups, p.type?.types, 'None')}</div>
    <div class="pot">${POTENTIAL.map(([t, k]) => `<label>${t}</label><div class="mm">
      <input type="number" min="0" data-pot="Min${k}" placeholder="Min" value="${pot['Min' + k] ?? ''}"> –
      <input type="number" min="0" data-pot="Max${k}" placeholder="Max" value="${pot['Max' + k] ?? ''}"></div>`).join('')}</div>
    <div>
      <label>Level requirement</label><div class="mm">
        <input type="number" min="0" max="100" id="lvlMin" placeholder="Min" value="${p.level?.min ?? ''}"> –
        <input type="number" min="0" max="100" id="lvlMax" placeholder="Max" value="${p.level?.max ?? ''}"></div>
      <label>Corruption</label><select id="corruption">${PRIO_CORRUPTION.map(([t, v]) =>
        `<option value="${v}"${(p.corruption || 0) === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <label>Item faction requirement</label>${msel('faction', [['', PRIO_FACTION.map(([t, v]) => [v, t])]], p.faction, 'None')}
    </div>
  </div>`;
}

function readPriorityForm(root) {
  const num = el => el.value === '' ? null : +el.value;
  const potential = {};
  root.querySelectorAll('[data-pot]').forEach(el => potential[el.dataset.pot] = num(el));
  const spec = {
    uniques: mselValues(root, 'uniques'),
    rarity: mselValues(root, 'rarity').reduce((a, b) => a | b, 0),
    classReq: mselValues(root, 'classReq').reduce((a, b) => a | b, 0),
    type: { types: mselValues(root, 'type'), subTypes: [] },
    potential,
    level: { min: num(root.querySelector('#lvlMin')), max: num(root.querySelector('#lvlMax')) },
    corruption: +root.querySelector('#corruption').value,
    faction: mselValues(root, 'faction'),
  };
  const empty = !spec.uniques.length && !spec.rarity && !spec.classReq && !spec.type.types.length
    && Object.values(potential).every(v => v == null) && spec.level.min == null && spec.level.max == null
    && !spec.corruption && !spec.faction.length;
  return empty ? null : spec;
}

// ---------------------------------------------------------------- modal

function openModal(html, onReady) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.id = 'modal';
  wrap.innerHTML = `<div class="mbox">${html}</div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('mousedown', e => {
    if (!e.target.closest('.msel')) wrap.querySelectorAll('.msel.open').forEach(m => m.classList.remove('open'));
  });
  wrap.querySelectorAll('.cfg-msel').forEach(m => {
    const ph = m.querySelector('.lbl').textContent;
    mselLabel(m, ph);
    m.querySelector('.msel-btn').onclick = () => {
      wrap.querySelectorAll('.msel.open').forEach(o => o !== m && o.classList.remove('open'));
      m.classList.toggle('open');
    };
    m.addEventListener('change', () => { mselLabel(m, ph); wrap.dispatchEvent(new Event('formchange')); });
    m.querySelector('.msel-q')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      m.querySelectorAll('.opt').forEach(o => o.style.display = o.textContent.toLowerCase().includes(q) ? '' : 'none');
    });
    m.addEventListener('click', e => {
      const g = e.target.closest('.ghead');
      if (!g) return;
      const boxes = [...g.closest('.tg').querySelectorAll('input[type=checkbox]')];
      const on = !boxes.every(b => b.checked);
      boxes.forEach(b => b.checked = on);
      mselLabel(m, ph); wrap.dispatchEvent(new Event('formchange'));
    });
  });
  wrap.addEventListener('input', () => wrap.dispatchEvent(new Event('formchange')));
  wrap.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  onReady?.(wrap);
  return wrap;
}
function closeModal() { $('modal')?.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function swatches(selected) {
  return `<div class="swatches">${TAB_STYLES.colors.map((c, i) =>
    `<button type="button" class="sw${i === selected ? ' on' : ''}" data-color="${i}" style="background:${c}" title="color ${i}"></button>`).join('')}</div>`;
}
function iconPicker(selected) {
  return `<div class="iconpick">${TAB_STYLES.icons.map((n, i) =>
    `<button type="button" class="ic${i === selected ? ' on' : ''}" data-icon="${i}" title="${esc(n || 'no icon')}">`
    + (n ? `<img src="/icons/tabicon_${encodeURIComponent(n)}.png" alt="" onerror="this.replaceWith('${i}')">` : '✕') + '</button>').join('')}</div>`;
}
function bindPick(wrap, cls_, attr) {
  wrap.querySelectorAll('.' + cls_).forEach(b => b.onclick = () => {
    wrap.querySelectorAll('.' + cls_).forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });
  return () => +(wrap.querySelector(`.${cls_}.on`)?.dataset[attr] ?? 0);
}

function previewText(p) {
  if (!p) return 'Tab priority off — nothing is routed here automatically.';
  const items = (snap?.containers || []).flatMap(c => c.items.map(it => [c.index, it]));
  const hits = items.filter(([, it]) => priorityMatches(p, it));
  const elsewhere = hits.filter(([t]) => t !== currentCfgTab).length;
  return `Matches <b>${hits.length}</b> items in your stash (${elsewhere} currently in other tabs).`;
}
let currentCfgTab = null;

// ---------------------------------------------------------------- tab dialog

function tabDialog(tab) {
  const isNew = !tab;
  tab = tab || { name: 'New Tab', icon: 0, color: 0, categoryId: [...snap.categories].sort((a, b) => a.order - b.order)[0]?.id ?? 0,
    priority: null, ignoreFolderPriority: false };
  currentCfgTab = isNew ? null : tab.id;
  const cats = [...snap.categories].sort((a, b) => a.order - b.order);
  const wrap = openModal(`
    <h3>${isNew ? 'Create Tab' : 'Configure Tab'}</h3>
    <div class="two">
      <div><label>Tab name</label><input type="text" id="tName" maxlength="40" value="${esc(tab.name)}"></div>
      <div><label>Folder</label><select id="tCat">${cats.map(c => `<option value="${c.id}"${c.id === tab.categoryId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    </div>
    <div class="two">
      <div><label>Tab icon</label>${iconPicker(tab.icon)}</div>
      <div><label>Tab colour</label>${swatches(tab.color)}</div>
    </div>
    <label class="prio"><input type="checkbox" id="tPrio"${tab.priority ? ' checked' : ''}> <b>Tab priority</b>
      <span class="muted">— move matching items to this tab even when it isn't open</span></label>
    <div id="prioForm"${tab.priority ? '' : ' class="off"'}>${priorityForm(tab.priority)}</div>
    <div class="preview" id="tPrev"></div>
    <div class="cost muted" id="tCost"></div>
    <div class="err" id="tErr"></div>
    <div class="btns"><button class="primary" id="tOk">${isNew ? 'Buy tab' : 'Confirm'}</button><button data-close>Cancel</button></div>`, w => {
    const color = bindPick(w, 'sw', 'color');
    const icon = bindPick(w, 'ic', 'icon');
    const prio = () => w.querySelector('#tPrio').checked ? readPriorityForm(w.querySelector('#prioForm')) : null;
    const upd = () => {
      w.querySelector('#prioForm').classList.toggle('off', !w.querySelector('#tPrio').checked);
      w.querySelector('#tPrev').innerHTML = previewText(prio());
    };
    w.addEventListener('formchange', upd);
    w.querySelector('#tPrio').onchange = upd;
    upd();

    if (isNew) {
      op('nextTabCost', {}).then(cost => {
        w.querySelector('#tCost').innerHTML = `Cost: <b>${cost.toLocaleString()}</b> gold (you have ${(snap.gold ?? 0).toLocaleString()}). Tabs cannot be deleted.`;
        w.dataset.cost = cost;
      }).catch(e => w.querySelector('#tCost').textContent = e.message);
    }

    w.querySelector('#tOk').onclick = async () => {
      const btn = w.querySelector('#tOk');
      const err = w.querySelector('#tErr');
      err.textContent = '';
      const name = w.querySelector('#tName').value.trim() || 'Tab';
      const categoryId = +w.querySelector('#tCat').value;
      const args = { name, icon: icon(), color: color(), parentId: categoryId,
        ignoreFolderPriority: !!tab.ignoreFolderPriority, priority: prio() };
      if (!w.querySelector('#tPrio').checked) args.priority = null;
      btn.disabled = true;
      try {
        let id = tab.id;
        if (isNew) {
          if (btn.dataset.armed !== '1') { // two-step confirm for spending gold
            btn.dataset.armed = '1'; btn.disabled = false;
            btn.textContent = `Confirm: spend ${(+w.dataset.cost || 0).toLocaleString()} gold`;
            return;
          }
          const before = new Set(snap.tabs.map(t => t.id));
          const order = snap.tabs.filter(t => t.categoryId === categoryId).length;
          await op('tabPurchase', { parentId: categoryId, order, name }, true);
          if (!await waitFor(s => s.tabs.some(t => !before.has(t.id)))) throw new Error('purchase not confirmed by game');
          id = snap.tabs.find(t => !before.has(t.id)).id;
        }
        await op('tabConfigure', { id, ...args });
        await waitFor(s => (s.tabs.find(t => t.id === id) || {}).name === name);
        selTab = id;
        closeModal();
        render();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    };
  });
  return wrap;
}

// ---------------------------------------------------------------- folder dialog

function folderDialog(cat) {
  const isNew = !cat;
  cat = cat || { name: 'New Folder', icon: 0, color: 0 };
  currentCfgTab = null;
  const tabsIn = isNew ? [] : snap.tabs.filter(t => t.categoryId === cat.id);
  openModal(`
    <h3>${isNew ? 'Create Folder' : 'Configure Folder'}</h3>
    <label>Folder name</label><input type="text" id="fName" maxlength="40" value="${esc(cat.name)}">
    <div class="two">
      <div><label>Folder icon</label>${iconPicker(cat.icon)}</div>
      <div><label>Folder colour</label>${swatches(cat.color)}</div>
    </div>
    <div class="err" id="fErr"></div>
    <div class="btns">
      ${isNew ? '' : `<button id="fDel" class="danger"${tabsIn.length ? ` disabled title="move its ${tabsIn.length} tabs out first"` : ''}>Delete folder</button>`}
      <span style="flex:1"></span>
      <button class="primary" id="fOk">${isNew ? 'Create' : 'Confirm'}</button><button data-close>Cancel</button></div>`, w => {
    const color = bindPick(w, 'sw', 'color');
    const icon = bindPick(w, 'ic', 'icon');
    w.querySelector('#fOk').onclick = async () => {
      const err = w.querySelector('#fErr');
      err.textContent = '';
      const name = w.querySelector('#fName').value.trim() || 'Folder';
      try {
        let id = cat.id;
        if (isNew) {
          const before = new Set(snap.categories.map(c => c.id));
          await op('categoryCreate', { name });
          if (!await waitFor(s => s.categories.some(c => !before.has(c.id)))) throw new Error('folder not created');
          id = snap.categories.find(c => !before.has(c.id)).id;
        }
        await op('categoryConfigure', { id, name, icon: icon(), color: color() });
        await waitFor(s => (s.categories.find(c => c.id === id) || {}).name === name);
        closeModal();
        render();
      } catch (e) { err.textContent = e.message; }
    };
    w.querySelector('#fDel')?.addEventListener('click', async e => {
      const b = e.target;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
      try {
        await op('categoryDelete', { id: cat.id }, true);
        await waitFor(s => !s.categories.some(c => c.id === cat.id));
        closeModal();
        render();
      } catch (er) { w.querySelector('#fErr').textContent = er.message; }
    });
  });
}

// ---------------------------------------------------------------- reorder

async function moveTab(id, dir) {
  const t = snap.tabs.find(x => x.id === id);
  const sib = snap.tabs.filter(x => x.categoryId === t.categoryId).sort((a, b) => a.order - b.order);
  const i = sib.findIndex(x => x.id === id), j = i + dir;
  if (j < 0 || j >= sib.length) return;
  await op('tabReorder', { id, order: sib[j].order });
  await waitFor(s => (s.tabs.find(x => x.id === id) || {}).order === sib[j].order);
}
async function moveFolder(id, dir) {
  const cats = [...snap.categories].sort((a, b) => a.order - b.order);
  const i = cats.findIndex(c => c.id === id), j = i + dir;
  if (j < 0 || j >= cats.length) return;
  await op('categoryReorder', { id, order: cats[j].order });
  await waitFor(s => (s.categories.find(c => c.id === id) || {}).order === cats[j].order);
}

// ---------------------------------------------------------------- wiring

$('tabs').addEventListener('click', async e => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  e.stopPropagation();
  if (!snap?.stashOpen && a.dataset.act !== 'noop') {
    $('err').textContent = 'Open the stash in game to change tabs.';
    return;
  }
  const id = +a.dataset.id;
  try {
    switch (a.dataset.act) {
      case 'cfg-tab': tabDialog(snap.tabs.find(t => t.id === id)); break;
      case 'cfg-folder': folderDialog(snap.categories.find(c => c.id === id)); break;
      case 'new-tab': tabDialog(null); break;
      case 'new-folder': folderDialog(null); break;
      case 'tab-up': await moveTab(id, -1); break;
      case 'tab-down': await moveTab(id, 1); break;
      case 'folder-up': await moveFolder(id, -1); break;
      case 'folder-down': await moveFolder(id, 1); break;
    }
  } catch (er) { $('err').textContent = er.message; }
}, true);

loadTabStyles().then(() => snap && render());
