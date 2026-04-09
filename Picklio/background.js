/*
 * Service worker for the Study Buddy extension.
 *
 * This script registers context‑menu entries for answering highlighted text
 * and scanning images. When a user selects text and chooses an option
 * (answer, hint or pointers) the service worker fetches a response from the
 * OpenAI API and sends it back to the active tab for display. When a user
 * right‑clicks on an image and selects the Vision Scan option the image is
 * downloaded, converted to a data URI and sent to OpenAI’s vision model.
 *
 * The API key and preferred model are stored via chrome.storage. If the
 * extension is used without setting an API key the options page opens
 * automatically. See options.html for details on storing the API key.
 */

/* global chrome */

// Identifiers for context menu items
const MENU_IDS = {
  ANSWER: 'answer',
  HINT: 'hint',
  POINTERS: 'pointers',
  VISION: 'vision',
  QUICK: 'quick_snap',
  // New menu entry for OCR extraction from images
  OCR: 'ocr'
  ,
  // New menu entry for explanations. This mode instructs the model to
  // explain why the correct answer is correct and why the other options
  // are incorrect.
  EXPLAIN: 'explain'
};

// Track a pending Quick Snap request. When the user selects Quick Snap
// from the context menu the background script instructs the content
// script to display a snipping overlay. Once the user finishes
// selecting an area the content script sends a `quickSnapResult`
// message containing the captured text. We then use the stored key
// and model to generate an answer.
let pendingQuickSnap = null;

// Track a pending OCR request triggered from Quick Snap. When the selected
// text is empty we capture a screenshot and instruct the content script to
// crop it. Once cropped, the background script calls the vision API to
// extract the text.
let pendingOcrSnap = null;

/**
 * Send a message to a tab and return a promise that resolves with the
 * response. This helper wraps chrome.tabs.sendMessage so that the
 * background script can await a reply from the content script (for
 * example, to capture the text of the element under the cursor for
 * Quick Snap).
 *
 * @param {number} tabId Identifier of the tab to which the message is sent.
 * @param {any} message Payload to send.
 * @returns {Promise<any>} Response from the content script.
 */
function sendMessageWithResponse(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        resolve(response || {});
      });
    } catch (e) {
      resolve({});
    }
  });
}

// On install create context menus
chrome.runtime.onInstalled.addListener(() => {
  // Remove any old menus to avoid duplicates
  chrome.contextMenus.removeAll(() => {
    // Text based options
    chrome.contextMenus.create({
      id: MENU_IDS.ANSWER,
      title: 'Get Answer',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.HINT,
      title: 'Get Hint',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.POINTERS,
      title: 'Get Pointers',
      contexts: ['selection']
    });
    // Explanation option for understanding why the chosen answer is correct and why others are not.
    chrome.contextMenus.create({
      id: MENU_IDS.EXPLAIN,
      title: 'Explain Answer',
      contexts: ['selection']
    });
    // Image scanning option
    chrome.contextMenus.create({
      id: MENU_IDS.VISION,
      title: 'Vision Scan',
      contexts: ['image']
    });

    // OCR extraction for images
    chrome.contextMenus.create({
      id: MENU_IDS.OCR,
      title: 'Extract Text (OCR)',
      contexts: ['image']
    });

    // Quick Snap option: works on any page context. It captures text from the element under the cursor without requiring a selection.
    chrome.contextMenus.create({
      id: MENU_IDS.QUICK,
      title: 'Quick Snap',
      contexts: ['page']
    });
  });
});

/**
 * Retrieve stored settings such as the API key and model name.
 * Returns an object with at least the openai_key property when set.
 */
async function getSettings() {
  const items = await chrome.storage.local.get(['openai_key', 'openai_model', 'openai_vision_model']);
  return {
    key: items.openai_key || '',
    model: items.openai_model || 'gpt-4-turbo',
    // Use GPT‑4o as the default vision model since gpt‑4‑vision‑preview is deprecated【856385812041945†L873-L885】.
    visionModel: items.openai_vision_model || 'gpt-4o'
  };
}

