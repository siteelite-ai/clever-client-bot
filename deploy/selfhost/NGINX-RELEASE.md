# New-domain Nginx boundary on server3

This is for `chat-volt-next.testdevops.ru` and
`api-volt-next.testdevops.ru` only. ISPmanager generates their vhosts and
includes both site-specific resources and global `vhosts-includes/*.conf`.
The global includes contain webmail/admin locations. Merely deleting the
site-specific 503 gate would expose those locations under the new names.
Never edit the generated vhost, global include, old cabinet, MODX site, or
production Supabase for this release.

The tracked files are installed as:

| Source | server3 destination |
| --- | --- |
| `nginx-api-allowlist.conf` | `/etc/nginx/vhosts-resources/api-volt-next.testdevops.ru/05-api-allowlist.conf` |
| `nginx-cabinet-allowlist.conf` | `/etc/nginx/vhosts-resources/chat-volt-next.testdevops.ru/05-cabinet-allowlist.conf` |
| `nginx-api-proxy.conf` | `/etc/nginx/vhosts-resources/api-volt-next.testdevops.ru/10-api-proxy.conf` |

Keep each site's `00-maintenance.conf` in place during installation. Make a
root-only copy of the API proxy and both gate files **outside** included
`*.conf` paths before replacing anything. Check `nginx -t`, reload, and
verify both new domains still return 503. The API proxy must bind only to
`127.0.0.1:18081`, and its function routes must stay exact. Once the new
frontend, isolated DB migration, four functions, test admin and secrets have
passed review, verify allowed and denied paths with the 503 gates lifted one
at a time. Keep the old cabinet and widget untouched.

Minimum negative probes after lifting the API gate: `/`, `/studio`, `/meta`,
`/roundcube`, the inherited PHPMyAdmin path, `/functions/v1/hello`, and an
unknown `/functions/v1/*` must return 404. For the cabinet, `/roundcube`,
the inherited admin path and unknown SPA/static paths must return 404. Check
the actual Auth/REST responses, preflight CORS, exact four function routes,
login, and TLS; do not infer success from an HTTP 200 on the SPA shell.

Rollback is site-specific: restore only the corresponding saved
`00-maintenance.conf`, run `nginx -t`, reload, and verify HTTP 503. Restore
the saved API proxy if its new route causes an issue. Do not remove any
database volume or roll back the old production service. The 503 gate is an
availability rollback, not a data restore; take a separate isolated DB
backup before public login and arrange off-host encrypted backups before
real customer data.

As of 2026-10-15, OpenRouter denies even a free anonymous public GET from
server3. Do **not** call the new bot production-ready or remove its 503 gate
as a complete release until model access is verified. The owner may choose
a clearly labelled admin-only preview without AI while this is unresolved.
