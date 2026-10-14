// StashManager - first-run helper: offers to extract item art when it is missing.
// Uses globals: $, esc, loadGameData, render, snap.
'use strict';

document.querySelector('header').insertAdjacentHTML('afterend',
  `<div id="firstrun" hidden>
     <span id="frText"></span>
     <button id="frGo">Extract item pictures</button>
     <span id="frLog" class="muted"></span>
   </div>`);

async function iconsStatus() {
  try { return await (await fetch('/api/icons-status')).json(); } catch { return null; }
}

async function checkFirstRun() {
  const st = await iconsStatus();
  if (!st) return;
  const box = $('firstrun');
  if (st.have && st.state !== 'running') {
    if (st.state === 'done') { await loadGameData(); if (snap) render(); }
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const running = st.state === 'running';
  $('frText').textContent = running
    ? 'Extracting item pictures from your game files…'
    : st.state === 'failed'
      ? 'Item picture extraction failed. Is the game running?'
      : 'Item pictures are not extracted yet. Takes about a minute; the game must be running. Reads only your local game files.';
  $('frGo').hidden = running;
  $('frLog').textContent = st.log.length ? st.log[st.log.length - 1] : '';
  if (running) setTimeout(checkFirstRun, 2000);
}

$('frGo').onclick = async () => {
  await fetch('/api/icons-extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  checkFirstRun();
};

checkFirstRun();
