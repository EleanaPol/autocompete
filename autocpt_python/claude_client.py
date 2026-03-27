import os
import anthropic
from dotenv import load_dotenv

load_dotenv()


class ClaudeClient:

    def __init__(
            self,
            api_key: str | None = None,
            default_model: str = "claude-sonnet-4-6",
            #default_model="claude-haiku-4-5-20251001",
    ):
        self.client = anthropic.Anthropic(
            api_key=api_key or os.environ["ANTHROPIC_API_KEY"]
        )
        self.default_model = default_model

    def call(
            self,
            messages: list[dict],
            system_prompt: str | None = None,
            model: str | None = None,
            max_tokens: int = 1000,
    ) -> str:
        """Generic text-in / text-out call. Returns the full response as a string."""
        resp = self.client.messages.create(
            model=model or self.default_model,
            system=system_prompt,
            max_tokens=max_tokens,
            messages=messages,
        )
        print("stop_reason:", resp.stop_reason)
        return "".join(
            block.text for block in resp.content if block.type == "text"
        )

    def stream(
            self,
            messages: list[dict],
            system_prompt: str | None = None,
            model: str | None = None,
            max_tokens: int = 256,
    ) -> str:
        """
        Streaming call — collects the full response and returns it as a string.
        Used by autocompete where we need the complete JSON before acting on it.
        """
        full_response = ""

        with self.client.messages.stream(
            model=model or self.default_model,
            system=system_prompt,
            max_tokens=max_tokens,
            messages=messages,
        ) as stream:
            for text_chunk in stream.text_stream:
                full_response += text_chunk

        return full_response

    def create_message(self, role: str, context_prompt: str) -> list[dict]:
        """Wraps a single prompt into the messages list format the API expects."""
        return [{"role": role, "content": context_prompt}]