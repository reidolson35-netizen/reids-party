#!/bin/bash
# Smoke-test a deployed Apps Script backend, end to end.
# Usage: ./verify_endpoint.sh https://script.google.com/macros/s/XXXX/exec
#
# Sends: health check, one TEST application (with a tiny ID image), then
# reads it back via the admin list API. The test row lands in the real
# Sheet as "TEST - DELETE ME" (and triggers the notify email) - delete the
# row + the test files in "Reid's Party Uploads" afterwards, or just leave
# it REJECTED.
set -euo pipefail
URL="${1:?usage: $0 <apps-script-/exec-url>}"
TOKEN="$(cat "$(dirname "$0")/token.txt")"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

# Apps Script web apps answer through a 302 to googleusercontent - always -L.
echo "== 1/3 health check =="
curl -sL "$URL"; echo

echo "== 2/3 test submission =="
curl -sL "$URL" -d "{
  \"hp\":\"\",\"ua\":\"verify_endpoint.sh\",\"ts\":\"$(date -u +%FT%TZ)\",
  \"answers\":{
    \"email\":\"test@example.com\",\"name\":\"TEST - DELETE ME\",
    \"socials\":\"example.com\",\"age\":\"99\",
    \"why\":\"smoke test row, safe to delete\",
    \"working\":\"smoke test\",\"contrarian\":\"smoke test\",
    \"phone\":\"0000000000\"},
  \"images\":[],
  \"id_images\":[{\"name\":\"id.png\",\"type\":\"image/png\",\"data\":\"$PNG\"}]
}"; echo

echo "== 3/3 admin list =="
curl -sL "$URL?action=list&token=$TOKEN" | head -c 600; echo
echo
echo "If all three returned ok:true JSON, the pipeline is live."
