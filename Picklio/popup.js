/*
 * Script for the Picklio popup. It lets users launch Quick Snap from the
 * toolbar and open settings.
 */

/* global chrome */

document.getElementById('quick-snap').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'toolbarQuickSnap' });
  window.close();
});

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
