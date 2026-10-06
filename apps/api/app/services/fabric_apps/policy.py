"""Evaluate Rayfin role declarations locally (stand-in for Data API Builder policy enforcement).

Policies arrive as the AST produced by `serializeCheckToAst` from @microsoft/rayfin-core:
  leaf   {"op": "eq"|"neq", "lhs": {"claim": ..} | {"field": ..}, "rhs": ref | literal}
  branch {"op": "and"|"or", "args": [node, node, ...]}
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from app.services.fabric_apps.model import Entity

ACTIONS = {"create", "read", "update", "delete"}


@dataclass(frozen=True)
class LocalUser:
    """Fake signed-in user. In Fabric this comes from Entra ID; here it is a fixed local list."""

    id: str
    display_name: str
    email: str
    app_role: str
    department_code: str | None

    @property
    def claims(self) -> dict[str, str]:
        return {"sub": self.id, "email": self.email, "role": self.app_role}

    @property
    def platform_roles(self) -> tuple[str, ...]:
        # Every signed-in user is `authenticated` in Rayfin; no anonymous access in this app.
        return ("authenticated",)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "email": self.email,
            "role": self.app_role,
            "department_code": self.department_code,
        }


class PolicyDenied(PermissionError):
    pass


def _resolve(ref: Any, claims: Mapping[str, Any], item: Mapping[str, Any]) -> Any:
    if isinstance(ref, dict) and "claim" in ref:
        return claims.get(ref["claim"])
    if isinstance(ref, dict) and "field" in ref:
        return item.get(ref["field"])
    return ref


def evaluate(node: Mapping[str, Any], claims: Mapping[str, Any], item: Mapping[str, Any]) -> bool:
    op = node["op"]
    if op in {"and", "or"}:
        results = (evaluate(arg, claims, item) for arg in node["args"])
        return all(results) if op == "and" else any(results)
    left = _resolve(node["lhs"], claims, item)
    right = _resolve(node["rhs"], claims, item)
    if op == "eq":
        return left is not None and left == right
    if op in {"neq", "ne"}:
        return left != right
    raise ValueError(f"Unsupported policy operator: {op}")


def declarations_for(entity: Entity, user: LocalUser, action: str):
    return [
        declaration
        for declaration in entity.roles
        if declaration.role in user.platform_roles
        and (action in declaration.actions or "*" in declaration.actions)
    ]


def can(entity: Entity, user: LocalUser, action: str, item: Mapping[str, Any] | None = None) -> bool:
    """True when at least one matching declaration allows the action on `item`.

    With `item=None` it answers "may this user attempt the action at all" (policy ignored).
    """
    if action not in ACTIONS:
        raise ValueError(f"Unknown action: {action}")
    for declaration in declarations_for(entity, user, action):
        if declaration.policy is None or item is None:
            return True
        if evaluate(declaration.policy, user.claims, item):
            return True
    return False


def require(entity: Entity, user: LocalUser, action: str, item: Mapping[str, Any] | None = None) -> None:
    if not can(entity, user, action, item):
        target = f" this {entity.name}" if item is not None else f" {entity.name}"
        raise PolicyDenied(f"{user.email} ({user.app_role}) may not {action}{target}")
