// StashManager - stash layout presets: capture, import/export, plan (reusing existing tabs), apply.
// Uses globals: snap, GD, $, esc, load, render, op, waitFor, openModal, closeModal, TAB_STYLES,
// priorityMatches, PRIO_RARITY.
'use strict';

const norm = s => (s || '').trim().toLowerCase();
const samePrio = (a, b) => JSON.stringify(canonPrio(a)) === JSON.stringify(canonPrio(b));

// Normalise a priority spec so presets and live data compare equal.
function canonPrio(p) {
  if (!p) return null;
  const out = {};
  if (p.rarity) out.rarity = p.rarity;
  if (p.type?.types?.length) out.type = [...p.type.types].sort((a, b) => a - b);
  if (p.uniques?.length) out.uniques = [...p.uniques].sort((a, b) => a - b);
  if (p.classReq) out.classReq = p.classReq;
  if (p.corruption) out.corruption = p.corruption;
  if (p.faction?.length) out.faction = [...p.faction].sort((a, b) => a - b);
  if (p.level && (p.level.min != null || p.level.max != null)) out.level = [p.level.min ?? null, p.level.max ?? null];
  if (p.potential) {
    const pot = Object.entries(p.potential).filter(([, v]) => v !== null && v !== undefined && v !== '').sort();
    if (pot.length) out.potential = pot;
  }
  return Object.keys(out).length ? out : null;
}

function describePrio(p) {
  const c = canonPrio(p);
  if (!c) return '<span class="muted">no priority</span>';
  const parts = [];
  if (c.rarity) parts.push(PRIO_RARITY.filter(([, v]) => c.rarity & v).map(([t]) => t).join('/'));
  if (c.type) parts.push(c.type.map(t => GD?.bases.get(t)?.display || t).join(', '));
  if (c.uniques) parts.push(`${c.uniques.length} uniques`);
  if (c.potential) parts.push(c.potential.map(([k, v]) => `${k.replace(/^(Min|Max)/, '$1 ').replace('LegendaryPotential', 'LP')
    .replace('WeaversWill', 'WW').replace('ForgingPotential', 'FP').replace('WeaversTouch', 'WT')} ${v}`).join(', '));
  if (c.level) parts.push(`lvl ${c.level[0] ?? 0}-${c.level[1] ?? 100}`);
  if (c.corruption) parts.push(c.corruption === 1 ? 'corrupted' : 'uncorrupted');
  if (c.classReq) parts.push('class req');
  return esc(parts.join(' · '));
}

// ---------------------------------------------------------------- capture

function captureLayout(name) {
  const cats = [...snap.categories].sort((a, b) => a.order - b.order);
  return {
    name, version: 1, description: `Captured ${new Date().toLocaleString()}`,
    folders: cats.map(c => ({
      name: c.name, icon: c.icon, color: c.color,
      tabs: snap.tabs.filter(t => t.categoryId === c.id).sort((a, b) => a.order - b.order)
        .map(t => ({ name: t.name, icon: t.icon, color: t.color, priority: canonPrio(t.priority) ? t.priority : null })),
    })),
  };
}

// ---------------------------------------------------------------- planner

