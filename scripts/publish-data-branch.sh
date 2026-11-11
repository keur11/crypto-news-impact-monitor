#!/usr/bin/env bash
# Objavi mapo data/ na vejo "data" kot en commit brez zgodovine (force-push).
# Glavna veja se ne spreminja (brez praznih ali podatkovnih commitov na main).
# Uporaba (v GitHub Actions): GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo scripts/publish-data-branch.sh "sporočilo"
set -euo pipefail
: "${GITHUB_TOKEN:?manjka GITHUB_TOKEN}"
: "${GITHUB_REPOSITORY:?manjka GITHUB_REPOSITORY}"
msg="${1:-posodobitev podatkov}"

if [ ! -d data ]; then
  echo "Mapa data/ ne obstaja – ni česa objaviti." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R data "$tmp/data"
find "$tmp/data" -name '*.tmp' -delete

cd "$tmp"
git init -q -b data
git add data
git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -q -m "${msg} ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

# PUBLISH_REMOTE_URL je samo za teste (lokalni goli repozitorij); v Actions se uporabi GitHub.
remote="${PUBLISH_REMOTE_URL:-https://github.com/${GITHUB_REPOSITORY}.git}"
auth="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
echo "::add-mask::${auth}"
git -c http.extraheader="AUTHORIZATION: basic ${auth}" push -q -f "$remote" data
echo "Objavljeno na vejo data: $(find data -type f | wc -l) datotek."
