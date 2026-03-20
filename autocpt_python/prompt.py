import random
import yaml


# ─── Load config ──────────────────────────────────────────────────────────────

def _load_config() -> dict:
    with open("config.yml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


_config = _load_config()

MODES: dict[str, str] = _config["modes"]
SYSTEM_PROMPT: str = _config["prompts"]["system"]
ANALYSIS_SYSTEM_PROMPT: str = _config["prompts"]["analysis_system"]
_EDIT_TEMPLATE: str = _config["prompts"]["edit"]
_PERSONALIZED_EDIT_TEMPLATE: str = _config["prompts"]["personalized_edit"]
_ANALYSIS_TEMPLATE: str = _config["prompts"]["analysis_first"]
_ANALYSIS_UPDATE_TEMPLATE: str = _config["prompts"]["analysis_update"]


# ─── Public interface ─────────────────────────────────────────────────────────

def pick_mode() -> tuple[str, str]:
    """Randomly select an adversarial mode. Returns (mode_name, mode_instruction)."""
    mode_name = random.choice(list(MODES.keys()))
    return mode_name, MODES[mode_name]


def build_prompt(text: str, mode_instruction: str, profile: str = "", has_profile: bool = False) -> str:
    if has_profile:
        return _PERSONALIZED_EDIT_TEMPLATE.format(text=text, profile=profile, mode=mode_instruction.strip())
    return _EDIT_TEMPLATE.format(text=text, mode=mode_instruction.strip())


def build_analysis_prompt(text: str, profile: str = "", first: bool = True) -> str:
    analysis_prompt = _ANALYSIS_TEMPLATE.format(text=text)
    if not first:
        analysis_prompt = _ANALYSIS_UPDATE_TEMPLATE.format(text=text, profile=profile)
    return analysis_prompt
