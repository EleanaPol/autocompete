from typing import Tuple

from fastapi import FastAPI
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from claude_client import ClaudeClient
from prompt import pick_mode, build_prompt, build_analysis_prompt, SYSTEM_PROMPT, SYSTEM_PROMPT_2, SYSTEM_PROMPT_3, ANALYSIS_SYSTEM_PROMPT
import asyncio, json, os
import unicodedata
import re



app = FastAPI()
client = ClaudeClient()  # reads ANTHROPIC_API_KEY from .env automatically

first_profile = True
has_profile = False
writer_profile = None
profile_count = 0

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")


# Define request shape -> defines exactly what JSON your /edit endpoint expects to receive
# -- the text as string
# -- the position of the cursor as integer
class EditRequest(BaseModel):
    text: str
    cursor_position: int
    background: bool = False  # True = background edit, must avoid cursor area


class AnalyseRequest(BaseModel):
    text: str


def find_safe_boundary(text: str, cursor_position: int) -> int:
    """
    For background edits — find the end of the last complete sentence
    that ends at least one sentence before the cursor.

    Returns the character index up to which the assistant may edit.
    Returns 0 if there isn't enough text before the cursor to work with.
    """
    # Only look at text before the cursor
    text_before = text[:cursor_position]

    # Find all sentence-ending positions (., !, ?)
    sentence_ends = [m.end() for m in re.finditer(r'[.!?]\s+', text_before)]

    # We need at least two sentence endings — target everything before the second-to-last
    # This ensures we stay at least one full sentence away from the cursor
    if len(sentence_ends) < 2:
        return 0

    # Return the end of the second-to-last sentence as the safe boundary
    return sentence_ends[-2]

def normalise(s: str) -> str:
    # replace curly quotes with straight equivalents
    return s.replace('\u2018', "'").replace('\u2019', "'").replace('\u201c', '"').replace('\u201d', '"')

def get_profile_string(profile: dict) -> str:
    if profile is None:
        return ""
    return json.dumps(profile, indent=2)


def get_profile_traits(profile: dict) -> Tuple[str, str]:
    if profile is None:
        return "", ""
    return profile['personality'], profile['vulnerability']


def strip_code_fences(response: str) -> str:
    cleaned = response.strip()
    if cleaned.startswith("```"):
        # remove opening fence
        cleaned = cleaned.split("\n", 1)[1]
        # remove closing fence
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()


def get_phase_system_prompt(num_profiles: int=0):
    if num_profiles == 0:
        return SYSTEM_PROMPT
    elif num_profiles <= 3:
        return SYSTEM_PROMPT_2
    return SYSTEM_PROMPT_3

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



async def anthropic_edit_stream(text: str, cursor_position: int, background: bool):

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

    global has_profile, profile_count

    # Step 1 — pick a mode
    mode_name, mode_instruction = pick_mode()
    edit_type = "background" if background else "pause"
    print(f"Mode: {mode_name} -- {edit_type}")

    # Step 2 - manage writer profile
    profile_str = get_profile_string(writer_profile)

    # Step 3 - extract profile traits
    profile_traits = get_profile_traits(writer_profile)

    # Step 4 — determine the text the assistant is allowed to edit
    if background:
        safe_boundary = find_safe_boundary(text, cursor_position)
        if safe_boundary == 0:
            # Not enough text before cursor to edit safely
            yield f"event: done\ndata: {{}}\n\n"
            return
        # Only show the assistant the safe portion
        editable_text = text[:safe_boundary]
    else:
        editable_text = text
    print (f"profiles generated so far: {profile_count}")

    # get correct system prompt
    system_prompt = get_phase_system_prompt(profile_count)

    # Step 5 — call the API via ClaudeClient
    try:
        full_response = client.stream(
            messages=client.create_message(
                role="user",
                context_prompt=build_prompt(editable_text, mode_instruction, profile_str, has_profile, profile_count, profile_traits[0], profile_traits[1]),
            ),
            system_prompt=system_prompt,
            max_tokens=256,
        )
    except Exception as e:
        print(f"Anthropic API error: {e}")
        yield f"event: done\ndata: {{}}\n\n"
        return

    # Step 6 — parse the JSON response
    try:
        result = json.loads(strip_code_fences(full_response.strip()))
    except json.JSONDecodeError:
        print(f"JSON parse error. Raw response: {full_response}")
        yield f"event: done\ndata: {{}}\n\n"
        return

    original = result.get("original")
    replacement = result.get("replacement")


    print(f"Original: {original}")
    print(f"Replacement: {replacement}")

    # Step 7 — if the model found nothing worth changing, do nothing
    if not original or not replacement:
        yield f"event: done\ndata: {{}}\n\n"
        return

    # then when searching:
    normalised_text = normalise(editable_text)
    normalised_original = normalise(original)


    # Step 8 — find the original string in the text
    replace_start = normalised_text.find(normalised_original)
    if replace_start == -1:
        print(f"Original not found in text: '{original}'")
        yield f"event: done\ndata: {{}}\n\n"
        return

    # Safety check — for background edits, verify the match is within safe boundary
    if background and replace_start >= safe_boundary:
        print(f"Background edit target outside safe zone — skipping")
        yield f"event: done\ndata: {{}}\n\n"
        return

    replace_end = replace_start + len(normalised_original)

    # Step 9 — send the meta event
    meta = {"replace_start": replace_start, "replace_end": replace_end}
    yield f"event: meta\ndata: {json.dumps(meta)}\n\n"

    # Step 10 — stream the replacement character by character
    for char in replacement:
        yield f"event: token\ndata: {json.dumps({'char': char})}\n\n"
        await asyncio.sleep(0.05)

    yield f"event: done\ndata: {{}}\n\n"


async def anthropic_extract_profile(text: str) -> dict:

    global first_profile, writer_profile, has_profile, profile_count
    print("Fired Profiling Step:")
    existing_profile = writer_profile

    # Step 1. Manage writer profile
    profile_str = get_profile_string(writer_profile)

    # Step 2. Create proper analysis prompt
    a_prompt = ""
    if first_profile:
        a_prompt = build_analysis_prompt(text)

    else:
        a_prompt = build_analysis_prompt(text, profile_str, first_profile)

    # Step 3. Call the API via ClaudeClient
    try:
        loop = asyncio.get_event_loop()
        full_analysis_response = await loop.run_in_executor(
            None,
            lambda: client.call(
                messages=client.create_message(
                    role="user",
                    context_prompt=a_prompt
                ),
                system_prompt=ANALYSIS_SYSTEM_PROMPT,
                max_tokens=512
            )
        )
    except Exception as e:
        print(f"Anthropic API error: {e}")
        return existing_profile

    # Step 4. parse the JSON response
    try:
        new_profile = json.loads(strip_code_fences(full_analysis_response.strip()))
        print(f"Raw Profile: {new_profile}")
        first_profile = False
        writer_profile = new_profile
        has_profile = True
        profile_count += 1
    except json.JSONDecodeError:
        print(f"JSON parse error. Raw response: {full_analysis_response}")
        writer_profile = existing_profile



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


#  it registers the function below it as the handler for any POST request arriving at the /edit URL
@app.post("/edit")
async def edit(request: EditRequest):
    return StreamingResponse(
        anthropic_edit_stream(request.text, request.cursor_position, request.background),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

#  it registers the function below it as the handler for any POST request arriving at the /analyse URL
@app.post("/analyse")
async def edit(request: AnalyseRequest):
    await anthropic_extract_profile(request.text)
    return {"status": "ok"}


@app.get("/")
async def root():
    with open("static/index.html") as f:
        return HTMLResponse(f.read())