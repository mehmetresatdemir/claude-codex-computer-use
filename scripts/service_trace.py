#!/usr/bin/env python3
"""Where does the time go inside Codex Computer Use? Parse a `log stream` capture of SkyComputerUseService and print, per IPC request,
how long the service spent before the screenshot (settle wait), in the screenshot, and after it
(accessibility tree + serialization). Columns are milliseconds. Every action shows up as two requests:
a ~0 ms policy check and the action itself. Usage:
  /usr/bin/log stream --level debug --style compact \
    --predicate 'process == "SkyComputerUseService"' > trace.txt   # run your actions, then Ctrl-C
  python3 scripts/service_trace.py trace.txt
"""
import re, sys
from datetime import datetime
ts = lambda s: datetime.strptime(s, "%H:%M:%S.%f")
rows=[]; cur=None
for line in open(sys.argv[1], errors="replace"):
    m = re.match(r"^\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d\.\d+)\s.*?SkyComputerUseService\[\d+:[0-9a-f]+\] (.*)$", line)
    if not m: continue
    t, msg = ts(m.group(1)), m.group(2)
    if "Transaction created" in msg: cur={"start":t,"cap0":None,"cap1":None}
    elif cur and "SCStream initWithFilter" in msg and cur["cap0"] is None: cur["cap0"]=t
    elif cur and "SCStream dealloc" in msg: cur["cap1"]=t
    elif cur and "Transaction released" in msg:
        cur["end"]=t; rows.append(cur); cur=None
ms = lambda a,b: (b-a).total_seconds()*1000 if a and b else None
print(f"{'start':>12} {'total':>7} {'settle':>8} {'capture':>9} {'tree':>6}  kind")
for r in rows:
    tot=ms(r["start"],r["end"])
    if r["cap0"]:
        kind="action/observe (with screenshot)"
        print(f"{r['start'].strftime('%H:%M:%S.%f')[:-3]:>12} {tot:7.0f} {ms(r['start'],r['cap0']):8.0f} {ms(r['cap0'],r['cap1']):9.0f} {ms(r['cap1'],r['end']):6.0f}  {kind}")
    else:
        kind="policy or no-op (no screenshot)" if tot<5 else "request without screenshot"
        print(f"{r['start'].strftime('%H:%M:%S.%f')[:-3]:>12} {tot:7.0f} {'-':>8} {'-':>9} {'-':>6}  {kind}")
