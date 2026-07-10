#!/bin/bash
# Re-sync the family preview site from identity-book's repo and redeploy.
# Run by the ops agent each morning when identity-book's app files changed.
set -euo pipefail
cd "$(dirname "$0")"
SRC="$HOME/agents/projects/identity-book/repo"
# Curated copy: app files only — never docs/ or business material.
rm -rf app && mkdir app
cp -R "$SRC/index.html" "$SRC/book.html" "$SRC/js" "$SRC/css" app/
[ -d "$SRC/assets" ] && [ -n "$(ls -A "$SRC/assets" 2>/dev/null)" ] && cp -R "$SRC/assets" app/
date -u '+%Y-%m-%d %H:%M UTC' > last-sync.txt
git add -A
git diff --cached --quiet || git commit -m "Sync app from identity-book $(cat last-sync.txt)"
git push origin main 2>/dev/null || true
npx -y netlify-cli deploy --dir=. --prod --site 9048ba0f-fbcb-4019-ab94-8721942afd02
