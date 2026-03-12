import random
import yaml


# ─── Load config ──────────────────────────────────────────────────────────────

def _load_config() -> dict:
    with open("config.yml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

_config = _load_config()

MODES: dict[str, str] = _config["modes"]
SYSTEM_PROMPT: str = _config["prompts"]["system"]
_EDIT_TEMPLATE: str = _config["prompts"]["edit"]


# ─── Public interface ─────────────────────────────────────────────────────────

def pick_mode() -> tuple[str, str]:
    """Randomly select an adversarial mode. Returns (mode_name, mode_instruction)."""
    mode_name = random.choice(list(MODES.keys()))
    return mode_name, MODES[mode_name]


def build_prompt(text: str, mode_instruction: str) -> str:
    return _EDIT_TEMPLATE.format(text=text, mode=mode_instruction.strip())