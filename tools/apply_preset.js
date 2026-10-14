// Apply a stash preset from the command line using the exact planner/executor code of the web page
// (web/presets.js + helpers from index.html / configure.js), talking to host.py.
//
//   node tools/apply_preset.js presets/artem_full.json [--dry] [--wait-open]
//
// Saves a "Backup <date>" preset first. Needs host.py running and (unless --dry) the stash open.
// (no 'use strict': eval'd page functions must land in this scope)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOST = 'http://127.0.0.1:8100';
const args = process.argv.slice(2);
const presetPath = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry');
const WAIT_OPEN = args.includes('--wait-open');

// ---- load page code (function declarations only) into this module scope
const pageSrc = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const cfgSrc = fs.readFileSync(path.join(ROOT, 'web/configure.js'), 'utf8');
const preSrc = fs.readFileSync(path.join(ROOT, 'web/presets.js'), 'utf8');
const pick = (src, name) => {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  const start = src.slice(Math.max(0, i - 6), i) === 'async ' ? i - 6 : i;
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && !--d) return src.slice(start, k + 1);
  }
};
const constBlock = (src, name) => { const m = src.match(new RegExp(`const ${name} = [\\s\\S]*?\\];`)); return m[0]; };

var snap = null, GD = null, ICONS = {}, AFFIX_IDS = new Map();
const esc = s => String(s ?? '');
eval([
  constBlock(cfgSrc, 'PRIO_RARITY'), constBlock(cfgSrc, 'POTENTIAL'),
  ...['fmtValue', 'enrich', 'itemLabel'].map(n => pick(pageSrc, n)),
  pick(cfgSrc, 'priorityMatches'),
  ...['canonPrio', 'describePrio', 'captureLayout', 'planPreset', 'createFolder', 'cfgFolder', 'buyTab', 'cfgTab',
    'reorderFolder', 'reorderTab'].map(n => pick(preSrc, n)),
  "const norm = s => (s || '').trim().toLowerCase();",
  'const samePrio = (a, b) => JSON.stringify(canonPrio(a)) === JSON.stringify(canonPrio(b));',
].join(';\n'));

// ---- shims the page code expects
async function api(p, body) {
  const r = await fetch(HOST + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || p);
  return j;
}
async function load() {
  const s = await api('/api/snapshot');
  s.containers.forEach(c => c.items.forEach(enrich));
  snap = s;
}
async function op(name, a, confirm = false) {
  const j = await api('/api/op', { op: name, args: a, confirm });
  return j.value;
}
async function waitFor(pred, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await load();
    if (pred(snap)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  const gd = await api('/api/gamedata');
  GD = {
    bases: new Map(gd.bases.map(b => [b.id, { ...b, subs: new Map(b.subs.map(x => [x.id, x])) }])),
    uniques: new Map(gd.uniques.map(u => [u.id, u])),
    affixes: new Map(gd.affixes.map(a => [a.id, a])),
  };
  if (WAIT_OPEN) {
    console.log('waiting for the stash to be open in game...');
    for (;;) {
      const st = await api('/api/state');
      if (st.stashOpen) { await new Promise(r => setTimeout(r, 3000)); if ((await api('/api/state')).stashOpen) break; }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  await load();
  const opts = { reuse: true, leftoverFolder: 'Unsorted', clearLeftoverPrio: true };
  const plan = planPreset(preset, opts);
  let costs = [];
  if (plan.buys.length && snap.stashOpen) costs = await op('tabCosts', { count: plan.buys.length });
  const total = costs.reduce((a, b) => a + b, 0);
  console.log(`preset "${preset.name}": reuse ${plan.wanted.length - plan.buys.length}, buy ${plan.buys.length}`
    + ` (${costs.length ? total.toLocaleString() + ' gold' : 'cost needs open stash'}), gold ${snap.gold?.toLocaleString()}`);
  plan.steps.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.text}`));
  if (DRY) return;
  if (!snap.stashOpen) throw new Error('stash is not open');
  if (total > (snap.gold ?? 0)) throw new Error('not enough gold');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  await api('/api/preset-save', { preset: captureLayout(`Backup ${stamp}`) });
  console.log(`saved current layout as "Backup ${stamp}"`);

  const ctx = { cat: { ...plan.catRef }, tab: {}, leftCat: null };
  for (const [i, s] of plan.steps.entries()) {
    const st = await api('/api/state');
    if (!st.stashOpen) throw new Error(`stopped before step ${i + 1}: stash closed`);
    process.stdout.write(`${String(i + 1).padStart(2)}. ${s.text} ... `);
    await s.run(ctx);
    console.log('ok');
  }
  await load();
  console.log(`done. gold now ${snap.gold?.toLocaleString()}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
