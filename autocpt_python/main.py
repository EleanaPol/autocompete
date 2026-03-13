from fastapi import FastAPI
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from claude_client import ClaudeClient
from prompt import pick_mode, build_prompt, SYSTEM_PROMPT
import asyncio, json, os
import unicodedata



app = FastAPI()
client = ClaudeClient()  # reads ANTHROPIC_API_KEY from .env automatically

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")


# Define request shape -> defines exactly what JSON your /edit endpoint expects to receive
# -- the text as string
# -- the position of the cursor as integer
class EditRequest(BaseModel):
    text: str
    cursor_position: int

def normalise(s: str) -> str:
    # replace curly quotes with straight equivalents
    return s.replace('\u2018', "'").replace('\u2019', "'").replace('\u201c', '"').replace('\u201d', '"')

# Mock Stream Generator

async def mock_edit_stream(text: str, cursor_position: int):
    """
    Mock edit generator — proves the SSE(Server-Sent Events) pipeline works before we
    wire in the real Anthropic call.

    Yields SSE-formatted events:
      - 'meta' event: tells the client WHERE to insert (start index)
      - 'token' events: one character at a time
      - 'done' event: signals end of stream
    """

    # Pick a target range to replace — for the mock, we'll replace
    # the last word before the cursor (if there is one)
    text_before_cursor = text[:cursor_position]
    words = text_before_cursor.strip().split()

    if not words:
        yield f"event: done\ndata: {{}}\n\n"
        return

    # Find the last word and its position in the text
    last_word = words[-1]
    # Find the start of the last word (search backwards from cursor for last occurrence)
    replace_start = text_before_cursor.rfind(last_word)
    replace_end = replace_start + len(last_word)

    # Mock replacement — swap the last word with something slightly "better"
    replacements = {
        "good": "exceptional",
        "bad": "suboptimal",
        "nice": "refined",
        "big": "substantial",
        "use": "leverage",
        "make": "construct",
        "think": "conceptualize",
        "hard": "challenging",
        "want": "desire",
        "need": "require",
    }
    #replacement = replacements.get(last_word.lower(), f"{last_word}—")
    replacement = replacements.get(last_word.lower())
    if replacement is None:
        yield f"event: done\ndata: {{}}\n\n"
        return

    # Send the meta event first: where to splice
    meta = {"replace_start": replace_start, "replace_end": replace_end}
    yield f"event: meta\ndata: {json.dumps(meta)}\n\n"

    # Stream the replacement character by character
    for char in replacement:
        yield f"event: token\ndata: {json.dumps({'char': char})}\n\n"
        await asyncio.sleep(0.06)  # ~typing speed

    yield f"event: done\ndata: {{}}\n\n"


async def anthropic_edit_stream(text: str, cursor_position: int):
    """
    Calls the Anthropic API to select and rewrite a passage in the text.

    Flow:
    1. Pick a random adversarial mode
    2. Ask Claude to return {"original": "...", "replacement": "..."}
    3. Collect the full JSON response (we need it complete before we can act)
    4. Find the original string in the text to get its indices
    5. Send a meta event with the replace range
    6. Stream the replacement character by character
    7. Send done
    """

    # Step 1 — pick a mode
    mode_name, mode_instruction = pick_mode()
    print(f"Mode: {mode_name}")

    # Step 2 — call the API via ClaudeClient
    try:
        full_response = client.stream(
            messages=client.create_message(
                role="user",
                context_prompt=build_prompt(text, mode_instruction)
            ),
            system_prompt=SYSTEM_PROMPT,
            max_tokens=256,
        )
    except Exception as e:
        print(f"Anthropic API error: {e}")
        yield f"event: done\ndata: {{}}\n\n"
        return

    # Step 3 — parse the JSON response
    try:
        result = json.loads(full_response.strip())
    except json.JSONDecodeError:
        print(f"JSON parse error. Raw response: {full_response}")
        yield f"event: done\ndata: {{}}\n\n"
        return

    original = result.get("original")
    replacement = result.get("replacement")



    print(f"Original: {original}")
    print(f"Replacement: {replacement}")

    # Step 4 — if the model found nothing worth changing, do nothing
    if not original or not replacement:
        yield f"event: done\ndata: {{}}\n\n"
        return

    # then when searching:
    normalised_text = normalise(text)
    normalised_original = normalise(original)

    # Step 5 — find the original string in the text
    replace_start = normalised_text.find(normalised_original)
    if replace_start == -1:
        print(f"Original not found in text: '{original}'")
        yield f"event: done\ndata: {{}}\n\n"
        return

    replace_end = replace_start + len(normalised_original)

    # Step 6 — send the meta event
    meta = {"replace_start": replace_start, "replace_end": replace_end}
    yield f"event: meta\ndata: {json.dumps(meta)}\n\n"

    # Step 7 — stream the replacement character by character
    for char in replacement:
        yield f"event: token\ndata: {json.dumps({'char': char})}\n\n"
        await asyncio.sleep(0.05)

    yield f"event: done\ndata: {{}}\n\n"


# @app.post("/edit")
# async def edit(request: EditRequest):
#     return StreamingResponse(
#         mock_edit_stream(request.text, request.cursor_position),
#         media_type="text/event-stream",
#         headers={
#             "Cache-Control": "no-cache",
#             "X-Accel-Buffering": "no",  # important for nginx proxies
#         },
#     )

@app.post("/edit")
async def edit(request: EditRequest):
    return StreamingResponse(
        anthropic_edit_stream(request.text, request.cursor_position),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
async def root():
    with open("static/index.html") as f:
        return HTMLResponse(f.read())