/**
 * Create a prompt for the selected text based on the chosen mode.
 *
 * @param {string} mode One of 'answer', 'hint' or 'pointers'.
 * @param {string} text The highlighted question or text.
 * @returns {string} The user prompt to send to OpenAI.
 */
function buildPrompt(mode, text) {
  const trimmed = text.trim();
  /**
   * Detect whether the provided text resembles a multiple choice question. We look
   * for at least two lines that start with a letter followed by a punctuation
   * character such as a period, parenthesis or colon. This simple heuristic
   * catches common patterns like “A. option one”, “B) option two” etc.
   */
  function isMultipleChoice(str) {
    const lines = str.split(/\n+/).map(l => l.trim());
    let count = 0;
    for (const l of lines) {
      if (/^[A-Za-z][\)\.\:]/.test(l)) {
        count++;
      }
    }
    return count > 1;
  }

  if (mode === MENU_IDS.ANSWER) {
    // If the input looks like a multiple choice question, instruct the model to
    // choose from the provided options rather than generating a free‑form answer.
    if (isMultipleChoice(trimmed)) {
      return `You are given a multiple choice question with options. Identify the correct option and provide the letter and the exact text as it appears. Do not add extra commentary. Question and options:\n\n${trimmed}`;
    }
    return `Provide a concise answer to the following question: ${trimmed}`;
  }
  if (mode === MENU_IDS.HINT) {
    return `Provide a helpful hint to guide someone answering this question: ${trimmed}`;
  }
  // pointers
  if (mode === MENU_IDS.POINTERS) {
    return `Provide a brief outline with key points and phrases that should be included in an answer to: ${trimmed}`;
  }
  if (mode === MENU_IDS.EXPLAIN) {
    // When explaining a multiple choice question, instruct the model to select
    // the correct option and provide justification for why it is correct and
    // why the other options are wrong. For open questions, request a
    // step‑by‑step explanation of the reasoning behind the answer.
    if (isMultipleChoice(trimmed)) {
      return `You are given a multiple choice question with several options. Identify the correct option and provide the letter and exact text as it appears. Then explain why this option is correct and why each of the other options is not. Provide concise explanations for each choice.` + `\n\nQuestion and options:\n\n${trimmed}`;
    }
    return `Provide the correct answer to the following question and explain your reasoning step by step: ${trimmed}`;
  }
  // default fallback for unknown mode
  return `Provide a brief outline with key points and phrases that should be included in an answer to: ${trimmed}`;
}

/**
 * Convert a Blob or ArrayBuffer to a base64 data URI.
 *
 * @param {ArrayBuffer} buffer Raw data.
 * @param {string} mime MIME type.
 * @returns {string} Data URI.
 */
function arrayBufferToDataUri(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

/**
 * Download an image and return a data URI. Requires host permissions.
 *
 * @param {string} url Image URL.
 * @returns {Promise<string>} Data URI for the image.
 */
async function fetchImageAsDataUri(url) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') || 'image/png';
  const arrayBuffer = await response.arrayBuffer();
  return arrayBufferToDataUri(arrayBuffer, contentType);
}

/**
 * Send a request to OpenAI’s chat completion endpoint.
 *
 * @param {string} key API key.
 * @param {string} model Model name.
 * @param {Array} messages Array of message objects as per OpenAI API.
 * @param {number} maxTokens Maximum number of tokens for the response.
 * @returns {Promise<string>} The assistant’s reply.
 */
async function callChatCompletion(key, model, messages, maxTokens = 500) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  return content;
}

/**
 * Perform a Vision Scan on an image by calling the GPT‑4 vision model.
 *
 * @param {string} key API key.
 * @param {string} dataUri Data URI for the image.
 * @returns {Promise<string>} Description or answer produced by the vision model.
 */
async function performVisionScan(key, dataUri, model = 'gpt-4o') {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze the following image and describe the content or answer the question shown.' },
        { type: 'image_url', image_url: { url: dataUri } }
      ]
    }
  ];
  return callChatCompletion(key, model, messages, 800);
}

