// StashManager - auto-sort / bulk move.
// Rules (first match wins):  1. own rules (saved searches -> target tab)
//                            2. game tab priorities, in game order (folders, then tabs: left -> right)
//                            3. optional fallback tab for unmatched items
// Items already in one of their matching tabs stay. Planned here, executed by the host (mover.py).
// Uses globals: snap, GD, $, esc, load, render, readFilters, matchItem, textMatcher, itemLabel,
// rarityOf, openModal, closeModal, priorityMatches, TAB_STYLES.
'use strict';

let RULES = [];
async function loadRules() { RULES = await (await fetch('/api/rules')).json(); }
async function saveRules() {
  await fetch('/api/rules-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: RULES }) });
}

const tabsInGameOrder = () => [...snap.categories].sort((a, b) => a.order - b.order)
  .flatMap(c => snap.tabs.filter(t => t.categoryId === c.id).sort((a, b) => a.order - b.order));
const tabName_ = id => snap.tabs.find(t => t.id === id)?.name ?? `Tab ${id}`;

function describeFilter(f) {
  const parts = [];
  if (f.q) parts.push(`"${f.q}"`);
  for (const a of f.affixes || []) parts.push(`${a.text || 'any affix'}${a.tier ? ` T${a.tier}+` : ''}${a.roll ? ` ${a.roll}%+` : ''}`);
  if (f.tierCount) parts.push(`${f.tierCount}× T${f.tierMin}+`);
  if (f.types?.length) parts.push(f.types.map(t => GD?.bases.get(t)?.display || t).join('/'));
  if (f.rarities?.length) parts.push(f.rarities.join('/'));
  if (f.lp) parts.push(`LP${f.lp}+`);
  if (f.ww) parts.push(`WW${f.ww}+`);
  if (f.fp) parts.push(`FP${f.fp}+`);
  if (f.corr) parts.push(f.corr === '1' ? 'corrupted' : 'uncorrupted');
  if (f.openP) parts.push('open prefix');
  if (f.openS) parts.push('open suffix');
  return parts.join(' · ') || 'everything';
}

// ---------------------------------------------------------------- planner

function occupancy(c) {
  const cells = new Set();
  for (const it of c.items) for (let dx = 0; dx < it.w; dx++) for (let dy = 0; dy < it.h; dy++) cells.add((it.x + dx) + ',' + (it.y + dy));
  return cells;
}
function findSpot(c, cells, w, h) {
  for (let y = c.h - h; y >= 0; y--) // top-left first (grid origin bottom-left)
    for (let x = 0; x + w <= c.w; x++) {
      let ok = true;
      for (let dx = 0; dx < w && ok; dx++) for (let dy = 0; dy < h && ok; dy++) if (cells.has((x + dx) + ',' + (y + dy))) ok = false;
      if (ok) return [x, y];
    }
  return null;
}

// opts.fallback: null | 'tab:<id>' | 'folder:<id>' -> ordered list of tab ids
function fallbackTabs(fb) {
  if (!fb) return [];
  const [kind, id] = fb.split(':');
  if (kind === 'tab') return [+id];
  return snap.tabs.filter(t => t.categoryId === +id).sort((a, b) => a.order - b.order).map(t => t.id);
}

function planSort(opts) {
  const order = tabsInGameOrder();
  const rules = RULES.filter(r => r.enabled !== false && snap.tabs.some(t => t.id === r.toTab))
    .map(r => ({ ...r, tm: textMatcher(r.filter.q) }));
  const prioTabs = opts.usePriorities ? order.filter(t => t.priority) : [];
  const cells = Object.fromEntries(snap.containers.map(c => [c.index, occupancy(c)]));
  const moves = [], stats = { stay: 0, unmatched: 0, full: 0, byTarget: {}, cap: {} };
  const capOf = id => (stats.cap[id] ||= { items: 0, cells: 0, overflow: 0 });

  const retry = [];
  const sources = order.filter(t => opts.scope === 'all' || opts.scope.includes(t.id));
  for (const src of sources) {
    const c = snap.containers[src.id];
    if (!c) continue;
    for (const it of c.items) {
      let via = 'rule';
      let cand = rules.filter(r => matchItem(it, r.filter, r.tm)).map(r => r.toTab);
      if (!cand.length) { via = 'priority'; cand = prioTabs.filter(t => priorityMatches(t.priority, it)).map(t => t.id); }
      const fb = fallbackTabs(opts.fallback);
      if (!cand.length && fb.length) { via = 'fallback'; cand = [...fb]; }
      if (!cand.length) { stats.unmatched++; continue; }
      if (via !== 'fallback') { const k = capOf(cand[0]); k.items++; k.cells += it.w * it.h; }
      if (cand.includes(src.id)) { stats.stay++; continue; }
      let placed = false;
      // overflow: matching tabs full -> fallback tab (e.g. Dump), like the game's overflow behaviour
      for (const t of fb) if (!cand.includes(t) && t !== src.id) cand = [...cand, t];
      for (const dst of cand) {
        const dc = snap.containers[dst];
        const spot = dc && findSpot(dc, cells[dst], it.w, it.h);
        if (!spot) continue;
        for (let dx = 0; dx < it.w; dx++) for (let dy = 0; dy < it.h; dy++) {
          cells[dst].add((spot[0] + dx) + ',' + (spot[1] + dy));
          cells[src.id].delete((it.x + dx) + ',' + (it.y + dy));
        }
        // 'priority' only when the game itself would route it there (shift-click does it, no tab switching)
        const how = via === 'priority' && dst === cand[0] ? 'priority' : via === 'priority' ? 'fallback' : via;
        moves.push({ id: it.id, name: itemLabel(it), fromTab: src.id, x: it.x, y: it.y, toTab: dst, tx: spot[0], ty: spot[1], via: how, it });
        stats.byTarget[dst] = (stats.byTarget[dst] || 0) + 1;
        placed = true;
        break;
      }
      if (!placed) retry.push({ it, src, cand, via });
    }
  }
  // second pass: items that found no room retry now that later moves freed space; they run last
  for (const { it, src, cand, via } of retry) {
    let placed = false;
    for (const dst of cand) {
      const dc = snap.containers[dst];
      const spot = dc && findSpot(dc, cells[dst], it.w, it.h);
      if (!spot) continue;
      for (let dx = 0; dx < it.w; dx++) for (let dy = 0; dy < it.h; dy++) {
        cells[dst].add((spot[0] + dx) + ',' + (spot[1] + dy));
        cells[src.id].delete((it.x + dx) + ',' + (it.y + dy));
      }
      const how = via === 'priority' && dst === cand[0] ? 'priority' : via === 'priority' ? 'fallback' : via;
      moves.push({ id: it.id, name: itemLabel(it), fromTab: src.id, x: it.x, y: it.y, toTab: dst, tx: spot[0], ty: spot[1], via: how, it });
      stats.byTarget[dst] = (stats.byTarget[dst] || 0) + 1;
      placed = true;
      break;
    }
    if (!placed) { stats.full++; if (via !== 'fallback') capOf(cand[0]).overflow++; else stats.fbFull = (stats.fbFull || 0) + 1; }
  }
  // already grouped by source tab (planned in that order); keep it - free cells were simulated in this order
  return { moves, stats, opts };
}

// ---------------------------------------------------------------- UI

function tabOptions(selected) {
  return tabsInGameOrder().map(t => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
}

async function sortDialog() {
  await loadRules();
  const other = snap.categories.find(c => /^(other|dump)/i.test(c.name));
  const opts = { usePriorities: true, fallback: other ? `folder:${other.id}` : null, scope: 'all' };
  const wrap = openModal(`
    <h3>Auto-sort</h3>
    <div class="muted">First match wins: your rules (top to bottom) → game tab priorities (left → right, like the game) → fallback.
      Items already in a matching tab stay.</div>
    <label>Your rules (saved searches → tab)</label>
    <div id="rList"></div>
    <div class="row"><button id="rAdd">+ Rule from current search</button>
      <select id="rTab">${tabOptions(selTab)}</select>
      <input type="text" id="rName" placeholder="rule name (optional)"></div>
    <div class="two">
      <div>
        <label class="prio"><input type="checkbox" id="oPrio" checked> use game tab priorities</label>
        <label>Unmatched items / overflow when target tabs are full</label>
        <select id="oFallback"><option value="">leave where they are</option>
          ${[...snap.categories].sort((a, b) => a.order - b.order).map(c =>
            `<option value="folder:${c.id}"${opts.fallback === 'folder:' + c.id ? ' selected' : ''}>folder: ${esc(c.name)} (all its tabs, in order)</option>`).join('')}
          ${tabsInGameOrder().map(t => `<option value="tab:${t.id}">tab: ${esc(t.name)}</option>`).join('')}</select>
      </div>
      <div>
        <label>Sort items from</label>
        <select id="oScope"><option value="all">all tabs</option>${tabOptions(-1)}</select>
      </div>
    </div>
    <div class="preview" id="sPrev"></div>
    <details id="sCapD" open><summary>space forecast</summary><table class="cap" id="sCap"></table></details>
    <details id="sDet"><summary>moves</summary><ol class="steps" id="sMoves"></ol></details>
    <div class="jobbar" id="jBar" hidden><div id="jFill"></div></div>
    <ol class="plog" id="jLog"></ol>
    <div class="err" id="sErr"></div>
    <div class="btns"><button id="sCancel" class="danger" hidden>Stop</button><span style="flex:1"></span>
      <button class="primary" id="sRun">Move items</button><button data-close>Close</button></div>`);

  let plan = null;
  const drawRules = () => {
    wrap.querySelector('#rList').innerHTML = RULES.length ? RULES.map((r, i) => `<div class="rule${r.enabled === false ? ' off' : ''}">
        <input type="checkbox" data-en="${i}"${r.enabled === false ? '' : ' checked'}>
        <span class="rn">${esc(r.name || describeFilter(r.filter))}</span>
        <span class="muted">${esc(describeFilter(r.filter))}</span> →
        <select data-to="${i}">${tabOptions(r.toTab)}</select>
        <b data-up="${i}" title="higher precedence">↑</b><b data-dn="${i}" title="lower precedence">↓</b><b data-rm="${i}" title="delete">✕</b>
      </div>`).join('') : '<div class="muted">No rules yet. Build a search on the right panel (affixes, tiers, types…), then add it here.</div>';
  };
  const replan = () => {
    plan = planSort(opts);
    const s = plan.stats;
    const tgt = Object.entries(s.byTarget).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${esc(tabName_(+t))} +${n}`).join(', ');
    wrap.querySelector('#sPrev').innerHTML = `<b>${plan.moves.length}</b> items to move${tgt ? ` → ${tgt}` : ''}.<br>
      <span class="muted">${s.stay} already in a matching tab · ${s.unmatched} match nothing · ${s.full} matched but no free space</span>`;
    wrap.querySelector('#sDet summary').textContent = `${plan.moves.length} moves`;
    drawCapacity(wrap, plan, replan);
    wrap.querySelector('#sMoves').innerHTML = plan.moves.slice(0, 300).map(m =>
      `<li><span style="color:var(--r-${rarityOf(m.it)[1]})">${esc(m.name)}</span> <span class="muted">${esc(tabName_(m.fromTab))} → ${esc(tabName_(m.toTab))}</span></li>`).join('');
    const run = wrap.querySelector('#sRun');
    run.disabled = !plan.moves.length || !snap.stashOpen;
    run.title = !snap.stashOpen ? 'open the stash in game' : '';
    run.dataset.armed = '';
    run.textContent = `Move ${plan.moves.length} items`;
  };
  const changed = async () => { await saveRules(); drawRules(); replan(); };

  wrap.querySelector('#rAdd').onclick = async () => {
    const f = readFilters();
    if (!filtersActive(f)) { wrap.querySelector('#sErr').textContent = 'Current search is empty — set some filters first.'; return; }
    RULES.push({ name: wrap.querySelector('#rName').value.trim(), toTab: +wrap.querySelector('#rTab').value, filter: f, enabled: true });
    wrap.querySelector('#rName').value = '';
    await changed();
  };
  wrap.querySelector('#rList').addEventListener('click', async e => {
    const d = e.target.dataset;
    if (d.up !== undefined && +d.up > 0) [RULES[+d.up - 1], RULES[+d.up]] = [RULES[+d.up], RULES[+d.up - 1]];
    else if (d.dn !== undefined && +d.dn < RULES.length - 1) [RULES[+d.dn + 1], RULES[+d.dn]] = [RULES[+d.dn], RULES[+d.dn + 1]];
    else if (d.rm !== undefined) RULES.splice(+d.rm, 1);
    else return;
    await changed();
  });
  wrap.querySelector('#rList').addEventListener('change', async e => {
    const d = e.target.dataset;
    if (d.en !== undefined) RULES[+d.en].enabled = e.target.checked;
    if (d.to !== undefined) RULES[+d.to].toTab = +e.target.value;
    await changed();
  });
  wrap.querySelector('#oPrio').onchange = e => { opts.usePriorities = e.target.checked; replan(); };
  wrap.querySelector('#oFallback').onchange = e => { opts.fallback = e.target.value || null; replan(); };
  wrap.querySelector('#oScope').onchange = e => { opts.scope = e.target.value === 'all' ? 'all' : [+e.target.value]; replan(); };

  wrap.querySelector('#sRun').onclick = async e => {
    const btn = e.target;
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = `Confirm: move ${plan.moves.length} items`; return; }
    btn.disabled = true;
    const moves = plan.moves.map(({ it, ...m }) => m);
    const r = await fetch('/api/job-start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves, confirm: true }) });
    const j = await r.json();
    if (!r.ok) { wrap.querySelector('#sErr').textContent = j.error; btn.disabled = false; return; }
    watchJob(wrap, replan);
  };
  wrap.querySelector('#sCancel').onclick = () => fetch('/api/job-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  drawRules();
  replan();
}

// Per tab: items whose first-choice tab it is, fill %, overflow -> offer an overflow tab with the same rule.
function drawCapacity(wrap, plan, replan) {
  // group tabs that share the same rule (a tab + its overflow tabs): capacity is their combined space
  const key = t => JSON.stringify(canonPrio(t.priority));
  const groups = new Map();
  for (const [id, k] of Object.entries(plan.stats.cap)) {
    const t = snap.tabs.find(x => x.id === +id);
    if (!t) continue;
    const g = groups.get(key(t)) || { first: t, k: { items: 0, cells: 0, overflow: 0 } };
    g.k.items += k.items; g.k.cells += k.cells; g.k.overflow += k.overflow;
    groups.set(key(t), g);
  }
  const rows = [...groups.entries()].map(([pk, g]) => {
    const members = tabsInGameOrder().filter(t => t.priority && key(t) === pk);
    const space = members.reduce((n, t) => n + (snap.containers[t.id] ? snap.containers[t.id].w * snap.containers[t.id].h : 0), 0);
    return { t: g.first, members, k: g.k, fill: space ? g.k.cells / space : 0 };
  }).sort((a, b) => b.k.overflow - a.k.overflow || b.fill - a.fill);

  const baseName = n => n.replace(/\s+\d+$/, '');
  wrap.querySelector('#sCap').innerHTML = '<tr><th>tab</th><th>items</th><th>fill</th><th>no room</th><th></th></tr>'
    + rows.map(({ t, members, k, fill }) => {
      const label = members.length > 1 ? `${t.name} (+${members.length - 1} overflow)` : t.name;
      const next = `${baseName(t.name)} ${members.length + 1}`;
      return `<tr class="${k.overflow ? 'bad' : fill > 0.85 ? 'warn' : ''}">
        <td>${esc(label)}</td><td>${k.items}</td><td>${Math.round(fill * 100)}%</td><td>${k.overflow || ''}</td>
        <td>${k.overflow || fill > 0.85 ? `<button data-buy="${members[members.length - 1].id}" data-name="${esc(next)}">+ buy "${esc(next)}"</button>` : ''}</td></tr>`;
    }).join('')
    + (plan.stats.fbFull ? (() => {
        const fb = fallbackTabs(plan.opts.fallback), last = snap.tabs.find(t => t.id === fb[fb.length - 1]);
        return `<tr class="bad"><td>fallback (${fb.length} dump tabs)</td><td>${fb.reduce((n, id) => n + (plan.stats.byTarget[id] || 0), 0)} in</td><td></td>`
          + `<td>${plan.stats.fbFull}</td><td>${last ? `<button data-buy="${last.id}" data-name="Dump ${fb.length + 1}" data-dump="1">+ buy "Dump ${fb.length + 1}"</button>` : ''}</td></tr>`;
      })() : '');

  wrap.querySelectorAll('[data-buy]').forEach(b => b.onclick = async () => {
    if (wrap.dataset.buying) return; // one purchase at a time
    const t = snap.tabs.find(x => x.id === +b.dataset.buy);
    if (b.dataset.armed !== '1') {
      const [cost] = await op('tabCosts', { count: 1 });
      b.dataset.armed = '1';
      b.textContent = `confirm: ${cost.toLocaleString()} gold`;
      return;
    }
    wrap.dataset.buying = '1';
    wrap.querySelectorAll('[data-buy]').forEach(x => x.disabled = true);
    b.textContent = 'buying…';
    try {
      const pt = { name: b.dataset.name, icon: t.icon, color: t.color, priority: b.dataset.dump ? null : t.priority };
      const id = await buyTab(t.categoryId, pt.name);
      await cfgTab(id, pt, t.categoryId);
      await reorderTab(id, t.order + 1); // right after the last tab of the group: game checks left to right
    } catch (e) { wrap.querySelector('#sErr').textContent = e.message; }
    delete wrap.dataset.buying;
    replan(); // redraws the forecast from the fresh snapshot
  });
}

async function watchJob(wrap, onDone) {
  const bar = wrap.querySelector('#jBar'), fill = wrap.querySelector('#jFill'), log = wrap.querySelector('#jLog');
  const cancel = wrap.querySelector('#sCancel');
  bar.hidden = false; cancel.hidden = false;
  window.autoRefreshPaused = true;
  try {
    for (;;) {
      const st = await (await fetch('/api/job')).json();
      fill.style.width = `${Math.round(100 * (st.done + st.skipped) / Math.max(1, st.total))}%`;
      log.innerHTML = st.log.slice(-60).map(l => `<li class="${l.kind === 'ok' ? 'ok' : l.kind === 'bad' ? 'bad' : ''}">${esc(l.msg)}</li>`).join('');
      log.scrollTop = log.scrollHeight;
      if (!document.body.contains(wrap) || !['queued', 'running'].includes(st.state)) break;
      await new Promise(r => setTimeout(r, 700));
    }
  } finally {
    cancel.hidden = true;
    window.autoRefreshPaused = false;
    await load();
    if (document.body.contains(wrap)) onDone();
  }
}

document.querySelector('header .spacer').insertAdjacentHTML('beforebegin', '<button id="sortBtn">Auto-sort</button>');
$('sortBtn').onclick = () => { if (snap && GD) sortDialog(); };
