#!/usr/bin/env bash
# Rebuilds every PDF in docs/manual from its source. Needs Python 3 and the repo's Playwright.
#   bash docs/manual/build/build.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
B=docs/manual/build
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 -m venv "$TMP/venv" && "$TMP/venv/bin/pip" -q install markdown >/dev/null
PY="$TMP/venv/bin/python"
for doc in "MY-FOOD-Installation-and-Operations-Manual 0" "MY-FOOD-Quick-Reference 1" "MY-FOOD-Installer-Checklist 1"; do
  set -- $doc
  "$PY" "$B/md2html.py" "docs/manual/$1.md" "$TMP/$1.html" "$2"
  node "$B/html2pdf.mjs" "$TMP/$1.html" "docs/manual/$1.pdf" "$2"
done
(cd "$B" && "$PY" installer_guide.py "$TMP/installer.html" && "$PY" hub_guide.py "$TMP/hub.html")
node "$B/html2pdf.mjs" "$TMP/installer.html" docs/manual/MY-FOOD-Installer-Guide-with-Pictures.pdf 0 "MY FOOD Installer Guide"
node "$B/html2pdf.mjs" "$TMP/hub.html" docs/manual/MY-FOOD-Hub-Guide-with-Pictures.pdf 0 "MY FOOD Hub Guide"
echo "PDFs rebuilt in docs/manual"
