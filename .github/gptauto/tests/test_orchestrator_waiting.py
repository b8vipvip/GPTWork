from __future__ import annotations

import unittest

from gptauto.model import Gate, GateStatus, GateStep, State, Task
from gptauto.orchestrator import Orchestrator


class WaitingGitHub:
    def latest_run(self, **kwargs):
        return type("Run", (), {"run_id": 123})()

    def classify_run(self, run):
        return "waiting"


def make_task() -> Task:
    return Task(
        "GA-waiting-gate-history",
        "persist waiting gate evidence",
        "example/GPTWork",
        ["waiting gate is recorded"],
        state=State.EXECUTE,
        plan=[GateStep(Gate.PR_CI)],
        metadata={
            "work_branch": "feature/example",
            "work_head_sha": "a" * 40,
            "ci_workflow": "CI",
        },
    )


class WaitingGatePersistenceTests(unittest.TestCase):
    def test_waiting_transition_is_persisted_with_reason(self) -> None:
        task = make_task()
        orchestrator = Orchestrator(WaitingGitHub())

        decision = orchestrator.reconcile_once(task)

        self.assertEqual(decision.action, "wait")
        self.assertEqual(task.plan[0].status, GateStatus.WAITING)
        self.assertEqual(task.plan[0].evidence, "PR CI run 123 is waiting")
        gate_events = [event for event in task.history if event.kind == "gate"]
        self.assertEqual(len(gate_events), 1)
        self.assertEqual(gate_events[0].status, GateStatus.WAITING.value)
        self.assertEqual(gate_events[0].evidence, "PR CI run 123 is waiting")

    def test_repeated_identical_waiting_observation_is_idempotent(self) -> None:
        task = make_task()
        orchestrator = Orchestrator(WaitingGitHub())

        orchestrator.reconcile_once(task)
        history_size = len(task.history)
        orchestrator.reconcile_once(task)

        self.assertEqual(len(task.history), history_size)
        self.assertEqual(task.plan[0].evidence, "PR CI run 123 is waiting")


if __name__ == "__main__":
    unittest.main()
