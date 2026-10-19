#!/usr/bin/env bash
set -euo pipefail

# Probe only the new cabinet, and always restore its site-specific 503.
gate=/etc/nginx/vhosts-resources/chat-volt-next.testdevops.ru/00-maintenance.conf
paused=/var/lib/volt220-test-supabase/operator/00-chat-maintenance-paused-20261015.conf
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

for path in / /login /settings /widget /widget-version.json /embed.js; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "https://chat-volt-next.testdevops.ru$path")
  printf '%s %s\n' "$path" "$status"
  test "$status" = 200
done

for path in /roundcube /phpmyadmin /not-a-route /not-a-file.js; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "https://chat-volt-next.testdevops.ru$path")
  printf '%s %s\n' "$path" "$status"
  test "$status" = 404
done
