/*
 * Script for the popup. Provides a button that opens the options page where
 * users can configure their OpenAI API key and model.
 */

/* global chrome */

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});