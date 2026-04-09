/*
 * Script for the options page. Allows the user to enter their OpenAI API key
 * and select a model. Settings are persisted using chrome.storage.local.
 */

/* global chrome */

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('api-key');
  const modelSelect = document.getElementById('model');
  // Vision model select element for multimodal tasks
  const visionSelect = document.getElementById('vision-model');
  const stealthCheckbox = document.getElementById('stealth-mode');
  const messageEl = document.getElementById('save-message');

  // Load existing settings. We include the vision model so users can select a
  // multimodal engine such as GPT‑4o for OCR and vision tasks.
  const items = await chrome.storage.local.get(['openai_key', 'openai_model', 'openai_vision_model', 'stealth_mode']);
  if (items.openai_key) {
    apiKeyInput.value = items.openai_key;
  }
  if (items.openai_model) {
    modelSelect.value = items.openai_model;
  }
  if (items.openai_vision_model) {
    visionSelect.value = items.openai_vision_model;
  }
  if (typeof items.stealth_mode !== 'undefined') {
    stealthCheckbox.checked = Boolean(items.stealth_mode);
  }

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    const visionModel = visionSelect.value;
    const stealth = stealthCheckbox.checked;
    await chrome.storage.local.set({ openai_key: key, openai_model: model, openai_vision_model: visionModel, stealth_mode: stealth });
    messageEl.style.display = 'block';
    setTimeout(() => {
      messageEl.style.display = 'none';
    }, 2000);
  });
});