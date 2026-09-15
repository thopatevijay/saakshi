#!/usr/bin/env bash
# Pointer choreography, one function per section. Coordinates are in the 960x540 preview frame.
#
# Paced so the action fills the narration: each glide is ~0.8s and the pauses are sized so the
# pointer arrives where the voiceover is pointing, rather than finishing early and leaving the
# viewer looking at a still page. Section lengths come from the cue sheet in DEMO_SCRIPT.md:
#   s1 26.2  s2 22.4  s3 42.1  s4 28.6  s5 38.3  s6 22.1

# Registry: the estate, the "not on the map" explanation, then the measured trust bands.
s1() {
  glide 600 430 30 57;     pause 2.2
  glide 30 57 520 300;     pause 2.6
  glide 520 300 862 250;   pause 2.4
  glide 862 250 862 345;   pause 2.6
  scrollp 520 350 3;       pause 2.0
  glide 520 350 175 470;   pause 3.0
  glide 175 470 175 505;   pause 3.5
}

# Video wall: the grid controls, then the per-tile delivery badges.
s2() {
  glide 600 430 466 33;    pause 2.6      # the 2x2 / 3x3 / 4x4 controls
  glide 466 33 300 230;    pause 2.8      # onto a tile
  glide 300 230 170 247;   pause 3.2      # its measured delivery badge
  glide 170 247 700 230;   pause 2.8      # across to a second tile
  glide 700 230 575 247;   pause 3.6
}

# The government read: type it in, run it, then hold on the crop.
s3() {
  glide 600 430 24 102;    click 24 102;  pause 3.0
  glide 24 102 205 177;    setfield 205 177; pause 0.5
  type_ "1118R";           pause 1.4
  glide 205 177 347 177;   setfield 347 177; pause 0.5
  type_ "FIR 2026-00123 government feed review"; pause 1.4
  glide 347 177 242 216;   click 242 216; pause 4.0
  scrollp 520 350 4;       pause 2.2
  glide 520 350 215 390;   pause 5.0      # onto the crop itself — the hoarding
  glide 215 390 600 470;   pause 4.0      # across the evidence row
}

# The alert queue: the mock-providers banner, then down the rows.
s4() {
  glide 600 430 25 124;    click 25 124;  pause 3.2
  glide 25 124 500 100;    pause 3.6      # the MOCK PROVIDERS banner
  glide 500 100 300 270;   pause 3.0      # the partial-read row
  scrollp 520 350 2;       pause 2.2
  glide 300 270 760 300;   pause 3.4      # the match badges
  glide 760 300 300 400;   pause 3.6
}

# The cloned plate: type it, run it, then the impossible transition.
s5() {
  glide 600 430 24 102;    click 24 102;  pause 2.6
  glide 24 102 205 177;    setfield 205 177; pause 0.5
  type_ "GJ01AB1234";      pause 1.2
  glide 205 177 347 177;   setfield 347 177; pause 0.5
  type_ "FIR 2026-00188 cloned plate review"; pause 1.2
  glide 347 177 242 216;   click 242 216; pause 5.0
  scrollp 520 350 4;       pause 2.4
  glide 520 350 790 300;   pause 3.6      # the reconstructed-route panel
  glide 790 300 790 430;   pause 4.5      # the impossible transition, 1109 km/h
  glide 790 430 700 495;   pause 4.0      # the two (fixture) crops
}

# Close: the exports, then the disclaimer the product ends on.
s6() {
  glide 600 430 180 216;   pause 3.0      # Export CSV
  glide 180 216 225 216;   pause 3.0      # Export PDF
  scrollp 520 350 5;       pause 2.4
  glide 520 350 600 500;   pause 5.5      # the closing disclaimer
}
