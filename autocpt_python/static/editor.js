const editor = document.getElementById('editor');
//const status = document.getElementById('status');
const assistantCursor = document.getElementById('assistant-cursor');
const typewriter = document.getElementById('typewriter');
const beginButton = document.getElementById('begin-btn');
const intro_mode = document.getElementById('intro');
const edit_mode = document.getElementById('editor-container');

let introTimer =null;
let buttonTimer = null;
let pauseTimer = null;
let isEditingActive = false;
let isAssistantEditing = false;
let backgroundTimer = null;
//let currentEventSource = null;
let currentReader = null;
let activeEditSpan = null;



const introText = `What is it that really makes us special? How do we distinguish ourselves from others? What if money didn't matter. Status didn't matter. Degrees didn't matter.

What remains? What makes you distinct?

Do you belong with the select few?

Only your words can reveal what you're really made of and if you are truly worthy to join us.

Don't write what you think we want to hear. Write what's true.

Be honest. Be bold.

Your chance is now.`;
const chars = [...introText];

let CHAR_DELAY = 50;
const INTRO_DELAY = 2000; // 3 seconds before intro starts typing behavior
const BUTTON_DELAY = 1000; // 1 second after typing is done
const PAUSE_DELAY = 7000; // ms of silence before assistant acts
const BG_MIN = 15000;  // 15 seconds
const BG_MAX = 45000;  // 45 seconds

// ─── Background timer ─────────────────────────────────────────────────────────
// Fires independently of user activity. Schedules itself randomly after each
// trigger. Stays dormant if assistant is already editing.

function scheduleBackgroundEdit() {
  clearTimeout(backgroundTimer);
  const delay = BG_MIN + Math.random() * (BG_MAX - BG_MIN);
  console.log('background activated');

  backgroundTimer = setTimeout(async () => {
    if (!isAssistantEditing && isEditingActive && getText().trim().length > 50) {
      await triggerAssistantEdit(true); // true = background edit
    }
    scheduleBackgroundEdit(); // reschedule regardless
  }, delay);
}

//scheduleBackgroundEdit(); // start the background timer on load

// ─── Typing timer ─────────────────────────────────────────────────────────
function scheduleIntroTyping(){
  console.log('scheduleIntroTyping called');
  setTimeout(() => {
  typeNextChar(0);    // start at index 0
}, INTRO_DELAY);

}


function typeNextChar(index){
  if (index >= chars.length) {
    setTimeout(()=> {beginButton.style.display = 'block';},BUTTON_DELAY)
    return; // stop when done
  }

  typeIntro(chars[index])

  setTimeout(() => {
    typeNextChar(index + 1);         // schedule the next character
  }, CHAR_DELAY);                            // delay between characters


}
function typeIntro(char){
  if (char === '\n') {
    typewriter.innerHTML += '<br>';
    CHAR_DELAY = 600;
  } else if(char === '.' || char === '?'){
    typewriter.innerHTML += char;
    CHAR_DELAY = 400;
  }
  else {
    typewriter.innerHTML += char;
    CHAR_DELAY = 50;
  }
}

scheduleIntroTyping();

// ─── Begin ──────────────────────────────────────────────────────────
function beginEditor(){
console.log('button clicked');
  intro_mode.style.display = 'none';
  edit_mode.style.display = 'block';
  isEditingActive = true;
  scheduleBackgroundEdit();
}

beginButton.addEventListener('click', beginEditor);





// ─── contenteditable text helpers ────────────────────────────────────────────
// contenteditable divs don't have .value or .selectionStart like textareas do.
// We work with the DOM directly.

function getText() {
  return editor.textContent;
}

function getCursorPosition() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(editor);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

// Walk all text nodes inside the editor to build a DOM Range
// covering character positions [start, end]
function getDOMRange(start, end) {

  // If editor is empty, return a range at the start of the editor
  if (!editor.textContent.length) {
    const range = document.createRange();
    range.setStart(editor, 0);
    range.setEnd(editor, 0);
    return range;
  }
  const range = document.createRange();
  let charCount = 0;
  let startSet = false;
  let endSet = false;

  function walk(node) {
    if (endSet) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.length;
      if (!startSet && charCount + len >= start) {
        range.setStart(node, start - charCount);
        startSet = true;
      }
      if (startSet && charCount + len >= end) {
        range.setEnd(node, end - charCount);
        endSet = true;
      }
      charCount += len;
    } else {
      for (const child of node.childNodes) {
        walk(child);
        if (endSet) break;
      }
    }
  }

  walk(editor);

  // If end wasn't set (position is at very end of content), set to last node
  if (!endSet) {
    range.setEnd(editor, editor.childNodes.length);
  }

  return range;
}

// Delete the text between [start, end] from the DOM
function deleteRange(start, end) {
  if (start >= end) return;
  const range = getDOMRange(start, end);
  range.deleteContents();
  editor.normalize(); // merge any split text nodes
}

// Insert one character at position, creating or reusing the highlight span
function insertChar(char, position) {
  if (activeEditSpan) {
    activeEditSpan.textContent += char;
    return;
  }

  const span = document.createElement('span');
  span.className = 'assistant-edit';
  span.textContent = char;

  // If editor has no text content, insert directly
  if (!editor.textContent.length) {
    editor.appendChild(span);
  } else {
    const range = getDOMRange(position, position);
    range.insertNode(span);
  }

  activeEditSpan = span;
}

