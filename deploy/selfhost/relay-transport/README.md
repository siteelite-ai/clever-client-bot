# Isolated server3 → 213.165.41.225 SSH transport

This is **only** for the new `volt220test` stack. It does not reuse the working
connector's user, key, Docker project, configuration, database, or proxy port.
The OpenRouter relay on `213.165.41.225` must already be bound **only** to
`127.0.0.1:19084`; the SSH connection forwards the test container's port 19084
to that loopback address. No port is published on server3.

## Preconditions (read-only)

1. Check that the existing, trusted administrator SSH connection to
   `213.165.41.225` uses a pinned host key. Over **that trusted connection**,
   read the server's Ed25519 host-key fingerprint using
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`. Do not derive
   the expected fingerprint from `ssh-keyscan` alone. A changed host key needs
   independent administrator confirmation.
2. On server3, check that host UID `10001` is free (`getent passwd 10001` must
   return no account) and that `volt220test_internal` exists. On `.225`, check
   that `volt220relay` does not exist and SSH runs under systemd (`ssh` or
   `sshd`). Check the exact source address observed by `.225` is
   `45.86.39.77`; the new key will refuse any other source.
3. Keep `chat-volt-next` and `api-volt-next` gated until the separate keys,
   isolated admin, and a real model-backed smoke pass. The old cabinet,
   production bot, and working connector stay untouched.

## Prepare server3 identity

Run `prepare-server3-client.sh --expected-hostkey SHA256:...` as root on
server3, using the independently trusted fingerprint. The script creates
`/var/lib/volt220-test-relay-ssh` as `root:root 0700`. It generates a fresh
Ed25519 private key owned by UID 10001 (`0600`) and a pinned `known_hosts`
file (also UID 10001, `0600`). Docker bind-mounts the two files individually;
the host parent remains root-only. The script prints only the **public** key
and its host-key fingerprint. Never copy, log, or paste the private key.

The script refuses an occupied host UID, symlinks, partial identity, changed
host key, or changed file permissions. It never rotates an existing identity
automatically. Transfer only `id_ed25519.pub` to `.225` using the already
trusted administrator SSH route, then verify its fingerprint there. Do not
place the private key on `.225` or in the Git repository.

## Create the .225-only SSH account

On `.225`, run `install-225-user.sh --public-key-file <transferred public key>
--confirm-new-user` as root. It refuses to overwrite an existing user or
Match block. It creates a separate `volt220relay` account with `nologin` and
one `authorized_keys` entry restricted to source `45.86.39.77`, local
forwarding to `127.0.0.1:19084`, no PTY, and a forced false command. It
backs up `/etc/ssh/sshd_config` under
`/var/lib/volt220-relay-ssh-operator/`, appends a `Match User volt220relay`
block at the file's end, runs `sshd -t`, compares the existing root user's
effective SSH policy before/after, verifies the relay account's effective
policy (`AllowTcpForwarding local`, `PermitOpen` one endpoint, no passwords),
then reloads SSH. On setup failure it restores the exact config backup and
disables the new key. It does not edit the current connector's files or
Docker Compose.

After installation, keep an established administrator SSH session open until
a **second** independent administrator login succeeds. Test the dedicated
account with `ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes` from the
server3 sidecar, not with a shell session (shell access is deliberately
denied).

## Start and verify the sidecar

Use the separate `deploy/selfhost/openrouter-relay/compose.sidecar.yml` as its
own Docker Compose project. Review `docker compose config` before `up -d`;
there must be one service on external `volt220test_internal`, no `ports`, no
privileged mode, and only the two read-only SSH file mounts. The sidecar
runs UID 10001, read-only filesystem, dropped capabilities, strict pinned
host-key checking, batch mode, `ExitOnForwardFailure`, and an SSH keepalive.
No global `HTTP_PROXY` or `HTTPS_PROXY` is set for the other functions.

Run `verify-server3-tunnel.sh` as root on server3 after starting the sidecar.
It checks the live container and mount/network boundaries without exposing a
secret or making a paid request. It is **not** a model-success check. After
dedicated OpenRouter and catalog keys are installed only in the test database,
perform one bounded model-backed request and check the request ID and logs.

If the SSH connection fails or the relay stops, the tunnel has no fallback to
another proxy or production. The container may restart, but requests fail
until this isolated path is restored.

## Rollback

1. `docker compose -f <exact sidecar compose path> down` stops only the
   separate `volt220-openrouter-test-tunnel` project. The external
   `volt220test_internal` network and the existing connector are preserved.
2. On `.225`, `chmod 000 /var/lib/volt220-relay-ssh-user/.ssh/authorized_keys`
   immediately revokes only the new relay key. Keep the key disabled until a
   new restricted transport is intentionally installed.
3. If removing the new SSH Match block is necessary, restore the **exact**
   `sshd_config.before-volt220test-*` backup printed by the installer; first
   compare it with the current file, then run `sshd -t` and compare effective
   SSH settings for existing users before reloading the same `ssh`/`sshd`
   service. Never replace `/etc/ssh/sshd_config` with a guessed template.
4. On server3, leave the test-only key directory in place for forensics, or
   remove it in a separate approved cleanup after the sidecar is stopped.
   No production keys, DNS records, or old site settings are part of this
   rollback.