// Map preset folders/tabs onto the existing stash, reusing as much as possible.
// Returns { folders, tabs, leftovers, buys, steps } where steps are human-readable + executable.
function planPreset(preset, opts) {
  const itemsIn = id => snap.containers[id]?.items.length || 0;
  const usedCats = new Set(), usedTabs = new Set();

  // folders: same name first, then reuse other existing folders in display order, then create
  const exCats = [...snap.categories].sort((a, b) => a.order - b.order);
  const folders = preset.folders.map(pf => {
    const m = exCats.find(c => !usedCats.has(c.id) && norm(c.name) === norm(pf.name));
    if (m) usedCats.add(m.id);
    return { pf, cat: m || null };
  });
  for (const f of folders) {
    if (f.cat || !opts.reuse) continue;
    const m = exCats.find(c => !usedCats.has(c.id));
    if (m) { f.cat = m; usedCats.add(m.id); }
  }

  // tabs: same name first; then empty tabs; then least-used; else buy
  const exTabs = [...snap.tabs];
  const wanted = folders.flatMap((f, fi) => f.pf.tabs.map((pt, ti) => ({ pt, fi, ti, tab: null })));
  for (const w of wanted) {
    const m = exTabs.find(t => !usedTabs.has(t.id) && norm(t.name) === norm(w.pt.name));
    if (m) { w.tab = m; usedTabs.add(m.id); }
  }
  // content-aware reuse: a preset tab takes the existing tab that already holds the most items its
  // priority would route there (fewer moves for auto-sort later)
  if (opts.reuse && typeof priorityMatches === 'function') {
    const pairs = [];
    for (const w of wanted.filter(x => !x.tab && x.pt.priority))
      for (const t of exTabs.filter(x => !usedTabs.has(x.id))) {
        const items = snap.containers[t.id]?.items || [];
        const score = items.filter(it => priorityMatches(w.pt.priority, it)).length;
        if (score) pairs.push({ w, t, score, share: score / items.length });
      }
    pairs.sort((a, b) => b.share - a.share || b.score - a.score);
    for (const { w, t } of pairs) {
      if (w.tab || usedTabs.has(t.id)) continue;
      w.tab = t;
      usedTabs.add(t.id);
    }
  }
  const spare = exTabs.filter(t => !usedTabs.has(t.id))
    .sort((a, b) => itemsIn(a.id) - itemsIn(b.id) || a.categoryId - b.categoryId || a.order - b.order);
  for (const w of wanted) {
    if (w.tab || !opts.reuse) continue;
    const m = spare.shift();
    if (m) { w.tab = m; usedTabs.add(m.id); }
  }
  const leftovers = exTabs.filter(t => !usedTabs.has(t.id));
  const buys = wanted.filter(w => !w.tab);

  // ---- steps (executed in order; each verified against the game)
  const steps = [];
  const catRef = {}; // folder index -> live category id (filled during execution for new folders)
  folders.forEach((f, fi) => {
    if (f.cat) {
      catRef[fi] = f.cat.id;
      if (f.cat.name !== f.pf.name || f.cat.icon !== f.pf.icon || f.cat.color !== f.pf.color)
        steps.push({ text: `Folder "${f.cat.name}" → "${f.pf.name}" (icon/colour)`, run: ctx =>
          cfgFolder(ctx.cat[fi], f.pf) });
    } else {
      steps.push({ text: `Create folder "${f.pf.name}"`, run: async ctx => {
        ctx.cat[fi] = await createFolder(f.pf.name);
        await cfgFolder(ctx.cat[fi], f.pf);
      } });
    }
  });
  if (opts.leftoverFolder && leftovers.length) {
    steps.push({ text: `Create folder "${opts.leftoverFolder}" for ${leftovers.length} tabs not in the preset`, run: async ctx => {
      const ex = snap.categories.find(c => norm(c.name) === norm(opts.leftoverFolder));
      ctx.leftCat = ex ? ex.id : await createFolder(opts.leftoverFolder);
    } });
  }
  for (const w of wanted) {
    const pt = w.pt, fi = w.fi;
    if (w.tab) {
      const t = w.tab;
      const changes = [];
      if (t.name !== pt.name) changes.push(`rename "${t.name}" → "${pt.name}"`);
      if (t.icon !== pt.icon || t.color !== pt.color) changes.push('icon/colour');
      if (!samePrio(t.priority, pt.priority)) changes.push('priority');
      const moveFolder = !folders[fi].cat || folders[fi].cat.id !== t.categoryId;
      if (moveFolder) changes.push(`move to "${folders[fi].pf.name}"`);
      if (changes.length)
        steps.push({ text: `Tab "${t.name}": ${changes.join(', ')}${itemsIn(t.id) ? ` (keeps its ${itemsIn(t.id)} items)` : ''}`,
          run: ctx => cfgTab(t.id, pt, ctx.cat[fi]) });
      w.idRef = () => t.id;
    } else {
      const k = buys.indexOf(w);
      steps.push({ text: `Buy tab "${pt.name}" in "${folders[fi].pf.name}"`, gold: k, run: async ctx => {
        ctx.tab[k] = await buyTab(ctx.cat[fi], pt.name);
        await cfgTab(ctx.tab[k], pt, ctx.cat[fi]);
      } });
      w.idRef = ctx => ctx.tab[k];
    }
  }
  for (const t of leftovers) {
    if (opts.leftoverFolder || (opts.clearLeftoverPrio && canonPrio(t.priority)))
      steps.push({ text: `Leftover tab "${t.name}"${opts.leftoverFolder ? ` → "${opts.leftoverFolder}"` : ''}`
        + `${opts.clearLeftoverPrio && canonPrio(t.priority) ? ', clear priority' : ''}`, run: async ctx => {
        const args = { id: t.id };
        if (opts.leftoverFolder) args.parentId = ctx.leftCat;
        if (opts.clearLeftoverPrio) args.priority = null;
        await op('tabConfigure', args);
        await waitFor(s => {
          const x = s.tabs.find(y => y.id === t.id);
          return x && (!opts.leftoverFolder || x.categoryId === ctx.leftCat) && (!opts.clearLeftoverPrio || !x.priority);
        });
      } });
  }
  // order: folders in preset order, then tabs inside each folder
  steps.push({ text: 'Order folders and tabs like the preset (game routes items left → right)', run: async ctx => {
    for (let fi = 0; fi < folders.length; fi++) await reorderFolder(ctx.cat[fi], fi);
    for (let fi = 0; fi < folders.length; fi++) {
      const ids = wanted.filter(w => w.fi === fi).map(w => w.idRef(ctx));
      for (let i = 0; i < ids.length; i++) await reorderTab(ids[i], i);
    }
  } });
  return { folders, wanted, leftovers, buys, steps, catRef };
}

