#!/usr/bin/env python3
"""Lists the system calls made inside compile sandboxes, to review seccomp::allowed().

Trace the test suite through a bwrap wrapper, then run this on the trace directory:

  cat > tmp/bwrap-strace.sh <<'SH'
  #!/bin/sh
  exec strace -f -qq -s 0 -o "$PWD/tmp/st/trace.$$" -- /nix/store/…-bubblewrap-…/bin/bwrap "$@"
  SH
  nix develop -c sh -c 'SCRIBYRA_BWRAP=$PWD/tmp/bwrap-strace.sh cargo test -p scribyra-compile'
  python3 crates/compile/tools/strace-syscalls.py tmp/st [names to show examples of…]

(The runner clears the environment, so the wrapper names strace and bwrap by absolute path.)
Only calls made after the sandboxed command's execve, and by its descendants, are counted:
bwrap's own setup runs before the filter is loaded.
"""
import re, sys, glob, collections
line_re = re.compile(r'^(\d+)\s+(?:<\.\.\. (\w+) resumed>|(\w+)\()(.*)$')
names = collections.Counter()
for f in glob.glob(sys.argv[1] + '/trace.*'):
    rows = []
    for l in open(f, errors='replace'):
        m = line_re.match(l)
        if not m: continue
        pid = int(m.group(1)); name = m.group(2) or m.group(3); rest = m.group(4)
        rows.append((pid, name, l))
    start = {}; parent = {}
    for i, (pid, name, l) in enumerate(rows):
        if name == 'execve' and 'bwrap' not in l and pid not in start and '= 0' in l.split(')')[-1] + l[-10:]:
            start[pid] = i
        if name in ('clone', 'clone3', 'fork', 'vfork'):
            r = re.search(r'= (\d+)\s*$', l)
            if r and int(r.group(1)) > 0: parent[int(r.group(1))] = pid
    sb = set(start)
    changed = True
    while changed:
        changed = False
        for c, p in parent.items():
            if p in sb and c not in sb: sb.add(c); changed = True
    for i, (pid, name, l) in enumerate(rows):
        if pid in sb and (pid not in start or i >= start[pid]):
            names[name] += 1
            if name in sys.argv[2:]: print("EX", l.strip()[:160])
for n, c in sorted(names.items()): print(n, c)
