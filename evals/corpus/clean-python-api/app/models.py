from dataclasses import dataclass
from typing import Literal

@dataclass(frozen=True)
class User:
    id: str
    role: Literal["member", "admin"]