// ---------------------------------------------------------------- executable primitives

async function createFolder(name) {
  const before = new Set(snap.categories.map(c => c.id));
  await op('categoryCreate', { name });
  if (!await waitFor(s => s.categories.some(c => !before.has(c.id)))) throw new Error(`folder "${name}" not created`);
  return snap.categories.find(c => !before.has(c.id)).id;
}
async function cfgFolder(id, pf) {
  await op('categoryConfigure', { id, name: pf.name, icon: pf.icon, color: pf.color });
  if (!await waitFor(s => (c => c && c.name === pf.name && c.icon === pf.icon && c.color === pf.color)(s.categories.find(x => x.id === id))))
    throw new Error(`folder "${pf.name}" not updated`);
}
async function buyTab(catId, name) {
  const before = new Set(snap.tabs.map(t => t.id));
  await op('tabPurchase', { parentId: catId, order: snap.tabs.filter(t => t.categoryId === catId).length, name }, true);
  if (!await waitFor(s => s.tabs.some(t => !before.has(t.id)), 6000)) throw new Error(`purchase of "${name}" not confirmed`);
  return snap.tabs.find(t => !before.has(t.id)).id;
}
async function cfgTab(id, pt, catId) {
  await op('tabConfigure', { id, name: pt.name, icon: pt.icon, color: pt.color, parentId: catId, priority: pt.priority || null });
  if (!await waitFor(s => (t => t && t.name === pt.name && t.categoryId === catId && samePrio(t.priority, pt.priority))(s.tabs.find(x => x.id === id))))
    throw new Error(`tab "${pt.name}" not updated`);
}
async function reorderFolder(id, order) {
  const c = snap.categories.find(x => x.id === id);
  if (!c || c.order === order) return;
  await op('categoryReorder', { id, order });
  await waitFor(s => (s.categories.find(x => x.id === id) || {}).order === order);
}
async function reorderTab(id, order) {
  const t = snap.tabs.find(x => x.id === id);
  if (!t || t.order === order) return;
  await op('tabReorder', { id, order });
  await waitFor(s => (s.tabs.find(x => x.id === id) || {}).order === order);
}

// ---------------------------------------------------------------- UI

let PRESETS = [];
async function loadPresets() {
  PRESETS = await (await fetch('/api/presets')).json();
}

function presetSummary(p) {
  const tabs = p.folders.reduce((n, f) => n + f.tabs.length, 0);
  return `${p.folders.length} folders · ${tabs} tabs`;
}

