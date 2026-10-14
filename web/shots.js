// StashManager - screenshot mode for the docs: open a view from the URL, e.g. /#shot=sort
// Views: overview, search, tooltip, configure-tab, presets, autosort. Only opens views; never acts.
// Uses globals: snap, GD, load, render, runSearch, applyFilters, showTip, tabDialog, presetsDialog,
// sortDialog, priceOf, PRICES.
'use strict';

(function () {
  const shot = (location.hash.match(/shot=([\w-]+)/) || [])[1];
  if (!shot) return;

  const ready = () => snap && GD && (typeof PRICES === 'undefined' || PRICES);
  const wait = () => new Promise(res => {
    const t = setInterval(() => { if (ready()) { clearInterval(t); res(); } }, 200);
  });

  // pick the tab with the most valuable items, it makes the nicest picture
  const bestTab = () => [...snap.tabs].sort((a, b) =>
    (snap.containers[b.id]?.items.reduce((s, it) => s + (priceOf(it)?.gold || 0), 0) || 0)
    - (snap.containers[a.id]?.items.reduce((s, it) => s + (priceOf(it)?.gold || 0), 0) || 0))[0];

  wait().then(async () => {
    $('auto').checked = false; // freeze the view
    const tab = bestTab();
    selTab = tab.id;
    render();
    switch (shot) {
      case 'search':
        applyFilters({ affixes: [{ text: 'health', tier: 5, roll: 0 }], affixMode: 'all', tierCount: 0, tierMin: 7 });
        runSearch();
        break;
      case 'tooltip': {
        const items = snap.containers[tab.id].items;
        const i = items.reduce((b, it, k) => ((priceOf(it)?.gold || 0) > (priceOf(items[b])?.gold || 0) ? k : b), 0);
        const el = document.querySelector(`#grid .item[data-key="${tab.id}:${i}"]`);
        const r = el.getBoundingClientRect();
        el.classList.add('hit');
        showTip(items[i], r.right, r.top);
        break;
      }
      case 'configure-tab':
        tabDialog(snap.tabs.find(t => t.priority) || tab);
        break;
      case 'presets':
        await presetsDialog();
        document.querySelector('.pitem:last-child')?.click();
        break;
      case 'autosort':
        await sortDialog();
        break;
    }
    document.body.dataset.shotReady = '1';
  });
})();
