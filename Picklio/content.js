/*
 * Content script injected into every page. It listens for messages from the
 * background worker and displays a floating panel with the returned answer or
 * description. The panel can be dismissed by clicking the close button. If
 * multiple results are requested the panel is reused and its content is
 * updated.
 */

/* global chrome */

(() => {
  const PANEL_ID = 'picklio-panel';

  // Track whether stealth mode is enabled. This flag controls whether
  // answers are revealed immediately or hidden behind a placeholder. It
  // is initialised from chrome.storage.local and updated via the
  // onChanged listener.
  let stealthModeEnabled = false;
  // Load the initial value from storage.
  chrome.storage.local.get(['stealth_mode'], (data) => {
    stealthModeEnabled = Boolean(data && data.stealth_mode);
  });
  // Listen for changes to the stealth_mode setting so that the
  // behaviour updates dynamically.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.stealth_mode) {
      stealthModeEnabled = Boolean(changes.stealth_mode.newValue);
    }
  });

  // Store the element that triggered the last context menu. This allows
  // Quick Snap to retrieve text from the element under the cursor.
  let lastContextElement = null;

  // Listen for context menu events to record the target element. Some pages
  // may call preventDefault on contextmenu; capturing the target here
  // ensures we know which element was right‑clicked when the menu opens.
  document.addEventListener('contextmenu', (event) => {
    lastContextElement = event.target;
  }, true);

  /**
   * Create or return the floating panel element. The panel is positioned in
   * the bottom right of the viewport and includes a close button.
   *
   * @returns {HTMLElement} The panel element.
   */
  function getOrCreatePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.position = 'fixed';
      panel.style.bottom = '20px';
      panel.style.right = '20px';
      panel.style.maxWidth = '30%';
      panel.style.background = '#ffffff';
      panel.style.color = '#333333';
      panel.style.border = '1px solid #ccc';
      panel.style.borderRadius = '8px';
      panel.style.padding = '12px';
      panel.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.15)';
      panel.style.zIndex = '2147483647';
      panel.style.maxHeight = '50%';
      panel.style.overflowY = 'auto';
      panel.style.fontFamily = 'sans-serif';

      // Header bar
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      header.style.marginBottom = '8px';
      header.style.fontWeight = 'bold';
      header.textContent = 'Picklio';
      panel.appendChild(header);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.background = 'transparent';
      closeBtn.style.border = 'none';
      closeBtn.style.color = '#666666';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.fontSize = '16px';
      closeBtn.style.lineHeight = '16px';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.addEventListener('click', () => {
        panel.remove();
      });
      header.appendChild(closeBtn);

      // Container for content
      const contentContainer = document.createElement('div');
      contentContainer.id = `${PANEL_ID}-content`;
      panel.appendChild(contentContainer);

      document.body.appendChild(panel);
    }
    return panel;
  }

  /**
   * Update the panel with new result content.
   *
   * @param {string} result Text content returned from OpenAI.
   * @param {string} mode Which action produced this result.
   */
  function updatePanel(result, mode) {
    const panel = getOrCreatePanel();
    const contentContainer = document.getElementById(`${PANEL_ID}-content`);
    contentContainer.innerHTML = '';
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    if (mode === 'answer') {
      title.textContent = 'Answer';
    } else if (mode === 'hint') {
      title.textContent = 'Hint';
    } else if (mode === 'pointers') {
      title.textContent = 'Pointers';
    } else if (mode === 'explain') {
      title.textContent = 'Explanation';
    } else {
      // For OCR mode and other unknown modes, adjust the title accordingly
      if (mode === 'ocr') {
        title.textContent = 'Extracted Text';
      } else if (mode === 'vision') {
        title.textContent = 'Vision Scan';
      } else {
        title.textContent = 'Result';
      }
    }
    contentContainer.appendChild(title);

    // Determine whether to hide the answer when stealth mode is enabled. For
    // vision, OCR and explanation results, the answer is textual and may
    // contain sensitive information; we apply the same stealth behaviour.
    const shouldHide = stealthModeEnabled && ['answer', 'hint', 'pointers', 'ocr', 'vision', 'explain'].includes(mode);

    if (shouldHide) {
      // Create placeholder that the user can click to reveal the answer
      const placeholder = document.createElement('div');
      placeholder.textContent = 'Answer hidden. Click to reveal.';
      placeholder.style.fontStyle = 'italic';
      placeholder.style.color = '#666';
      placeholder.style.cursor = 'pointer';
      placeholder.style.marginBottom = '4px';
      contentContainer.appendChild(placeholder);
      // Actual answer container (hidden initially)
      const answerDiv = document.createElement('div');
      answerDiv.style.whiteSpace = 'pre-wrap';
      answerDiv.style.lineHeight = '1.4';
      answerDiv.style.display = 'none';
      answerDiv.textContent = result;
      contentContainer.appendChild(answerDiv);
      placeholder.addEventListener('click', () => {
        placeholder.style.display = 'none';
        answerDiv.style.display = 'block';
      });
    } else {
      // Show the result directly
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.style.lineHeight = '1.4';
      p.textContent = result;
      contentContainer.appendChild(p);
    }
  }

  // Listen for messages from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'result') {
      updatePanel(message.result, message.mode);
    } else if (message.type === 'getClickedText') {
      // Respond with the text content of the last right‑clicked element. Use
      // innerText if available to respect rendered text; fall back to
      // textContent. If nothing is found return an empty string. The
      // response must be sent synchronously or via promise; we return
      // true to indicate asynchronous response.
      let text = '';
      try {
        if (lastContextElement) {
          text = (lastContextElement.innerText || lastContextElement.textContent || '').trim();
        }
      } catch (e) {
        text = '';
      }
      sendResponse({ text });
      return true;
    } else if (message.type === 'startQuickSnap') {
      // Trigger an interactive snipping overlay so the user can choose
      // which portion of the page to answer. The overlay captures
      // mouse events to draw a selection rectangle. Once the user
      // finishes the selection we extract the text and send it back
      // via a quickSnapResult message.
      startQuickSnap();
    } else if (message.type === 'cropForOcr') {
      // Handle cropping of a screenshot sent from the background. We draw the
      // selected rectangle on a canvas using the device pixel ratio to
      // accurately crop high DPI screenshots and then send the cropped
      // image back to the background script【162919989291563†L186-L192】.
      const { dataUri, rect } = message;
      if (!dataUri || !rect) {
        chrome.runtime.sendMessage({ type: 'croppedForOcr', dataUri: '' });
        return;
      }
      try {
        const img = new Image();
        img.onload = function () {
          const scale = window.devicePixelRatio || 1;
          const width = Math.abs(rect.x2 - rect.x1);
          const height = Math.abs(rect.y2 - rect.y1);
          const canvas = document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(
            img,
            rect.x1 * scale,
            rect.y1 * scale,
            width * scale,
            height * scale,
            0,
            0,
            width * scale,
            height * scale
          );
          const croppedUri = canvas.toDataURL('image/png');
          chrome.runtime.sendMessage({ type: 'croppedForOcr', dataUri: croppedUri });
        };
        img.onerror = function () {
          chrome.runtime.sendMessage({ type: 'croppedForOcr', dataUri: '' });
        };
        img.src = dataUri;
      } catch (err) {
        chrome.runtime.sendMessage({ type: 'croppedForOcr', dataUri: '' });
      }
    }
  });

  /**
   * Begin Quick Snap selection. This creates a full‑screen overlay that
   * allows the user to draw a rectangular area. Once the mouse is
   * released the selected region’s text is extracted and sent to the
   * background script.
   */
  function startQuickSnap() {
    // Prevent multiple overlays
    if (document.getElementById('quick-snap-overlay')) {
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'quick-snap-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.zIndex = '2147483646';
    overlay.style.cursor = 'crosshair';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.1)';

    const selRect = document.createElement('div');
    selRect.style.position = 'absolute';
    selRect.style.border = '2px dashed #00bcd4';
    selRect.style.backgroundColor = 'rgba(0, 188, 212, 0.1)';
    selRect.style.display = 'none';
    overlay.appendChild(selRect);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    function onMouseDown(ev) {
      ev.preventDefault();
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      selRect.style.display = 'block';
      selRect.style.left = startX + 'px';
      selRect.style.top = startY + 'px';
      selRect.style.width = '0px';
      selRect.style.height = '0px';
      overlay.addEventListener('mousemove', onMouseMove);
      overlay.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(ev) {
      if (!dragging) return;
      ev.preventDefault();
      const currentX = ev.clientX;
      const currentY = ev.clientY;
      const rectX = Math.min(currentX, startX);
      const rectY = Math.min(currentY, startY);
      const rectW = Math.abs(currentX - startX);
      const rectH = Math.abs(currentY - startY);
      selRect.style.left = rectX + 'px';
      selRect.style.top = rectY + 'px';
      selRect.style.width = rectW + 'px';
      selRect.style.height = rectH + 'px';
    }

    function onMouseUp(ev) {
      if (!dragging) return;
      ev.preventDefault();
      dragging = false;
      overlay.removeEventListener('mousemove', onMouseMove);
      overlay.removeEventListener('mouseup', onMouseUp);
      const endX = ev.clientX;
      const endY = ev.clientY;
      const x1 = Math.min(startX, endX);
      const y1 = Math.min(startY, endY);
      const x2 = Math.max(startX, endX);
      const y2 = Math.max(startY, endY);
      // Extract text from the selected rectangle
      const text = extractTextFromRect(x1, y1, x2, y2);
      // Remove overlay
      overlay.remove();
      // Send the captured text back to the background script
      chrome.runtime.sendMessage({ type: 'quickSnapResult', text, rect: { x1, y1, x2, y2 } });
    }

    // Cancel the selection if the user presses Escape
    function onKeyDown(ev) {
      if (ev.key === 'Escape') {
        cleanup();
      }
    }
    function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.removeEventListener('mousedown', onMouseDown);
      overlay.removeEventListener('mousemove', onMouseMove);
      overlay.removeEventListener('mouseup', onMouseUp);
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }

    overlay.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);
  }

  /**
   * Extract text within the rectangular region defined by the given
   * coordinates. This uses the browser’s caretRangeFromPoint (or
   * caretPositionFromPoint) APIs to create a Range and retrieve its
   * textual content.
   * @param {number} x1 Left coordinate of the rectangle.
   * @param {number} y1 Top coordinate of the rectangle.
   * @param {number} x2 Right coordinate of the rectangle.
   * @param {number} y2 Bottom coordinate of the rectangle.
   * @returns {string} The extracted text or empty string.
   */
  function extractTextFromRect(x1, y1, x2, y2) {
    /**
     * Helper to obtain a caret position at a viewport coordinate. It uses
     * caretPositionFromPoint where available and falls back to
     * caretRangeFromPoint. Returns an object with the underlying node
     * and offset or null if not found.
     *
     * @param {number} x Horizontal coordinate
     * @param {number} y Vertical coordinate
     * @returns {{node: Node, offset: number}|null}
     */
    function getCaretAt(x, y) {
      const doc = document;
      if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(x, y);
        if (pos) {
          return { node: pos.offsetNode, offset: pos.offset };
        }
      }
      if (typeof doc.caretRangeFromPoint === 'function') {
        const range = doc.caretRangeFromPoint(x, y);
        if (range) {
          return { node: range.startContainer, offset: range.startOffset };
        }
      }
      return null;
    }
    const startCaret = getCaretAt(x1, y1);
    const endCaret = getCaretAt(x2, y2);
    if (startCaret && endCaret) {
      try {
        const range = document.createRange();
        range.setStart(startCaret.node, startCaret.offset);
        range.setEnd(endCaret.node, endCaret.offset);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const text = selection.toString().trim();
        selection.removeAllRanges();
        if (text) {
          return text;
        }
      } catch (e) {
        // ignore errors and fall through to tree walker fallback
      }
    }
    // Fallback: iterate over all text nodes and collect those whose
    // bounding rectangle intersects the selection rectangle. This
    // approach is slower but more robust for capturing text inside
    // interactive elements or complex layouts.
    const rectLeft = Math.min(x1, x2);
    const rectRight = Math.max(x1, x2);
    const rectTop = Math.min(y1, y2);
    const rectBottom = Math.max(y1, y2);
    const doc = document;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false);
    const range = doc.createRange();
    const fragments = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      try {
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.bottom >= rectTop && rect.top <= rectBottom && rect.right >= rectLeft && rect.left <= rectRight) {
          fragments.push(node.nodeValue.trim());
        }
      } catch (e) {
        // ignore errors for this node
      }
    }
    range.detach();
    if (fragments.length) {
      return fragments.join('\n');
    }
    return '';
  }
})();