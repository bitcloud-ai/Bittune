"""Deterministic redaction for evidence, facts and queued records.

Port of the Runtime redaction semantics: sensitive keys are stripped from
structured payloads, and credential-looking tokens are scrubbed from free
text before anything is hashed or persisted. Redaction happens at Core write
time; the Runtime submits raw evidence, the Core owns the sanitized copy.
"""

import re

_SENSITIVE_KEY = re.compile(
    r"^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|secret|client[_-]?secret|private[_-]?key|ssh[_-]?key|hf[_-]?token|aws[_-]?secret[_-]?access[_-]?key|cookie)$",
    re.IGNORECASE,
)
_BEARER = re.compile(r"(bearer\s+)[^\s\"']+", re.IGNORECASE)
_SENSITIVE_ASSIGNMENT = re.compile(
    r"((?:api[_-]?key|authorization|token|password|secret|client[_-]?secret|private[_-]?key|ssh[_-]?key|hf[_-]?token|aws[_-]?secret[_-]?access[_-]?key|cookie)\s*[=:]\s*)"
    r"(?!Bearer\b)(\"[^\"]*\"|'[^']*'|[^\s,;]+)",
    re.IGNORECASE,
)
_SENSITIVE_FLAG = re.compile(
    r"(--?(?:api[_-]?key|authorization|token|password|secret|client[_-]?secret|private[_-]?key|ssh[_-]?key|hf[_-]?token|aws[_-]?secret[_-]?access[_-]?key|cookie))"
    r"(?:\s+|=)([^\s\"']+)",
    re.IGNORECASE,
)


def redact_text(value: str) -> str:
    return _SENSITIVE_FLAG.sub(
        r"\1 [REDACTED]",
        _SENSITIVE_ASSIGNMENT.sub(r"\1[REDACTED]", _BEARER.sub(r"\1[REDACTED]", value)),
    )


def redact(value: object) -> object:
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if _SENSITIVE_KEY.match(key) else redact(child)
            for key, child in value.items()
        }
    if isinstance(value, str):
        return redact_text(value)
    return value