// Intercept Enter key so it inserts \n text node instead of <div> or <br>
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const newline = document.createTextNode('\n');
    range.insertNode(newline);
    range.setStartAfter(newline);
    range.setEndAfter(newline);
    sel.removeAllRanges();
    sel.addRange(range);
  }
});



// ─── Pause detection ──────────────────────────────────────────────────────────

// add listener to the editor to run function everytime the user types
editor.addEventListener('input', () => {
  if (isAssistantEditing || !isEditingActive) return; // don't trigger while assistant is writing

  // stop/clear the timer when user is typing
  clearTimeout(pauseTimer);
//  setStatus('watching');

  // trigger assistant edit if pause delay has been reached by the timer
  pauseTimer = setTimeout(() => {
    triggerAssistantEdit(false);
  }, PAUSE_DELAY);
});

// ─── Trigger the assistant ────────────────────────────────────────────────────

async function triggerAssistantEdit(background) {

  const text = getText();
  // the character index where the cursor is positioned.
  const cursorPos = getCursorPosition();
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
//  setStatus('editing', 'assistant is editing');
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
      body: JSON.stringify({ text, cursor_position: cursorPos, background }),
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
  try{
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
  }catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Stream error:', e);
    }
  } finally {
    currentReader = null;
    fadeEditSpan();
    resetAssistantState();
  }

  //resetAssistantState();
}

// ─── SSE event handler ────────────────────────────────────────────────────────

function handleSSEEvent(type, data, state) {
  if (type === 'meta') {
    state.replaceStart = data.replace_start;
    state.replaceEnd = data.replace_end;
    state.insertedLength = 0;
    activeEditSpan = null; // fresh span for this edit

    // Delete the original range immediately
   /* const text = editor.value;
    editor.value =
      text.slice(0, state.replaceStart) +
      text.slice(state.replaceEnd);*/

    deleteRange(state.replaceStart, state.replaceEnd);
    positionAssistantCursor(state.replaceStart);

  } else if (type === 'token') {
    if (state.replaceStart === null) return;

    const insertAt = state.replaceStart + state.insertedLength;
    insertChar(data.char, insertAt);
    /*const text = editor.value;
    editor.value =
      text.slice(0, insertAt) +
      data.char +
      text.slice(insertAt);*/

    state.insertedLength += 1;
    positionAssistantCursor(insertAt + 1);

  }
}

// ─── Fade the assistant's edit span to normal text color ─────────────────────

function fadeEditSpan() {
  if (!activeEditSpan) return;
  const span = activeEditSpan;

  // After a short pause, add the fade class which triggers the CSS transition
  setTimeout(() => {
    span.classList.add('fade');

    // After the transition completes, unwrap the span — keeping just the text
    setTimeout(() => {
      if (span.parentNode) {
        const parent = span.parentNode;
        while (span.firstChild) {
          parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
        parent.normalize();
      }
      if (activeEditSpan === span) activeEditSpan = null;
    }, 2600); // slightly longer than the CSS transition duration

  }, 1200); // wait 1.2s at full amber before fading
}

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function positionAssistantCursor(charIndex) {
  const range = getDOMRange(charIndex, charIndex);
  const rect = range.getBoundingClientRect();
  const containerRect = editor.parentElement.getBoundingClientRect();

  assistantCursor.style.left   = (rect.left - containerRect.left) + 'px';
  assistantCursor.style.top    = (rect.top  - containerRect.top  + editor.scrollTop) + 'px';
  assistantCursor.style.height = (rect.height || 20) + 'px';
}

function showAssistantCursor(visible) {
  assistantCursor.classList.toggle('active', visible);
}

// ─── Status ───────────────────────────────────────────────────────────────────

//function setStatus(className, text) {
//  status.className = className || '';
//  status.textContent = text || (className === 'watching' ? 'watching' : '—');
//}

function resetAssistantState() {
  isAssistantEditing = false;
  showAssistantCursor(false);
//  setStatus('', '—');
}

// ─── Caret coordinate helper ──────────────────────────────────────────────────
// Mirrors the textarea into a hidden div to measure character pixel position.
// The mirror is appended to document.body so its getBoundingClientRect()
// is also viewport-relative — consistent with editorRect above.

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

//  mirror.style.position = 'absolute';
//  mirror.style.visibility = 'hidden';
//  mirror.style.whiteSpace = 'pre-wrap';
//  mirror.style.wordWrap = 'break-word';

  mirror.style.position = 'fixed'; // fixed so it's always viewport-relative
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.top = editorRect_top() + 'px'; // anchor mirror to editor position
  mirror.style.left = editorRect_left() + 'px';

  properties.forEach(prop => {
    mirror.style[prop] = style[prop];
  });

//  mirror.style.top = '0';
//  mirror.style.left = '0';

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

function editorRect_top()  { return editor.getBoundingClientRect().top; }
function editorRect_left() { return editor.getBoundingClientRect().left; }

