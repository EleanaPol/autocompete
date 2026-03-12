const editor = document.getElementById('editor');
const status = document.getElementById('status');
const assistantCursor = document.getElementById('assistant-cursor');

let pauseTimer = null;
let isAssistantEditing = false;
//let currentEventSource = null;
let currentReader = null;

const PAUSE_DELAY = 1800; // ms of silence before assistant acts

// ─── Pause detection ──────────────────────────────────────────────────────────

// add listener to the editor to run function everytime the user types
editor.addEventListener('input', () => {
  if (isAssistantEditing) return; // don't trigger while assistant is writing

  // stop/clear the timer when user is typing
  clearTimeout(pauseTimer);
  setStatus('watching');

  // trigger assistant edit if pause delay has been reached by the timer
  pauseTimer = setTimeout(() => {
    triggerAssistantEdit();
  }, PAUSE_DELAY);
});

// ─── Trigger the assistant ────────────────────────────────────────────────────

async function triggerAssistantEdit() {
  const text = editor.value;
  // the character index where the cursor is positioned.
  const cursorPos = editor.selectionStart;
  // early exit ->  if there are fewer than 3 non-whitespace characters, there's nothing meaningful to edit yet
  if (text.trim().length < 3) return; // nothing to work with yet

//  // Cancel any in-progress edit
//  if (currentEventSource) {
//    currentEventSource.close();
//    currentEventSource = null;
//  }

  // Cancel any in-progress stream
  if (currentReader) {
    await currentReader.cancel();
    currentReader = null;
  }

  isAssistantEditing = true;
  setStatus('editing', 'assistant is editing');
  showAssistantCursor(true);

  // We'll build the replacement here as tokens arrive
  let replaceStart = null;
  let replaceEnd = null;
  let insertedLength = 0;

  let response;
  try {
    response = await fetch('/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, cursor_position: cursorPos }),
    });
  } catch (e) {
    console.error('Edit request failed:', e);
    resetAssistantState();
    return;
  }

  // response comes as ReadableStream
  const reader = response.body.getReader();
  //converts raw binary chunks (the network sends bytes) into readable text strings
  const decoder = new TextDecoder();
  // a string we accumulate chunks into before processing — important because a single chunk from the network might
  // contain half an event, and we need to wait until we have a complete one before acting on it.
  let buffer = '';

  // store reference so it can be cancelled
  currentReader = reader;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line for next chunk

    let eventType = null;
    let dataLine = null;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine = line.slice(5).trim();
      } else if (line === '' && eventType && dataLine !== null) {
        handleSSEEvent(eventType, JSON.parse(dataLine), {
          get replaceStart() { return replaceStart; },
          set replaceStart(v) { replaceStart = v; },
          get replaceEnd() { return replaceEnd; },
          set replaceEnd(v) { replaceEnd = v; },
          get insertedLength() { return insertedLength; },
          set insertedLength(v) { insertedLength = v; },
        });
        eventType = null;
        dataLine = null;
      }
    }
  }

  resetAssistantState();
}

// ─── SSE event handler ────────────────────────────────────────────────────────

function handleSSEEvent(type, data, state) {
  if (type === 'meta') {
    state.replaceStart = data.replace_start;
    state.replaceEnd = data.replace_end;
    state.insertedLength = 0;

    // Delete the original range immediately
    const text = editor.value;
    editor.value =
      text.slice(0, state.replaceStart) +
      text.slice(state.replaceEnd);

    positionAssistantCursor(state.replaceStart);

  } else if (type === 'token') {
    if (state.replaceStart === null) return;

    const insertAt = state.replaceStart + state.insertedLength;
    const text = editor.value;
    editor.value =
      text.slice(0, insertAt) +
      data.char +
      text.slice(insertAt);

    state.insertedLength += 1;
    positionAssistantCursor(insertAt + 1);

  } else if (type === 'done') {
    // handled by the loop ending
  }
}

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function positionAssistantCursor(charIndex) {
  const coords = getCaretCoordinates(editor, charIndex);
  const containerRect = editor.parentElement.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();

  assistantCursor.style.left = (editorRect.left - containerRect.left + coords.left) + 'px';
  assistantCursor.style.top  = (editorRect.top  - containerRect.top  + coords.top)  + 'px';
  assistantCursor.style.height = coords.height + 'px';
}

function showAssistantCursor(visible) {
  assistantCursor.classList.toggle('active', visible);
}

// ─── Status ───────────────────────────────────────────────────────────────────

function setStatus(className, text) {
  status.className = className || '';
  status.textContent = text || (className === 'watching' ? 'watching' : '—');
}

function resetAssistantState() {
  isAssistantEditing = false;
  showAssistantCursor(false);
  setStatus('', '—');
}

// ─── Caret coordinate helper ──────────────────────────────────────────────────

function getCaretCoordinates(element, position) {
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(element);

  const properties = [
    'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'letterSpacing', 'wordSpacing',
  ];

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';

  properties.forEach(prop => {
    mirror.style[prop] = style[prop];
  });

  mirror.style.top = '0';
  mirror.style.left = '0';

  const textContent = element.value.substring(0, position);
  mirror.textContent = textContent;

  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  mirror.appendChild(span);

  document.body.appendChild(mirror);

  const rect = span.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  document.body.removeChild(mirror);

  return {
    top: rect.top - mirrorRect.top,
    left: rect.left - mirrorRect.left,
    height: rect.height,
  };
}