async function presetsDialog() {
  await loadPresets();
  const wrap = openModal(`
    <h3>Stash presets</h3>
    <div class="two">
      <div>
        <label>Presets</label>
        <div class="plist">${PRESETS.map((p, i) => `<div class="pitem" data-i="${i}">
          <div><b>${esc(p.name)}</b>${p.builtin ? ' <span class="muted">(built-in)</span>' : ''}</div>
          <div class="muted">${presetSummary(p)}</div></div>`).join('') || '<div class="muted">none yet</div>'}</div>
        <label>Save current layout as preset</label>
        <div class="row"><input type="text" id="pName" placeholder="preset name"><button id="pSave">Save</button></div>
        <label>Import (paste JSON or pick a file)</label>
        <textarea id="pImport" rows="3" placeholder='{"name": ..., "folders": [...]}'></textarea>
        <div class="row"><input type="file" id="pFile" accept=".json"><button id="pImp">Import</button></div>
      </div>
      <div id="pDetail" class="muted">Select a preset to see the plan.</div>
    </div>
    <div class="err" id="pErr"></div>
    <div class="btns"><button data-close>Close</button></div>`);

  const err = m => wrap.querySelector('#pErr').textContent = m || '';
  wrap.querySelectorAll('.pitem').forEach(el => el.onclick = () => {
    wrap.querySelectorAll('.pitem').forEach(x => x.classList.remove('on'));
    el.classList.add('on');
    showPreset(wrap, PRESETS[+el.dataset.i]);
  });
  wrap.querySelector('#pSave').onclick = async () => {
    const name = wrap.querySelector('#pName').value.trim();
    if (!name) return err('enter a name');
    await savePreset(captureLayout(name));
    presetsDialog();
  };
  wrap.querySelector('#pFile').onchange = async e => {
    const f = e.target.files[0];
    if (f) wrap.querySelector('#pImport').value = await f.text();
  };
  wrap.querySelector('#pImp').onclick = async () => {
    try {
      const p = JSON.parse(wrap.querySelector('#pImport').value);
      if (!p.name || !Array.isArray(p.folders)) throw new Error('needs "name" and "folders"');
      await savePreset(p);
      presetsDialog();
    } catch (e) { err('import failed: ' + e.message); }
  };
}

