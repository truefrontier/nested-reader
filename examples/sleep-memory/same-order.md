---
title: Same order
source: sharp-wave-ripples.md
question: Why does replay keep the same order as the original run?
created: 2026-09-10T09:44:00
mode: deep-dive
---

# Same order

Forward replay preserves the order of the run because the sequence is stored in the connections between place cells. Cells that fired one after another during the run strengthened their forward links, so when the first cell fires again during a ripple the chain tends to unfold the same way.

Reverse replay, seen mostly at the end of a run when the animal reaches a reward, runs the chain backwards. One reading is that reverse replay assigns credit: the reward is fresh, so replaying the path backwards from it tags the steps that led there.

Both directions appear during sleep, but forward replay dominates, and it is forward replay that best predicts how well the route is remembered the next day.