/**
 * Perform OCR on an image by calling the GPT‑4 vision model. The model is instructed
 * to extract all textual content from the provided image and return it verbatim.
 *
 * @param {string} key API key.
 * @param {string} dataUri Data URI for the image.
 * @returns {Promise<string>} The extracted text.
 */
async function performOCR(key, dataUri, model = 'gpt-4o') {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Extract all of the text from the following image. Return only the text without any commentary or explanation.' },
        { type: 'image_url', image_url: { url: dataUri } }
      ]
    }
  ];
  return callChatCompletion(key, model, messages, 800);
}

/**
 * Request an answer, hint or pointers from the text‑only model.
 *
 * @param {string} key API key.
 * @param {string} model Model name.
 * @param {string} mode Which menu option was selected.
 * @param {string} text Highlighted text.
 */
async function handleTextRequest(key, model, mode, text) {
  const prompt = buildPrompt(mode, text);
  const messages = [
    { role: 'system', content: 'You are a helpful study assistant.' },
    { role: 'user', content: prompt }
  ];
  return callChatCompletion(key, model, messages, 500);
}

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const settings = await getSettings();
    if (!settings.key) {
      // If no key is stored, open the options page to prompt the user
      chrome.runtime.openOptionsPage();
      return;
    }
    // If the Vision Scan was selected, handle image processing.
    if (info.menuItemId === MENU_IDS.VISION && info.srcUrl) {
      const dataUri = await fetchImageAsDataUri(info.srcUrl);
      // Pass the selected vision model; gpt‑4o is used as default replacement for the deprecated vision preview【856385812041945†L873-L885】.
      const result = await performVisionScan(settings.key, dataUri, settings.visionModel);
      chrome.tabs.sendMessage(tab.id, { type: 'result', result, mode: MENU_IDS.VISION });
      return;
    }

    // If OCR was selected on an image, extract the text using the vision model.
    if (info.menuItemId === MENU_IDS.OCR && info.srcUrl) {
      const dataUri = await fetchImageAsDataUri(info.srcUrl);
      const result = await performOCR(settings.key, dataUri, settings.visionModel);
      chrome.tabs.sendMessage(tab.id, { type: 'result', result, mode: MENU_IDS.OCR });
      return;
    }

    // Quick Snap: initiate a snipping overlay so the user can choose
    // exactly which part of the page should be answered. We record the
    // API key and model now and wait for the content script to send
    // back the selected text via a quickSnapResult message. The
    // handleTextRequest call will be triggered in the message listener
    // below once the user finishes the selection.
    if (info.menuItemId === MENU_IDS.QUICK) {
      // Choose a faster model when possible. If the user’s chosen
      // model already references 3.5 we reuse it; otherwise we use
      // gpt-3.5-turbo for speed.
      const quickModel = settings.model && settings.model.toLowerCase().includes('3.5') ? settings.model : 'gpt-3.5-turbo';
      pendingQuickSnap = { tabId: tab.id, key: settings.key, model: quickModel, visionModel: settings.visionModel };
      // Instruct the content script to show the snipping overlay.
      chrome.tabs.sendMessage(tab.id, { type: 'startQuickSnap' });
      return;
    }

    // For normal text selections, call the appropriate text model.
    if (info.selectionText) {
      const result = await handleTextRequest(settings.key, settings.model, info.menuItemId, info.selectionText);
      chrome.tabs.sendMessage(tab.id, { type: 'result', result, mode: info.menuItemId });
    }
  } catch (error) {
    const message = typeof error === 'string' ? error : error.message || 'Unknown error';
    chrome.tabs.sendMessage(tab.id, { type: 'result', result: `An error occurred: ${message}` });
  }
});