async function savePreset(p) {
  const r = await fetch('/api/preset-save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: p }) });
  if (!r.ok) throw new Error((await r.json()).error);
}

function showPreset(wrap, p) {
  const box = wrap.querySelector('#pDetail');
  const opts = { reuse: true, leftoverFolder: 'Unsorted', clearLeftoverPrio: true };
  const draw = async () => {
    const plan = planPreset(p, opts);
    let costs = [];
    if (plan.buys.length) { try { costs = await op('tabCosts', { count: plan.buys.length }); } catch (e) { costs = null; } }
    const total = costs ? costs.reduce((a, b) => a + b, 0) : null;
    const keepItems = plan.wanted.filter(w => w.tab && snap.containers[w.tab.id]?.items.length);
    box.classList.remove('muted');
    box.innerHTML = `
      <div><b>${esc(p.name)}</b></div><div class="muted">${esc(p.description || '')}</div>
      <div class="ptree">${p.folders.map(f => `<div class="pf"><span class="sw mini" style="background:${TAB_STYLES.colors[f.color] || '#555'}"></span>${esc(f.name)}</div>`
        + f.tabs.map(t => `<div class="pt">${esc(t.name)} <span class="muted">— ${describePrio(t.priority)}</span></div>`).join('')).join('')}</div>
      <label class="prio"><input type="checkbox" id="oReuse"${opts.reuse ? ' checked' : ''}> reuse existing tabs (rename/reconfigure instead of buying)</label>
      <label class="prio"><input type="checkbox" id="oLeft"${opts.leftoverFolder ? ' checked' : ''}> move tabs not in the preset to folder "Unsorted"</label>
      <label class="prio"><input type="checkbox" id="oClr"${opts.clearLeftoverPrio ? ' checked' : ''}> clear priority on tabs not in the preset</label>
      <div class="preview">
        Reuses <b>${plan.wanted.length - plan.buys.length}</b> tabs, buys <b>${plan.buys.length}</b>
        ${plan.buys.length ? `— <b>${total == null ? '?' : total.toLocaleString()}</b> gold (you have ${(snap.gold ?? 0).toLocaleString()})` : ''}.
        ${keepItems.length ? `<br>${keepItems.length} reused tabs already contain items — items stay where they are (auto-sort will move them later).` : ''}
        ${plan.leftovers.length ? `<br>${plan.leftovers.length} existing tabs are not used by the preset.` : ''}
      </div>
      <details><summary>${plan.steps.length} steps</summary><ol class="steps">${plan.steps.map(s => `<li>${esc(s.text)}</li>`).join('')}</ol></details>
      <div class="btns">
        ${p.builtin ? '' : '<button id="pDel" class="danger">Delete preset</button>'}
        <button id="pExp">Export JSON</button><span style="flex:1"></span>
        <button class="primary" id="pApply"${!snap.stashOpen ? ' disabled title="open the stash in game"' : ''}>Apply preset</button></div>
      <ol class="plog" id="pLog"></ol>`;
    box.querySelector('#oReuse').onchange = e => { opts.reuse = e.target.checked; draw(); };
    box.querySelector('#oLeft').onchange = e => { opts.leftoverFolder = e.target.checked ? 'Unsorted' : null; draw(); };
    box.querySelector('#oClr').onchange = e => { opts.clearLeftoverPrio = e.target.checked; draw(); };
    box.querySelector('#pExp').onclick = () => {
      const { builtin, ...clean } = p;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(clean, null, 1)], { type: 'application/json' }));
      a.download = (p.name || 'preset').replace(/[^\w -]/g, '_') + '.json';
      a.click();
    };
    box.querySelector('#pDel')?.addEventListener('click', async e => {
      if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Click again to delete'; return; }
      await fetch('/api/preset-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name }) });
      presetsDialog();
    });
    box.querySelector('#pApply').onclick = async e => {
      const btn = e.target;
      if (plan.buys.length && total != null && total > (snap.gold ?? 0)) return wrap.querySelector('#pErr').textContent = 'not enough gold';
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = plan.buys.length ? `Confirm: run ${plan.steps.length} steps, spend ${(total ?? 0).toLocaleString()} gold` : `Confirm: run ${plan.steps.length} steps`;
        return;
      }
      btn.disabled = true;
      await runPlan(plan, box.querySelector('#pLog'));
      btn.textContent = 'Done';
    };
  };
  draw();
}

async function runPlan(plan, log) {
  const ctx = { cat: { ...plan.catRef }, tab: {}, leftCat: null };
  const line = (t, cls_) => { const li = document.createElement('li'); li.textContent = t; if (cls_) li.className = cls_; log.appendChild(li); li.scrollIntoView({ block: 'nearest' }); return li; };
  autoRefreshPaused = true;
  try {
    // safety net: current layout can be re-applied to undo names/colours/priorities/order
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    await savePreset(captureLayout(`Backup ${stamp}`));
    line(`Saved current layout as preset "Backup ${stamp}"`, 'ok');
    for (const s of plan.steps) {
      if (!snap.stashOpen) { line('Stopped: stash closed in game', 'bad'); return; }
      const li = line(s.text + ' …');
      try {
        await s.run(ctx);
        li.textContent = '✓ ' + s.text;
        li.className = 'ok';
      } catch (e) {
        li.textContent = '✗ ' + s.text + ' — ' + e.message;
        li.className = 'bad';
        line('Stopped. Everything before this step is applied; you can re-run the preset to continue.', 'bad');
        return;
      }
    }
    line('Preset applied.', 'ok');
  } finally {
    autoRefreshPaused = false;
    await load();
  }
}

var autoRefreshPaused = false;
document.querySelector('header .spacer').insertAdjacentHTML('beforebegin', '<button id="presetsBtn">Presets</button>');
$('presetsBtn').onclick = () => {
  if (!snap || !GD) return;
  presetsDialog();
};
