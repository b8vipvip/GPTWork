from dataclasses import dataclass
from .engine import Signal, advance
from .model import State, Task

@dataclass(frozen=True)
class Decision:
    action:str
    reason:str

class Orchestrator:
    def __init__(self,client):self.github=client
    def decide(self,task):
        m=task.metadata
        if task.state==State.PR:
            n=m.get("pr_number");return Decision("opened",f"PR #{n} recorded") if n else Decision("wait","PR number has not been recorded")
        if task.state==State.WAIT_CI:
            branch=m.get("work_branch")
            if not branch:return Decision("blocked","work_branch is required")
            run=self.github.latest_run(branch=branch,event="pull_request",workflow=m.get("ci_workflow","ci.yml"),head_sha=m.get("work_head_sha"))
            c=self.github.classify_run(run)
            if c=="passed":return Decision("passed",f"PR CI run {run.run_id} passed")
            if c=="failed":return Decision("failed",f"PR CI run {run.run_id} failed")
            return Decision("wait",f"PR CI is {run.status}")
        if task.state==State.MERGE:
            n=m.get("pr_number")
            if not n:return Decision("blocked","pr_number is required")
            pr=self.github.pull(int(n))
            if pr.get("merged"):return Decision("merged",f"PR #{n} is merged")
            return Decision("wait",f"PR #{n} is not merged yet")
        if task.state==State.MAIN_CI:
            default=m.get("default_branch","main")
            run=self.github.latest_run(branch=default,event="push",workflow=m.get("ci_workflow","ci.yml"),head_sha=m.get("merge_sha"))
            c=self.github.classify_run(run)
            if c=="passed":return Decision("passed",f"main CI run {run.run_id} passed")
            if c=="failed":return Decision("failed",f"main CI run {run.run_id} failed")
            return Decision("wait",f"main CI is {run.status}")
        if task.state==State.RELEASE:
            if not task.release_required:return Decision("skipped","task does not require a release")
            tag=m.get("release_tag")
            if not tag:return Decision("blocked","release_tag is required")
            rel=self.github.release_by_tag(tag)
            if rel and not rel.get("draft"):return Decision("released",f"release {tag} exists")
            return Decision("wait",f"release {tag} is not published yet")
        if task.state==State.VERIFY:
            v=m.get("verification",{})
            if v.get("passed") is True:return Decision("verified",v.get("reason","acceptance verification passed"))
            if v.get("passed") is False:return Decision("failed",v.get("reason","acceptance verification failed"))
            return Decision("wait","final verification evidence has not been recorded")
        return Decision("wait",f"{task.state.value} requires reasoning/worker action")
    def reconcile_once(self,task):
        d=self.decide(task)
        if d.action!="wait":advance(task,Signal(d.action,d.reason))
        return d
