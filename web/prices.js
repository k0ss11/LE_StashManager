// StashManager - market prices (Last Epoch Overlay public API, via host /api/prices).
// Community-observed ASKING prices, not sales. Attribution required: shown in the header.
// Uses globals: snap, $, esc, render, runSearch, filtersActive, readFilters, matches.
'use strict';

let PRICES = null;

async function loadPrices() {
  try {
    const r = await fetch('/api/prices');
    const j = await r.json();
    if (j.ok) PRICES = j;
  } catch {}
  if (snap) render();
}

const fmtGold = g => g >= 1e9 ? (g / 1e9).toFixed(2) + 'B' : g >= 1e6 ? (g / 1e6).toFixed(g >= 1e8 ? 0 : 1) + 'M'
  : g >= 1e3 ? Math.round(g / 1e3) + 'k' : String(Math.round(g));

// Price estimate for one item: { gold, count, how } or null.
function priceOf(it) {
  if (!PRICES || !it) return null;
  if (it.type >= 25 && it.type <= 33) { // idols: exact affix combination, else same affixes any tier
    const affs = (it.affixes || []).map(a => `${a.id}:${a.tier - 1}`).sort();
    const exact = PRICES.idols?.[`${it.type}:${it.subType}:${affs.join(',')}${it.corrupted ? ':c' : ''}`];
    if (exact) return { gold: exact[0], count: exact[1], how: 'idol, exact affixes', low: exact[2] !== 'available' };
    // fallback: same affixes listed at tiers <= this item's tiers (never a better idol) -> highest of those
    const ids = (it.affixes || []).map(a => String(a.id)).sort();
    const combos = PRICES.idolsLoose?.[`${it.type}:${it.subType}:${ids.join(',')}${it.corrupted ? ':c' : ''}`] || [];
    const mine = Object.fromEntries((it.affixes || []).map(a => [a.id, a.tier - 1]));
    const notBetter = combos.filter(([tiers]) => Object.entries(tiers).every(([id, t]) => t <= (mine[id] ?? -1)));
    if (!notBetter.length) return null;
    const best = notBetter.reduce((b, c) => (c[1] > b[1] ? c : b));
    return { gold: best[1], count: best[2], how: 'idol, same affixes at lower or equal tiers', low: true };
  }
  if (it.rarity === 9) { // legendary: no direct feed -> max(unique base, best affix)
    const base = PRICES.uniques[`${it.uniqueId}:0`];
    let best = null;
    for (const a of it.affixes || []) {
      const q = PRICES.affixes[`${it.type}:${a.id}:${a.tier - 1}`];
      if (q && (!best || q[0] > best[0])) best = [q[0], a];
    }
    if (!base && !best) return null;
    const gold = Math.max(base?.[0] || 0, best?.[0] || 0);
    return { gold, count: null, low: true, how: `legendary estimate: unique LP0 ${base ? fmtGold(base[0]) : '?'}`
      + `${best ? `, best affix T${best[1].tier} ${best[1].name} ${fmtGold(best[0])}` : ''}` };
  }
  if (it.rarity === 7 || it.rarity === 8) { // unique / set: overall price per LP
    const q = PRICES.uniques[`${it.uniqueId}:${it.lp || 0}`];
    return q ? { gold: q[0], count: q[1], how: `unique, LP ${it.lp || 0}`, low: q[2] !== 'available' } : null;
  }
  if (it.exalted || (it.rarity >= 1 && it.rarity <= 4)) { // best priced affix (T6+ dominate exalted value)
    let best = null;
    for (const a of it.affixes || []) {
      const q = PRICES.affixes[`${it.type}:${a.id}:${a.tier - 1}`];
      if (q && (!best || q[0] > best.gold)) best = { gold: q[0], count: q[1], how: `best affix: T${a.tier} ${a.name}`, low: q[2] !== 'available' };
    }
    return best;
  }
  return null;
}

