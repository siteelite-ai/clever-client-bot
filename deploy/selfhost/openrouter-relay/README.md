# Isolated OpenRouter test relay

This is **only** for the independent `chat-volt-next` / `api-volt-next` test stack. It must not replace the existing Transporter, change ports 80/443, modify production Supabase, or be used by the current `chat-volt` widget.

## Design

`server3` Edge Functions → `http://volt220test-relay-client:19084` on Docker network `volt220test_internal` → dedicated SSH local forward → `127.0.0.1:19084` on `213.165.41.225` → fixed HTTPS `openrouter.ai:443`.

The relay has no OpenRouter key, database credential, arbitrary target URL, or writable volume. It only forwards the caller's `Authorization: Bearer …` header to two exact upstream POST paths. The local GET `/api/v1/models/health` checks whether the relay host can reach OpenRouter's public models API and returns only a small status. Browser clients must never reach the relay directly. A separate capped OpenRouter key belongs only in the isolated server3 settings store.

The `.225` Docker project is named `volt220-openrouter-test-relay`, uses its own bridge network, runs read-only as an unprivileged user, and publishes **only** `127.0.0.1:19084`. The server3 tunnel is another Docker project, `volt220-openrouter-test-tunnel`, with no published host ports and only one attachment to the test Docker network. The SSH key and pinned host key must be dedicated to this test route.

## Preflight on 213.165.41.225

Read-only checks first: record `docker ps`, `docker network ls`, `ss -ltnp '( sport = :19084 )'`, and the existing SSHD configuration. Abort if port 19084 is occupied or the proposed project/container names already belong to something else. Copy only this directory to a new root-owned location such as `/opt/volt220-openrouter-test-relay`; do not edit the existing connector's directory or Compose project.

For the dedicated SSH account `volt220relay`, create a unique Ed25519 public key from server3 and place **only its public half** in the account's `authorized_keys`. Its line should include `from="45.86.39.77",restrict,port-forwarding,permitopen="127.0.0.1:19084"`. Keep `authorized_keys` mode 0600 and its `.ssh` directory mode 0700, owned by `volt220relay`. The account must have no password-based login and no sudo privileges. A final `Match User volt220relay` block in SSHD should enforce `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `AllowTcpForwarding local`, `PermitOpen 127.0.0.1:19084`, `PermitListen none`, `GatewayPorts no`, `X11Forwarding no`, `AllowAgentForwarding no`, `PermitTTY no`, and `AllowStreamLocalForwarding no`. Back up the exact SSHD file first, run `sshd -t`, and reload only after successful validation. Do not replace global SSHD settings or disturb existing accounts.

`compose.relay.yml` can then be validated with `docker compose -f compose.relay.yml config` and started as its exact project with `docker compose -f compose.relay.yml -p volt220-openrouter-test-relay up -d --build`. Confirm `docker inspect` shows `HostIp: 127.0.0.1` and no additional published ports. From `.225` only, `curl --noproxy '*' -fsS http://127.0.0.1:19084/api/v1/models/health` should return `{"status":"ok"}`. From a different host the relay's TCP port must not answer. Do not run a live paid model request during infrastructure smoke tests.

## Preflight on server3

Create `/var/lib/volt220-test-relay-ssh` separately from the existing app, owned by root:root and mode 0700. The unique private key and `known_hosts` file should be individually bind-mounted from that root-only directory, owned by UID/GID 10001, and mode 0600. Docker's root daemon resolves the host-side bind mount; the unprivileged container reads only the mounted files. Verify that UID 10001 is not already a host account and confirm file readability inside a one-off container **before** starting SSH. Obtain the `.225` Ed25519 SSH host-key fingerprint from an authenticated operator channel on `.225`; compare it with the fingerprint of the `ssh-keyscan -t ed25519 213.165.41.225` candidate **before** installing the candidate in `known_hosts`. Never use `StrictHostKeyChecking=no` or blindly trust `ssh-keyscan`.

Validate the exact external network name with `docker network inspect volt220test_internal`. `compose.sidecar.yml` intentionally has no `ports:` mapping. Validate with `docker compose -f compose.sidecar.yml config`, start its exact project, and verify the container can read its key files and establish only the allowed local forward. The application-side route is `http://volt220test-relay-client:19084` on that network. Do not connect the tunnel container to production Docker networks.

## Scope and negative tests

The relay accepts only `POST /api/v1/chat/completions`, `POST /api/v1/embeddings`, and `GET /api/v1/models/health`. Other methods, paths, query strings, absolute URLs, hostile `Host` headers, missing bearer credentials, non-JSON or compressed requests are rejected before any upstream request. JSON bodies are capped at 2 MiB; streamed responses at 32 MiB; at most four POST requests are active within the 256 MiB container cap. Body receipt, upstream idle time, and total upstream time are bounded. SSE is relayed with backpressure, without buffering the full answer. Request/response bodies and credentials are not logged.

Run the no-network mock tests before deployment:

```sh
node --test deploy/selfhost/openrouter-relay/server.test.mjs
```

After deployment, test the health route plus one narrowly scoped model request from the isolated Edge Function with a dedicated capped test key. Confirm the old `chat-volt` and old connector still answer as before. Keep the new public cabinet/API 503 gates in place until that end-to-end test and the separate administrator login pass.

Rollback touches only these new projects: stop the exact `volt220-openrouter-test-tunnel` and `volt220-openrouter-test-relay` Compose projects, leave their files for diagnosis, and keep new-site 503 gates. Do **not** roll back or restart existing Transporter, Nginx, MODX, or the production Supabase.
