import sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from gptauto.engine import begin_verify,criterion,finish,gate,is_complete,plan_ready,start
from gptauto.model import CriterionStatus,Gate,GateStatus,State,Task
from gptauto.planner import GoalPlanner
class GPTAutoV02Tests(unittest.TestCase):
    def task(self,goal):
        t=Task("t",goal,"b8vipvip/GPTWork",[]);start(t);GoalPlanner().apply(t);plan_ready(t);return t
    def test_ci_goal_does_not_force_release(self):
        t=self.task("修复 Actions 直到 CI 全绿");gs=[x.gate for x in t.plan];self.assertIn(Gate.PR_CI,gs);self.assertNotIn(Gate.RELEASE,gs)
    def test_merge_goal_does_not_force_release(self):
        t=self.task("完成修复并合并到 main");gs=[x.gate for x in t.plan];self.assertIn(Gate.MERGE,gs);self.assertNotIn(Gate.RELEASE,gs)
    def test_release_goal_selects_release_chain(self):
        t=self.task("修复并发布 v0.6.0 正式版");gs=[x.gate for x in t.plan]
        for g in [Gate.PR,Gate.PR_CI,Gate.MERGE,Gate.MAIN_CI,Gate.RELEASE]:self.assertIn(g,gs)
    def test_done_requires_dod_evidence(self):
        t=self.task("修改 README 文档")
        for s in t.plan:gate(t,s.gate,GateStatus.PASSED,"ok")
        begin_verify(t);self.assertFalse(is_complete(t))
        for i in range(len(t.definition_of_done)):criterion(t,i,CriterionStatus.PASSED,"verified")
        finish(t);self.assertTrue(is_complete(t));self.assertEqual(t.state,State.DONE)
    def test_state_persists_dynamic_plan(self):
        t=self.task("合并到 main")
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"task.json";t.save(p);loaded=Task.load(p);self.assertEqual([x.gate for x in loaded.plan],[x.gate for x in t.plan])
if __name__=="__main__":unittest.main()
