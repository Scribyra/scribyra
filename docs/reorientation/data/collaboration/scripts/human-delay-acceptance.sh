#!/usr/bin/env bash
# Run through <repo>'s flake. SCRATCH must be an allowed writable scratch directory.
set -u
ulimit -c 0
: "${REPO:?Set REPO to <repo>}" "${SCRATCH:?Set SCRATCH to <scratch>}"
mkdir -p "$SCRATCH"
pids=()
for policy in open nomcast; do
  for pair in firefox-firefox chromium-chromium firefox-chromium chromium-firefox; do
    PAIRS="$pair" unshare -Urn --kill-child node "$REPO/docs/reorientation/data/collaboration/scripts/human-delay.mjs" final "$policy" "${DELAYS:-0,30,180}" > "$SCRATCH/acceptance-$policy-$pair-wall-clock.log" 2>&1 &
    pids+=("$!")
  done
done
failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then failed=$((failed+1)); fi
done
echo "Acceptance batches: $((8-failed)) passed, $failed failed"
exit "$failed"
