import argparse, json, uuid
from pathlib import Path
from .engine import Signal, advance, is_complete
from .github import GitHubClient
from .model import Task
from .orchestrator import Orchestrator

def main():
    p=argparse.ArgumentParser(prog="gptwork-gptauto");s=p.add_subparsers(dest="command",required=True)
    i=s.add_parser("init");i.add_argument("--goal",required=True);i.add_argument("--repo",required=True);i.add_argument("--done",action="append",default=[]);i.add_argument("--release-required",action="store_true");i.add_argument("--out",required=True)
    st=s.add_parser("status");st.add_argument("task")
    sp=s.add_parser("step");sp.add_argument("task");sp.add_argument("signal");sp.add_argument("--reason",default="")
    md=s.add_parser("metadata");md.add_argument("task");md.add_argument("--set",action="append",default=[])
    rc=s.add_parser("reconcile");rc.add_argument("task")
    a=p.parse_args()
    if a.command=="init":
        done=a.done or ["requested change implemented","required CI passed","final behavior verified"]
        t=Task(str(uuid.uuid4()),a.goal,a.repo,done,release_required=a.release_required);t.record("goal contract created");t.save(a.out);print(t.state.value);return 0
    t=Task.load(a.task)
    if a.command=="status":
        print(json.dumps({"task_id":t.task_id,"state":t.state.value,"complete":is_complete(t),"repairs":f"{t.repair_attempts}/{t.max_repair_attempts}","metadata":t.metadata},ensure_ascii=False));return 0
    if a.command=="metadata":
        for item in a.set:
            key,sep,value=item.partition("=")
            if not sep:raise SystemExit(f"invalid --set: {item}")
            try:value=json.loads(value)
            except json.JSONDecodeError:pass
            t.metadata[key]=value
        t.record("task metadata updated");t.save(a.task);print(t.state.value);return 0
    if a.command=="reconcile":
        d=Orchestrator(GitHubClient(t.repository)).reconcile_once(t);t.save(a.task);print(json.dumps({"state":t.state.value,"action":d.action,"reason":d.reason},ensure_ascii=False));return 0
    advance(t,Signal(a.signal,a.reason));t.save(a.task);print(t.state.value);return 0

if __name__=="__main__":raise SystemExit(main())
