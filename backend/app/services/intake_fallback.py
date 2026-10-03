"""Deterministic fallback for the Intake + Triage agents (used when Nuroen is not processing).

1. Exact-match fixtures for scenario reports → reproducible demo.
2. Keyword rules for anything else → conservative: low confidence when unsure, so UNC-01 sends it
   to human review rather than guessing.
"""

import json
import re
from functools import lru_cache

from app.config import get_settings
from app.schemas import IntakeData, TriageData
from app.services.geo import match_known_place

NEED_KEYWORDS: dict[str, list[str]] = {
    # order matters: medical beats rescue beats food (spec: "stuck ... needs insulin" → medical)
    "medical": [
        "unconscious",
        "not responding",
        "collapsed",
        "insulin",
        "injured",
        "bleeding",
        "heart",
        "breathing",
        "ambulance",
        "doctor",
        "medicine",
        "fever",
        "labour",
        "labor",
        "fracture",
        "medical",
    ],
    "rescue": [
        "trapped",
        "stuck",
        "stranded",
        "rescue",
        "drowning",
        "roof",
        "evacuate",
        "flooding",
        "boat",
        "water everywhere",
        "submerged",
    ],
    "food": ["food", "drinking water", "supplies", "hungry", "ration", "rations", "water for"],
}
VULNERABILITY_KEYWORDS = {
    "elderly": ["old", "elderly", "aged", "senior"],
    "child": ["child", "children", "baby", "kid", "kids", "infant"],
    "pregnant": ["pregnant", "labour", "labor"],
    "disabled": ["disabled", "wheelchair", "bedridden"],
    "medical_dependency": ["insulin", "dialysis", "oxygen"],
}
ESCALATION_KEYWORDS = {
    "water rising": ["rising", "quickly", "rapidly", "fast"],
    "getting worse": ["worse", "worsening"],
}
LIFE_SAFETY_KEYWORDS = [
    "trapped",
    "unconscious",
    "not responding",
    "collapsed",
    "drowning",
    "bleeding",
    "breathing",
    "stuck",
    "insulin",
]
WORD_COUNTS = {"couple": 2, "person": 1, "someone": 1, "man": 1, "woman": 1, "child": 1, "baby": 1}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


@lru_cache
def _fixtures() -> dict:
    return json.loads((get_settings().seed_dir / "intake_fixtures.json").read_text())["fixtures"]


def _has(text: str, words: list[str]) -> list[str]:
    return [w for w in words if re.search(rf"\b{re.escape(w)}\b", text)]


def quick_need(text: str) -> str | None:
    t = normalize(text)
    for need, words in NEED_KEYWORDS.items():
        if _has(t, words):
            return need
    return None


def extract(raw_text: str) -> tuple[IntakeData, TriageData]:
    key = normalize(raw_text)
    if fx := _fixtures().get(key):
        triage = fx.get("triage", {})
        intake = IntakeData(**{k: v for k, v in fx.items() if k != "triage"})
        return intake, TriageData(**triage)

    t = key
    need = quick_need(t)
    place = match_known_place(t)
    location_text = place["name"] if place else None
    if not location_text and (m := re.search(r"\b(?:near|at|in|behind|opposite)\s+([a-z0-9 .'-]{3,40})", t)):
        location_text = m.group(1).strip(" .").title()

    people = None
    if m := re.search(r"\b(\d{1,4})\s+(?:people|persons|families|members|of us)\b", t):
        people = int(m.group(1))
    else:
        for w, n in WORD_COUNTS.items():
            if re.search(rf"\b{w}\b", t):
                people = n
                break

    vulnerabilities = [v for v, words in VULNERABILITY_KEYWORDS.items() if _has(t, words)]
    escalation = [label for label, words in ESCALATION_KEYWORDS.items() if _has(t, words)]
    clues = sorted({*(_has(t, LIFE_SAFETY_KEYWORDS)), *escalation})
    medical_terms = _has(t, NEED_KEYWORDS["medical"])

    ambiguities = []
    if not need:
        ambiguities.append("need type unclear")
    if not location_text:
        ambiguities.append("no location")
    if people is None:
        ambiguities.append("number of people unknown")

    confidence = 0.4 + (0.2 if need else 0) + (0.25 if place else 0.1 if location_text else 0)
    confidence = round(min(confidence, 0.85), 2)

    intake = IntakeData(
        need_type=need,
        location_text=location_text,
        people_affected=people,
        urgency_clues=clues,
        medical_context=", ".join(medical_terms) if medical_terms else None,
        confidence=confidence,
        ambiguities=ambiguities,
    )
    life_safety = need in {"rescue", "medical"} and bool(_has(t, LIFE_SAFETY_KEYWORDS) or escalation)
    triage = TriageData(
        life_safety=life_safety,
        vulnerabilities=vulnerabilities,  # type: ignore[arg-type]
        escalation_signals=escalation,
        rationale="Keyword-based fallback triage (Nuroen agents not used for this report).",
    )
    return intake, triage
