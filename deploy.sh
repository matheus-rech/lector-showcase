#!/usr/bin/env bash
# One-shot redeploy of the lector-showcase artifact to GitHub Pages.
#
# Usage:
#   ./deploy.sh                 # build, inline, commit if changed, push
#   ./deploy.sh -m "fix: ..."   # custom commit message
#
# Pipeline:
#   src/*.tsx  →  parcel build  →  dist/*.js + dist/*.css
#                              →  inline into bundle.html (single file)
#                              →  cp bundle.html index.html (Pages root)
#                              →  git commit + push  →  Pages rebuild

set -euo pipefail

cd "$(dirname "$0")"

MSG="${1-}"
if [[ "$MSG" == "-m" ]]; then
  MSG="${2:-chore: redeploy bundle}"
elif [[ -z "$MSG" ]]; then
  MSG="chore: redeploy bundle ($(date +%Y-%m-%d-%H%M))"
fi

echo "▸ Building with Parcel…"
rm -rf dist bundle.html
pnpm exec parcel build index.html --dist-dir dist --no-source-maps >/dev/null 2>&1 || {
  echo "✗ Parcel build failed. Re-run for full output:"
  echo "  pnpm exec parcel build index.html --dist-dir dist --no-source-maps"
  exit 1
}

echo "▸ Inlining JS + CSS into bundle.html…"
node -e '
const fs = require("fs"), path = require("path");
let html = fs.readFileSync("dist/index.html", "utf8");
html = html.replace(/<link rel=stylesheet href=\/([^>]+\.css)>/g, (_, f) =>
  `<style>${fs.readFileSync(path.join("dist", f), "utf8")}</style>`);
html = html.replace(/<script type=module src=\/([^>]+\.js)><\/script>/g, (_, f) =>
  `<script type="module">${fs.readFileSync(path.join("dist", f), "utf8")}</script>`);
fs.writeFileSync("bundle.html", html);
const kb = (fs.statSync("bundle.html").size / 1024).toFixed(1);
console.log("  ✓ bundle.html " + kb + " KB");
'

cp bundle.html index.html
echo "▸ index.html refreshed."

if git diff --quiet -- index.html bundle.html; then
  echo "▸ No changes to commit. Live URL is already current."
  echo "  https://matheus-rech.github.io/lector-showcase/"
  exit 0
fi

echo "▸ Committing + pushing…"
git add index.html bundle.html
git commit -q -m "$MSG"
git push -q

echo
echo "✓ Pushed. GitHub Pages will rebuild in ~30s."
echo "  https://matheus-rech.github.io/lector-showcase/"
