"""Optional LLM that rephrases rule-based findings in plain language. Off by default.

- The rules engine (insights.py) decides what is true. The LLM only rewords the findings it is given.
- Local providers (ollama, llamacpp) keep data on this machine. Cloud providers (openai, azure) send
  the finding text off-device, so they need the provider configured AND an explicit confirmation per
  request (`confirm_off_device`).
- API keys come only from environment variables and are never put in responses, logs or errors.
- Status: VERIFIED against mocked local HTTP servers only. UNVERIFIED against real Ollama, llama.cpp,
  OpenAI or Azure OpenAI services.
"""
import json
import os
import urllib.error
import urllib.request
from typing import Callable, List, Mapping, Optional
from urllib.parse import urlparse

PROVIDERS = ("", "ollama", "llamacpp", "openai", "azure")
LOCAL_PROVIDERS = ("ollama", "llamacpp")
DEFAULT_ENDPOINTS = {"ollama": "http://localhost:11434", "llamacpp": "http://localhost:8080",
                     "openai": "https://api.openai.com"}
DEFAULT_MODELS = {"ollama": "llama3.2", "llamacpp": "default", "openai": "gpt-4o-mini", "azure": ""}
KEY_ENV = {"openai": "OPENAI_API_KEY", "azure": "AZURE_OPENAI_API_KEY"}
AZURE_ENDPOINT_ENV, AZURE_DEPLOYMENT_ENV = "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"
AZURE_API_VERSION = "2024-02-01"
MAX_RESPONSE_BYTES = 1_000_000
MAX_FINDINGS_CHARS = 6000
SYSTEM_PROMPT = ("You rewrite home sensing findings in clear, friendly plain language. Use only the facts "
                 "given. Do not add facts, diagnoses or medical advice. Keep it under 150 words.")


class LlmError(RuntimeError):
    """The LLM is disabled, misconfigured or failed. The message never contains an API key."""


def disclosure(provider: str) -> dict:
    """What the UI must show: whether data leaves this machine."""
    if provider not in PROVIDERS:
        raise LlmError(f"llm_provider must be one of {PROVIDERS}")
    if not provider:
        return {"provider": "", "enabled": False, "off_device": False,
                "disclosure": "LLM explanations are off. Findings come from deterministic rules."}
    off = provider not in LOCAL_PROVIDERS
    text = ("This sends the finding text to a cloud service outside your network. Off by default."
            if off else "Runs on a model server on your own machine or network.")
    return {"provider": provider, "enabled": True, "off_device": off, "disclosure": text}


def _request_for(provider: str, model: str, endpoint: str, env: Mapping[str, str], prompt: str):
    """Return (url, headers, body) for one chat call. Raises LlmError if configuration is missing."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}]
    headers = {"Content-Type": "application/json"}
    if provider == "ollama":
        base = endpoint or DEFAULT_ENDPOINTS[provider]
        return base.rstrip("/") + "/api/chat", headers, {"model": model or DEFAULT_MODELS[provider],
                                                         "messages": messages, "stream": False}
    if provider == "llamacpp":
        base = endpoint or DEFAULT_ENDPOINTS[provider]
        return base.rstrip("/") + "/v1/chat/completions", headers, {"model": model or DEFAULT_MODELS[provider],
                                                                    "messages": messages}
    key = env.get(KEY_ENV[provider], "")
    if not key:
        raise LlmError(f"environment variable {KEY_ENV[provider]} is not set")
    if provider == "openai":
        headers["Authorization"] = "Bearer " + key
        base = endpoint or DEFAULT_ENDPOINTS[provider]
        return base.rstrip("/") + "/v1/chat/completions", headers, {"model": model or DEFAULT_MODELS[provider],
                                                                    "messages": messages}
    base, deployment = endpoint or env.get(AZURE_ENDPOINT_ENV, ""), model or env.get(AZURE_DEPLOYMENT_ENV, "")
    if not base or not deployment:
        raise LlmError(f"azure needs {AZURE_ENDPOINT_ENV} and {AZURE_DEPLOYMENT_ENV} (or llm_endpoint and llm_model)")
    headers["api-key"] = key
    return (f"{base.rstrip('/')}/openai/deployments/{deployment}/chat/completions?api-version={AZURE_API_VERSION}",
            headers, {"messages": messages})


def _extract_text(provider: str, payload: dict) -> str:
    try:
        text = payload["message"]["content"] if provider == "ollama" else payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise LlmError("the LLM response had an unexpected shape")
    if not isinstance(text, str) or not text.strip():
        raise LlmError("the LLM returned an empty answer")
    return text.strip()


def findings_prompt(findings: List[dict]) -> str:
    lines = []
    for f in findings:
        rec = f" Recommendation: {f['recommendation']}" if f.get("recommendation") else ""
        lines.append(f"- [{f['severity']}] {f['title']}. {f['detail']}{rec}")
    return ("Rewrite these findings as a short summary for a home owner:\n" + "\n".join(lines))[:MAX_FINDINGS_CHARS]


def explain(findings: List[dict], provider: str, model: str = "", endpoint: str = "",
            env: Optional[Mapping[str, str]] = None, timeout_s: float = 30.0,
            confirm_off_device: bool = False,
            opener: Callable = urllib.request.urlopen) -> dict:
    """Ask the configured LLM to rephrase `findings`. Raises LlmError on any problem."""
    info = disclosure(provider)
    if not info["enabled"]:
        raise LlmError("LLM explanations are off. Set llm_provider to enable them.")
    if info["off_device"] and not confirm_off_device:
        raise LlmError(f"{provider} is a cloud provider and sends data off-device. "
                       "Resend with confirm_off_device=true to continue.")
    if not findings:
        raise LlmError("there are no findings to explain")
    if endpoint and urlparse(endpoint).scheme not in ("http", "https"):
        raise LlmError("llm_endpoint must start with http:// or https://")
    env = os.environ if env is None else env
    url, headers, body = _request_for(provider, model, endpoint, env, findings_prompt(findings))
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with opener(req, timeout=timeout_s) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise LlmError(f"{provider} answered HTTP {exc.code}")
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise LlmError(f"could not reach {provider}: {type(exc).__name__}")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise LlmError("the LLM response was too large")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise LlmError("the LLM response was not JSON")
    return {"explanation": _extract_text(provider, payload), "provider": provider,
            "off_device": info["off_device"],
            "note": "Reworded by an LLM from rule-based findings. The findings above are the source of truth."}
