from dataclasses import dataclass
from .model import State, Task

@dataclass(frozen=True)
class Signal:
    name: str
    reason: str = ""

def advance(task: Task, signal: Signal) -> Task:
    s=signal.name.lower()
    transitions={
      State.GOAL:{"accepted":State.INSPECT},
      State.INSPECT:{"inspected":State.IMPLEMENT,"blocked":State.BLOCKED},
      State.IMPLEMENT:{"implemented":State.PR,"blocked":State.BLOCKED},
      State.PR:{"opened":State.WAIT_CI,"blocked":State.BLOCKED},
      State.WAIT_CI:{"passed":State.MERGE,"failed":State.ANALYZE,"blocked":State.BLOCKED},
      State.ANALYZE:{"fixable":State.FIX,"blocked":State.BLOCKED},
      State.FIX:{"fixed":State.WAIT_CI,"blocked":State.BLOCKED},
      State.MERGE:{"merged":State.MAIN_CI,"failed":State.ANALYZE,"blocked":State.BLOCKED},
      State.MAIN_CI:{"passed":State.RELEASE,"failed":State.ANALYZE,"blocked":State.BLOCKED},
      State.RELEASE:{"released":State.VERIFY,"skipped":State.VERIFY,"failed":State.ANALYZE,"blocked":State.BLOCKED},
      State.VERIFY:{"verified":State.DONE,"failed":State.ANALYZE,"blocked":State.BLOCKED},
    }
    target=transitions.get(task.state,{}).get(s)
    if target is None: raise ValueError(f"invalid transition {task.state.value} + {signal.name}")
    if target==State.FIX:
        task.repair_attempts += 1
        if task.repair_attempts > task.max_repair_attempts: target=State.BLOCKED
    task.state=target; task.record(signal.reason or signal.name); return task

def is_complete(task: Task) -> bool:
    return task.state==State.DONE
