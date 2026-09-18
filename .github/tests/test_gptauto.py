import sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from gptauto.engine import Signal, advance
from gptauto.github import RunSummary
from gptauto.model import State, Task
from gptauto.orchestrator import Orchestrator

class FakeGitHub:
    def __init__(self,run=None,pr=None,release=None):
        self.run=run or RunSummary("completed","success",42);self.pr=pr or {"merged":True};self.release=release
    def latest_run(self,**kwargs):return self.run
    def classify_run(self,r):
        if r.status!="completed":return "waiting"
        return "passed" if r.conclusion=="success" else "failed"
    def pull(self,n):return self.pr
    def release_by_tag(self,t):return self.release

class GPTAutoTests(unittest.TestCase):
    def task(self,state):
        return Task("t","goal","b8vipvip/GPTWork",["verified"],state=state,metadata={"work_branch":"fix/x","work_head_sha":"abc","pr_number":7,"default_branch":"main","merge_sha":"def","release_tag":"v1.0.0"})
    def test_waiting_actions_are_not_done(self):
        t=self.task(State.WAIT_CI);d=Orchestrator(FakeGitHub(RunSummary("queued",None,9))).reconcile_once(t)
        self.assertEqual(d.action,"wait");self.assertEqual(t.state,State.WAIT_CI)
    def test_ci_failure_enters_analysis(self):
        t=self.task(State.WAIT_CI);Orchestrator(FakeGitHub(RunSummary("completed","failure",9))).reconcile_once(t);self.assertEqual(t.state,State.ANALYZE)
    def test_ci_success_advances_to_merge(self):
        t=self.task(State.WAIT_CI);Orchestrator(FakeGitHub()).reconcile_once(t);self.assertEqual(t.state,State.MERGE)
    def test_release_is_not_done_without_release(self):
        t=self.task(State.RELEASE);t.release_required=True
        self.assertEqual(Orchestrator(FakeGitHub()).reconcile_once(t).action,"wait")
        Orchestrator(FakeGitHub(release={"draft":False})).reconcile_once(t);self.assertEqual(t.state,State.VERIFY)
    def test_repair_budget_blocks(self):
        t=self.task(State.ANALYZE);t.max_repair_attempts=1
        advance(t,Signal("fixable"));self.assertEqual(t.state,State.FIX)
        t.state=State.ANALYZE;advance(t,Signal("fixable"));self.assertEqual(t.state,State.BLOCKED)
    def test_state_persists(self):
        t=self.task(State.WAIT_CI)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"task.json";t.save(p);loaded=Task.load(p)
            self.assertEqual(loaded.state,State.WAIT_CI);self.assertEqual(loaded.metadata["pr_number"],7)

if __name__=="__main__":unittest.main()
