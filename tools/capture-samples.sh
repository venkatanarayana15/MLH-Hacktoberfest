#!/usr/bin/env bash
# Regenerate the synthetic PNGs (three prescription slips + the demo medicine
# strip) from tools/render-samples.html using headless Chrome. Requires Google
# Chrome installed at the default path (override with CHROME=/path/to/chrome).
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-C:/Program Files/Google/Chrome/Application/chrome.exe}"
URLBASE="file:///$(cygpath -m "$PWD/tools/render-samples.html")"

mkdir -p public/samples
# 716x488 keeps rx1..3 and strip1 at the same scale.
for id in rx1 rx2 rx3 strip1; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=716,488 \
    --screenshot="public/samples/$id.png" "$URLBASE?id=$id" >/dev/null 2>&1
  echo "captured public/samples/$id.png"
done
