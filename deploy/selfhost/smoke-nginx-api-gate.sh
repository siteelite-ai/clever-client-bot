#!/usr/bin/env bash
set -euo pipefail

# Run only on server3 after the new-domain allowlist has been installed.
# The EXIT trap restores the site-specific 503 even if a probe fails.
gate=/etc/nginx/vhosts-resources/api-volt-next.testdevops.ru/00-maintenance.conf
paused=/var/lib/volt220-test-supabase/operator/00-api-maintenance-paused-20261015.conf
sudo test -f "$gate"
sudo test ! -e "$paused"

restore_gate() {
  if sudo test -f "$paused"; then
    sudo mv "$paused" "$gate"
    sudo nginx -t >/dev/null 2>&1
    sudo systemctl reload nginx
  fi
}
trap restore_gate EXIT

sudo mv "$gate" "$paused"
sudo nginx -t >/dev/null 2>&1
sudo systemctl reload nginx
sleep 2

for path in / /studio /meta /roundcube /phpmyadmin /functions/v1/hello /functions/v1/unknown; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "https://api-volt-next.testdevops.ru$path")
  printf '%s %s\n' "$path" "$status"
  test "$status" = 404
done

public_key=$(sudo awk -F= '$1 == "SUPABASE_PUBLISHABLE_KEY" { print $2 }' \
  /var/lib/volt220-test-supabase/upstream/docker/.env)
test "${public_key#sb_publishable_}" != "$public_key"
status=$(curl -sS -o /dev/null -w '%{http_code}' -H "apikey: $public_key" \
  https://api-volt-next.testdevops.ru/auth/v1/health)
printf 'auth-health %s\n' "$status"
test "$status" = 200
