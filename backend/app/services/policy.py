"""Deterministic governance: trust score, priority score, policy evaluation.

Every function here is pure (no DB, no network) so it is trivially testable and replayable.
Rules and weights live in policy.yaml; rule ids are recorded on reports, approvals and audit entries.
"""

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import yaml

from app.config import get_settings

LIFE_SAFETY_VULNERABILITIES = {"elderly", "child", "pregnant", "disabled", "medical_dependency"}


@lru_cache
def config() -> dict[str, Any]:
    return yaml.safe_load(get_settings().policy_path.read_text())


def rule(rule_id: str) -> dict[str, Any]:
    return next(r for r in config()["rules"] if r["id"] == rule_id)


# ---------------- trust ----------------


@dataclass
class TrustResult:
    score: float
    verification_status: str
    breakdown: dict[str, Any]


def compute_trust(
    source_type: str,
    *,
    corroborations: int = 0,
    in_incident_zone: bool = False,
    location_confidence: float | None = None,
    news_articles: int = 0,
) -> TrustResult:
    t = config()["trust"]
    base = float(t["base"].get(source_type, t["base"]["anonymous"]))
    mods: list[dict[str, Any]] = []
    if corroborations > 0:
        mods.append(
            {
                "label": f"Corroborated by {corroborations} independent report(s)",
                "delta": t["modifiers"]["corroborated"],
            }
        )
    if in_incident_zone:
        mods.append(
            {
                "label": "Location inside known incident zone",
                "delta": t["modifiers"]["in_known_incident_zone"],
            }
        )
    if (
        location_confidence is not None
        and location_confidence < config()["uncertainty"]["minimum_location_confidence"]
    ):
        mods.append({"label": "Low location confidence", "delta": t["modifiers"]["low_location_confidence"]})
    score = round(min(1.0, max(0.0, base + sum(m["delta"] for m in mods))), 2)
    if news_articles >= config()["intel"]["news_min_articles"]:
        cap = t["news_max_score"]
        delta = round(min(t["modifiers"]["news_corroborated"], max(0.0, cap - score)), 2)
        label = f"Corroborated by {news_articles} recent local news report(s) (SerpApi)"
        if delta < t["modifiers"]["news_corroborated"]:
            label += f" — capped at {cap:.2f}: news alone never verifies a report"
        mods.append({"label": label, "delta": delta, "source": "serpapi"})
        score = round(score + delta, 2)
    if score >= t["verified_threshold"]:
        status = "verified"
    elif score >= t["unverified_threshold"]:
        status = "unverified"
    else:
        status = "low_trust"
    return TrustResult(score, status, {"base": base, "modifiers": mods, "score": score})


# ---------------- priority ----------------


@dataclass
class PriorityResult:
    total: int
    breakdown: dict[str, int]


def compute_priority(
    need_type: str,
    *,
    life_safety: bool,
    vulnerabilities: list[str],
    escalation_signals: list[str],
    people_affected: int | None,
    minutes_waiting: float,
    hazard_distance_m: float | None,
) -> PriorityResult:
    p = config()["priority"]
    severity = min(50, p["severity_base"].get(need_type, 20) + (p["life_safety_bonus"] if life_safety else 0))
    wait = int(min(20, p["wait_points_per_minute"] * max(0.0, minutes_waiting)))
    vuln_hits = len(set(vulnerabilities) & LIFE_SAFETY_VULNERABILITIES)
    vulnerability = vuln_hits * p["vulnerability_points"]
    if people_affected and people_affected >= p["large_group_threshold"]:
        vulnerability += p["vulnerability_points"]
    vulnerability = min(20, vulnerability)
    if hazard_distance_m is not None and hazard_distance_m <= p["hazard_proximity_m"]:
        hazard = 10
    elif escalation_signals:
        hazard = 5
    else:
        hazard = 0
    total = severity + wait + vulnerability + hazard
    return PriorityResult(
        total,
        {
            "severity": severity,
            "wait_time": wait,
            "vulnerability": vulnerability,
            "hazard_escalation": hazard,
            "total": total,
        },
    )


# ---------------- policy ----------------


@dataclass
class PolicyDecision:
    outcome: str  # AUTO_DISPATCH | APPROVAL_REQUIRED | NEEDS_REVIEW
    rule_id: str
    reason: str
    checks: list[dict[str, Any]] = field(default_factory=list)  # every rule considered, for the audit trail

    def as_dict(self) -> dict[str, Any]:
        return {"outcome": self.outcome, "rule": self.rule_id, "reason": self.reason, "checks": self.checks}


def check_uncertainty(
    confidence: float | None, has_coordinates: bool, location_confidence: float | None
) -> PolicyDecision | None:
    """UNC-01 — evaluated right after intake, before any triage/dispatch work is spent."""
    u = config()["uncertainty"]
    problems = []
    if confidence is None or confidence < u["minimum_incident_confidence"]:
        problems.append(f"incident confidence {confidence} < {u['minimum_incident_confidence']}")
    if not has_coordinates:
        problems.append("location could not be resolved")
    elif location_confidence is not None and location_confidence < u["minimum_location_confidence"]:
        problems.append(f"location confidence {location_confidence} < {u['minimum_location_confidence']}")
    if not problems:
        return None
    r = rule("UNC-01")
    return PolicyDecision(r["outcome"], r["id"], f"{r['reason']} ({'; '.join(problems)})")


def evaluate_dispatch(*, life_safety: bool, trust_score: float) -> PolicyDecision:
    """First matching rule wins. Default is human approval (safe by default)."""
    threshold = config()["dispatch"]["life_safety_min_trust_for_auto"]
    unverified = config()["trust"]["unverified_threshold"]
    candidates = [
        ("GOV-01", life_safety and trust_score < threshold),
        ("GOV-02", trust_score >= threshold),
        ("GOV-03", (not life_safety) and trust_score >= unverified),
        ("GOV-99", True),
    ]
    checks = []
    for rule_id, matched in candidates:
        checks.append({"rule": rule_id, "matched": bool(matched)})
        if matched:
            r = rule(rule_id)
            return PolicyDecision(r["outcome"], r["id"], r["reason"], checks)
    raise AssertionError("unreachable")  # GOV-99 always matches
