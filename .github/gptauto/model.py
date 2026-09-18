from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
import json
from pathlib import Path
from typing import Any

class State(str, Enum):
    GOAL="GOAL"; INSPECT="INSPECT"; IMPLEMENT="IMPLEMENT"; PR="PR"; WAIT_CI="WAIT_CI"
    ANALYZE="ANALYZE"; FIX="FIX"; MERGE="MERGE"; MAIN_CI="MAIN_CI"; RELEASE="RELEASE"
    VERIFY="VERIFY"; DONE="DONE"; BLOCKED="BLOCKED"

@dataclass
class Event:
    at: str
    state: str
    reason: str

@dataclass
class Task:
    task_id: str
    goal: str
    repository: str
    definition_of_done: list[str]
    state: State = State.GOAL
    repair_attempts: int = 0
    max_repair_attempts: int = 3
    release_required: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    history: list[Event] = field(default_factory=list)

    def record(self, reason: str):
        self.history.append(Event(datetime.now(timezone.utc).isoformat(), self.state.value, reason))

    def to_dict(self):
        data=asdict(self); data["state"]=self.state.value; return data

    @classmethod
    def from_dict(cls, data):
        payload=dict(data); payload["state"]=State(payload.get("state","GOAL"))
        payload["history"]=[Event(**e) for e in payload.get("history",[])]
        return cls(**payload)

    def save(self, path):
        p=Path(path); p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps(self.to_dict(),indent=2,ensure_ascii=False)+"\n",encoding="utf-8")

    @classmethod
    def load(cls, path):
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
