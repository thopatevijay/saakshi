#!/usr/bin/env bash
# Pointer choreography helpers for the demo takes — real mouse events, so the recording shows the
# real cursor doing real things rather than pages appearing by teleport.
#
# Coordinates are given in the 960x540 preview frame (a 3420x2214 2x capture cropped at y=70) and
# converted here, so every call site reads in the same space as the screenshots used to plan it.
#
# NB: no `set -e` here. This file is *sourced*, so any shell option it sets leaks into the caller —
# and with `-e` a `pkill` that matches nothing (exit 1) silently kills the whole take runner.

pt() { python3 -c 'import sys; x,y=float(sys.argv[1]),float(sys.argv[2]); print(f"{x*1.78125:.0f},{(y*3.5625+70)/2:.0f}")' "$1" "$2"; }

# Glide the pointer smoothly to a target (~0.8s, which reads as a hand movement).
#
# **One cliclick invocation, not one per step.** The first version spawned a process per step; at 22
# steps that is 22 launches, which made a "half-second" glide cost several seconds and pushed each
# section's choreography past the length of its narration — section 5's impossible transition landed
# after the clip was due to end. cliclick accepts a whole command sequence, so the entire path plus
# its inter-step waits is now a single launch and the timing is what it claims.
glide() {
  local cmd
  cmd=$(python3 -c '
import sys
fx, fy, tx, ty = map(float, sys.argv[1:5])
steps, out = 8, []
for i in range(1, steps+1):
    t = i/steps
    e = 3*t*t - 2*t*t*t
    x = fx + (tx-fx)*e
    y = fy + (ty-fy)*e
    out.append(f"m:{x*1.78125:.0f},{(y*3.5625+70)/2:.0f}")
print(" ".join(out))' "$1" "$2" "$3" "$4")
  cliclick -w 10 $cmd 2>/dev/null
}

click()   { cliclick "c:$(pt "$1" "$2")" 2>/dev/null; }
# Click a field and select its contents, so typing REPLACES rather than appends.
# Sections 3 and 5 both type into the same trace form; without this the second take typed
# "GJ01AB1234" into a field still holding "1118R" and produced "L3R1AB1234", and the trace never ran.
setfield() { cliclick "c:$(pt "$1" "$2")" 2>/dev/null; sleep 0.25; cliclick kd:cmd t:a ku:cmd 2>/dev/null; sleep 0.2; }
type_()   { cliclick -w 38 "t:$1" 2>/dev/null; }   # 38ms: 26 dropped characters
pause()   { python3 -c 'import time,sys; time.sleep(float(sys.argv[1]))' "$1"; }
# Scroll at a point. One invocation for the whole run, same reason as glide.
scrollp() {
  local n=$3 cmd="m:$(pt "$1" "$2")"
  for i in $(seq 1 "$n"); do cmd="$cmd w:90 sd:5"; done
  cliclick $cmd 2>/dev/null
}
