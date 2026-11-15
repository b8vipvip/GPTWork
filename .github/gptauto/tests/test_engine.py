from __future__ import annotations

import unittest

from gptauto.engine import gate
from gptauto.model import Gate, GateStatus, GateStep, State, Task


def make_task(*, max_repair_attempts: int = 3, required: bool = True) -> Task:
    return Task(
        "GA-gate-idempotency",
        "verify gate retry accounting",
        "example/GPTWork",
        ["failed CI is repaired"],
        state=State.EXECUTE,
        plan=[GateStep(Gate.PR_CI, required=required)],
        max_repair_attempts=max_repair_attempts,
    )


class GateFailureAccountingTests(unittest.TestCase):
    def test_repeated_same_failure_is_idempotent(self) -> None:
        task = make_task()
        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 100 failed")
        history_after_first = len(task.history)

        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 100 failed")

        self.assertEqual(task.repair_attempts, 1)
        self.assertEqual(task.state, State.EXECUTE)
        self.assertEqual(len(task.history), history_after_first)

    def test_distinct_failure_evidence_consumes_another_repair_attempt(self) -> None:
        task = make_task()
        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 100 failed")
        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 101 failed")

        self.assertEqual(task.repair_attempts, 2)
        self.assertEqual(task.state, State.EXECUTE)

    def test_waiting_then_new_failure_counts_a_new_attempt(self) -> None:
        task = make_task()
        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 100 failed")
        gate(task, Gate.PR_CI, GateStatus.WAITING, "CI run 101 queued")
        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 101 failed")

        self.assertEqual(task.repair_attempts, 2)

    def test_optional_gate_failure_does_not_consume_repair_budget(self) -> None:
        task = make_task(required=False)
        gate(task, Gate.PR_CI, GateStatus.FAILED, "optional CI run 100 failed")

        self.assertEqual(task.repair_attempts, 0)
        self.assertEqual(task.state, State.EXECUTE)

    def test_repeated_failure_cannot_exhaust_budget_without_new_evidence(self) -> None:
        task = make_task(max_repair_attempts=1)
        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 100 failed")
        for _ in range(5):
            gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 100 failed")

        self.assertEqual(task.repair_attempts, 1)
        self.assertEqual(task.state, State.EXECUTE)

        gate(task, Gate.PR_CI, GateStatus.FAILED, "CI run 101 failed")
        self.assertEqual(task.repair_attempts, 2)
        self.assertEqual(task.state, State.BLOCKED)


if __name__ == "__main__":
    unittest.main()
