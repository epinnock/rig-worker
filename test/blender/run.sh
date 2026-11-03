#!/usr/bin/env bash
# Blender compatibility test: rig-worker output must open in Blender with the same shape, colours, textures, bones,
# weights and motion, and Blender's re-exports must come back into rig-worker the same.
#   BLENDER=/path/to/blender npm run test:blender      (tested with Blender 4.5; output in work/blender)
set -euo pipefail
cd "$(dirname "$0")/../.."
B="${BLENDER:-blender}"
command -v "$B" >/dev/null || { echo "Blender not found: set BLENDER=/path/to/blender"; exit 2; }
D="${1:-work/blender}"
mkdir -p "$D"
run() {  # Blender is chatty: keep its log, show the result lines (and the whole log if it fails)
  local log="$D/blender.log" s=0
  PYTHONNOUSERSITE=1 "$B" -b --factory-startup --python-exit-code 1 -P "$@" >"$log" 2>&1 || s=$?
  grep -E '^CASE|_OK|_CHECK' "$log" || true
  if [ "$s" -ne 0 ]; then tail -30 "$log"; exit "$s"; fi
}
echo "1/4 Blender makes a textured mesh and a Blender rig"; run test/blender/make_inputs.py -- "$D"
echo "2/4 rig-worker models, binds, paints and animates";   node test/blender/make.mjs "$D"
echo "3/4 Blender imports every result and compares";        run test/blender/check.py -- "$D"
echo "4/4 rig-worker reads Blender's re-exports";             node test/blender/reimport.mjs "$D"
echo "reports: $D/blender_report.json $D/reimport_report.json"