// totals count confident prices only (low-volume quotes and estimates still show per item)
function tabValue(tabId) {
  const c = snap?.containers[tabId];
  return c ? c.items.reduce((s, it) => { const p = priceOf(it); return s + (p && !p.low ? p.gold : 0); }, 0) : 0;
}

// ---------------------------------------------------------------- hooks into the page

// header: total value + attribution
document.querySelector('header .spacer').insertAdjacentHTML('beforebegin',
  `<span class="pill" id="stashValue" title="sum of estimated prices">value ?</span>
   <a id="priceAttr" class="muted" target="_blank" rel="noopener" href="https://www.leoverlay.com/developers"
      style="font-size:11px">prices: Last Epoch Overlay</a>`);

const _render = render;
render = function () {
  _render();
  if (!snap || !PRICES) return;
  const total = snap.containers.reduce((s, c) => s + tabValue(c.index), 0);
  $('stashValue').textContent = `value ~${fmtGold(total)}`;
  $('stashValue').title = `asking value of items with a confident price (estimates excluded) (cycle ${PRICES.cycle}, fetched ${new Date(PRICES.fetchedAt * 1000).toLocaleTimeString()})`;
  // per-tab value next to counts
  document.querySelectorAll('#tabs .tab[data-tab]').forEach(el => {
    const v = tabValue(+el.dataset.tab);
    if (v) el.insertAdjacentHTML('beforeend', `<span class="tval">${fmtGold(v)}</span>`);
  });
  // price tag on valuable items in the grid
  document.querySelectorAll('#grid .item').forEach(el => {
    const [t, i] = el.dataset.key.split(':').map(Number);
    const p = priceOf(snap.containers[t].items[i]);
    if (p && p.gold >= 50000) el.insertAdjacentHTML('afterbegin', `<span class="ptag${p.low ? ' low' : ''}">${fmtGold(p.gold)}</span>`);
  });
  // results: price at the end of each line
  document.querySelectorAll('#results .res').forEach(el => {
    const [t, i] = el.dataset.key.split(':').map(Number);
    const p = priceOf(snap.containers[t].items[i]);
    if (p) el.querySelector('.where').insertAdjacentHTML('beforeend', ` · <b class="pgold">~${fmtGold(p.gold)}</b>`);
  });
};

const _showTip = showTip;
showTip = function (it, x, y) {
  _showTip(it, x, y);
  const p = priceOf(it);
  const tip = $('tip');
  tip.insertAdjacentHTML('beforeend', p
    ? `<div class="tprice">~${fmtGold(p.gold)} gold <span class="muted">${p.count != null ? p.count + ' listings · ' : ''}${esc(p.how)}${p.low ? ' · estimate' : ''}</span></div>`
    : (PRICES ? '<div class="tprice muted">no price data</div>' : ''));
};

// search: minimum price filter
$('lvl').closest('.row').insertAdjacentHTML('afterend',
  '<div class="row">price ≥ <input type="number" id="minPrice" min="0" step="10000" value="0"> gold</div>');
const _readFilters = readFilters;
readFilters = function () { const f = _readFilters(); f.minPrice = +$('minPrice').value || 0; return f; };
const _filtersActive = filtersActive;
filtersActive = function (f) { return _filtersActive(f) || !!f.minPrice; };
const _matchItem = matchItem;
matchItem = function (it, f, tm) {
  if (f.minPrice && !((priceOf(it)?.gold || 0) >= f.minPrice)) return false;
  return _matchItem(it, f, tm);
};

loadPrices();
setInterval(loadPrices, 60 * 60 * 1000);
// the idol feed fills in the background on first use (~90 s): re-read until it is there
const idolPoll = setInterval(() => { if (PRICES && !PRICES.idolsPending) clearInterval(idolPoll); else loadPrices(); }, 30000);
const _applyFilters = applyFilters;
applyFilters = function (f) { _applyFilters(f); $('minPrice').value = f.minPrice || 0; };