// Handle messages from content scripts. In particular we listen for
// quickSnapResult messages, which are sent when the user finishes
// drawing a selection via the snipping overlay. We then call the
// OpenAI API to obtain an answer based on the selected text.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === 'quickSnapResult') {
    // Clear the pending request first to avoid duplicate processing.
    const snap = pendingQuickSnap;
    pendingQuickSnap = null;
    if (!snap) {
      return;
    }
    // Only process the result if it comes from the expected tab.
    if (sender.tab && sender.tab.id === snap.tabId) {
      const text = (message.text || '').trim();
      // If no text was captured, attempt OCR by taking a screenshot and cropping
      // the user‑selected rectangle. The rectangle coordinates are provided
      // in message.rect. We set pendingOcrSnap so we know which tab and key
      // are awaiting a cropped image. Once the content script returns the
      // cropped region we will call the vision model to extract the text.
      if (!text) {
        const rect = message.rect;
        // If no rectangle information is provided, notify the user.
        if (!rect) {
          chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: 'No text captured.', mode: MENU_IDS.ANSWER });
          return;
        }
        // Mark this OCR request as originating from Quick Snap by setting fromQuickSnap to true.
        pendingOcrSnap = {
          tabId: snap.tabId,
          key: snap.key,
          model: snap.model,
          visionModel: snap.visionModel,
          fromQuickSnap: true
        };
        try {
          // Determine the window ID for the current tab.
          const windowId = sender.tab && sender.tab.windowId;
          const capturePromise = new Promise((resolve) => {
            try {
              chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
                resolve(dataUrl || null);
              });
            } catch (e) {
              resolve(null);
            }
          });
          capturePromise.then((dataUrl) => {
            if (!dataUrl) {
            chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: 'Failed to capture screenshot.', mode: MENU_IDS.ANSWER });
              pendingOcrSnap = null;
              return;
            }
            // Send the screenshot and rectangle to the content script for cropping
            chrome.tabs.sendMessage(snap.tabId, { type: 'cropForOcr', dataUri: dataUrl, rect });
          });
        } catch (err) {
          chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: 'Failed to capture screenshot.', mode: MENU_IDS.ANSWER });
          pendingOcrSnap = null;
        }
        return;
      }
      // If we have text, call OpenAI and send the answer back to the tab.
      handleTextRequest(snap.key, snap.model, MENU_IDS.ANSWER, text)
        .then((result) => {
          chrome.tabs.sendMessage(snap.tabId, { type: 'result', result, mode: MENU_IDS.ANSWER });
        })
        .catch((err) => {
          const msg = typeof err === 'string' ? err : err.message || 'Unknown error';
          chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: `An error occurred: ${msg}` });
        });
    }
  }

  // Handle a cropped image returned from the content script. When the content
  // script finishes cropping the selected rectangle it sends back a data URI
  // via a croppedForOcr message. We then call the vision API to perform OCR
  // and return the extracted text to the tab.
  if (message && message.type === 'croppedForOcr') {
    const snap = pendingOcrSnap;
    pendingOcrSnap = null;
    if (!snap) {
      return;
    }
    const dataUri = message.dataUri;
    if (!dataUri) {
      chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: 'Failed to crop image for OCR.', mode: MENU_IDS.OCR });
      return;
    }
    // First perform OCR using the selected vision model
    performOCR(snap.key, dataUri, snap.visionModel)
      .then(async (extracted) => {
        // If the OCR request originated from Quick Snap, immediately process the
        // extracted text to generate an answer using the text model. Otherwise
        // simply return the extracted text.
        if (snap.fromQuickSnap) {
          try {
            const answer = await handleTextRequest(snap.key, snap.model, MENU_IDS.ANSWER, extracted);
            chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: answer, mode: MENU_IDS.ANSWER });
          } catch (err) {
            const msg = typeof err === 'string' ? err : err.message || 'Unknown error';
            chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: `An error occurred: ${msg}`, mode: MENU_IDS.ANSWER });
          }
        } else {
          chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: extracted, mode: MENU_IDS.OCR });
        }
      })
      .catch((err) => {
        const msg = typeof err === 'string' ? err : err.message || 'Unknown error';
        // If Quick Snap, return error as an answer; else use OCR mode
        const m = snap.fromQuickSnap ? MENU_IDS.ANSWER : MENU_IDS.OCR;
        chrome.tabs.sendMessage(snap.tabId, { type: 'result', result: `An error occurred: ${msg}`, mode: m });
      });
    return;
  }
});