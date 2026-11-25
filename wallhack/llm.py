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
import math
import os
import re
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


def _request_for(provider: str, model: str, endpoint: str, env: Mapping[str, str], prompt: str,
                 system: str = SYSTEM_PROMPT):
    """Return (url, headers, body) for one chat call. Raises LlmError if configuration is missing."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
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


def _chat(prompt: str, system: str, provider: str, model: str, endpoint: str, env: Optional[Mapping[str, str]],
          timeout_s: float, opener: Callable) -> str:
    """One chat round trip to the configured provider. Raises LlmError on any problem."""
    if endpoint and urlparse(endpoint).scheme not in ("http", "https"):
        raise LlmError("llm_endpoint must start with http:// or https://")
    env = os.environ if env is None else env
    url, headers, body = _request_for(provider, model, endpoint, env, prompt, system)
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
    return _extract_text(provider, payload)


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
    text = _chat(findings_prompt(findings), SYSTEM_PROMPT, provider, model, endpoint, env, timeout_s, opener)
    return {"explanation": text, "provider": provider, "off_device": info["off_device"],
            "note": "Reworded by an LLM from rule-based findings. The findings above are the source of truth."}


# ---------------------------------------------------------------- planner advice (POST /api/planner/explain)
PLANNER_SYSTEM_PROMPT = ("You are a careful wireless site-survey consultant who explains WiFi planning results to a "
                         "non-expert. Use only the numbers present in the JSON you are given. Never invent measurements "
                         "or calculate new numbers. Say the numbers are model estimates and mention confidence in plain "
                         "words. No medical or legal advice. Under 200 words.")
PLANNER_ESTIMATE_LABEL = "MODEL ESTIMATE, not a measurement."
MAX_PLANNER_ITEMS = 40
MAX_PLANNER_TEXT_CHARS = 400
MAX_PLANNER_PAYLOAD_CHARS = 20000
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
# Numbers that are formatting, not claims: list markers at the start of a line ("1.", "2)", "(3)") and the fixed
# WiFi band and channel width units ("5 GHz", "2.4 GHz", "160 MHz"). Any other number must come from the payload.
_LIST_MARKER = re.compile(r"^[ \t]*(?:\(\d{1,2}\)|\d{1,2}[.)])(?=\s)", re.MULTILINE)
_BAND_UNIT = re.compile(r"\b(?:2\.4|5|6)\s?GHz\b|\b(?:20|40|80|160|320)\s?MHz\b", re.IGNORECASE)


def _clean_text(value, path: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_PLANNER_TEXT_CHARS:
        raise LlmError(f"{path}: must be a non-empty string up to {MAX_PLANNER_TEXT_CHARS} characters")
    return value.strip()


def validate_planner_payload(body) -> dict:
    """Shape check of the engine result the browser sends. Returns a normalised copy, raises LlmError.

    Accepted keys: title (str), metrics [{label, value, unit?}], issues [str],
    recommendations [{text, confidence?, rationale?}]. Everything else is dropped."""
    if not isinstance(body, dict):
        raise LlmError("the body must be a JSON object")
    if len(json.dumps(body)) > MAX_PLANNER_PAYLOAD_CHARS:
        raise LlmError("the planner result is too large")
    out = {"title": _clean_text(body.get("title", "Planner result"), "title"), "metrics": [], "issues": [],
           "recommendations": []}
    for key in ("metrics", "issues", "recommendations"):
        items = body.get(key, [])
        if not isinstance(items, list) or len(items) > MAX_PLANNER_ITEMS:
            raise LlmError(f"{key}: must be a list of at most {MAX_PLANNER_ITEMS} items")
    for i, m in enumerate(body.get("metrics", [])):
        if (not isinstance(m, dict) or isinstance(m.get("value"), bool) or not isinstance(m.get("value"), (int, float))
                or not math.isfinite(m["value"])):
            raise LlmError(f"metrics[{i}]: needs a label and a numeric value")
        out["metrics"].append({"label": _clean_text(m.get("label"), f"metrics[{i}].label"), "value": m["value"],
                               "unit": str(m.get("unit", ""))[:12]})
    for i, text in enumerate(body.get("issues", [])):
        out["issues"].append(_clean_text(text, f"issues[{i}]"))
    for i, r in enumerate(body.get("recommendations", [])):
        if not isinstance(r, dict):
            raise LlmError(f"recommendations[{i}]: must be an object")
        rec = {"text": _clean_text(r.get("text"), f"recommendations[{i}].text")}
        if r.get("confidence") is not None:
            c = r["confidence"]
            if isinstance(c, bool) or not isinstance(c, (int, float)) or not math.isfinite(c) or not 0 <= c <= 1:
                raise LlmError(f"recommendations[{i}].confidence: must be a number from 0 to 1")
            rec["confidence"] = c
        if r.get("rationale") is not None:
            rec["rationale"] = _clean_text(r["rationale"], f"recommendations[{i}].rationale")
        out["recommendations"].append(rec)
    return out


def _confidence_word(c: float) -> str:
    return "high" if c >= 0.75 else "moderate" if c >= 0.4 else "low"


def rule_based_planner_text(payload: dict) -> str:
    """Deterministic plain-language summary built only from the payload. Used when the LLM is off or rejected."""
    lines = [f"{payload['title']}. {PLANNER_ESTIMATE_LABEL}"]
    if payload["metrics"]:
        lines.append("Key numbers: " + "; ".join(f"{m['label']} {m['value']}{(' ' + m['unit']) if m['unit'] else ''}"
                                                  for m in payload["metrics"]) + ".")
    if payload["issues"]:
        lines.append("Issues found: " + " ".join(payload["issues"]))
    else:
        lines.append("No issues were found.")
    for r in payload["recommendations"]:
        conf = f" Confidence is {_confidence_word(r['confidence'])} ({r['confidence']})." if "confidence" in r else ""
        why = f" Why: {r['rationale']}" if r.get("rationale") else ""
        lines.append(f"Suggestion: {r['text']}{conf}{why}")
    return "\n".join(lines)


def _payload_numbers(payload: dict) -> set:
    return {float(n) for n in _NUMBER.findall(json.dumps(payload))}


def ungrounded_numbers(reply: str, payload: dict) -> List[str]:
    """Numbers in `reply` that do not occur in `payload`. Empty list means the reply is grounded."""
    allowed = _payload_numbers(payload)
    reply = _BAND_UNIT.sub(" ", _LIST_MARKER.sub("", reply))
    return [n for n in _NUMBER.findall(reply) if float(n) not in allowed and float(n.lstrip("-")) not in allowed]


def planner_prompt(payload: dict) -> str:
    return "Explain this planner result in plain language:\n" + json.dumps(payload, sort_keys=True)


def explain_planner(body, provider: str, model: str = "", endpoint: str = "",
                    env: Optional[Mapping[str, str]] = None, timeout_s: float = 30.0,
                    confirm_off_device: bool = False, opener: Callable = urllib.request.urlopen) -> dict:
    """Explain planner advice. Grounded only on the engine numbers in `body`.

    With the LLM off the answer is the deterministic rule-based text. With an LLM, any reply that contains a
    number not present in the input, or any provider failure, falls back to the rule-based text and says why.
    A cloud provider without `confirm_off_device` raises LlmError (HTTP 409): consent is never assumed."""
    payload = validate_planner_payload(body)
    info = disclosure(provider)
    rules = rule_based_planner_text(payload)
    base = {"label": PLANNER_ESTIMATE_LABEL, "provider": provider, "off_device": info["off_device"]}
    if not info["enabled"]:
        return dict(base, explanation=rules, source="rules", note="LLM is off. This text comes from deterministic rules.")
    if info["off_device"] and not confirm_off_device:
        raise LlmError(f"{provider} is a cloud provider and sends data off-device. "
                       "Resend with confirm_off_device=true to continue.")
    try:
        reply = _chat(planner_prompt(payload), PLANNER_SYSTEM_PROMPT, provider, model, endpoint, env, timeout_s, opener)
    except LlmError as exc:
        return dict(base, explanation=rules, source="rules", fallback_reason=str(exc),
                    note="The LLM failed, so this text comes from deterministic rules.")
    extra = ungrounded_numbers(reply, payload)
    if extra:
        return dict(base, explanation=rules, source="rules", rejected_numbers=extra,
                    fallback_reason="the LLM reply contained numbers that are not in the engine result",
                    note="The LLM reply was rejected, so this text comes from deterministic rules.")
    return dict(base, explanation=reply, source="llm", rules_text=rules,
                note="Reworded by an LLM from engine numbers. The engine result is the source of truth.")
