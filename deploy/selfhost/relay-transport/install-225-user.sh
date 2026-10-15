#!/usr/bin/env bash
# Run as root on 213.165.41.225. Creates ONE SSH account restricted to a
# server3 -> 127.0.0.1:19084 local-forward tunnel. Does not touch Docker,
# Transporter, Nginx, or the existing connector's account and settings.
set -euo pipefail

relay_user=volt220relay
relay_source=45.86.39.77
relay_target=127.0.0.1:19084
relay_home=/var/lib/volt220-relay-ssh-user
operator_dir=/var/lib/volt220-relay-ssh-operator
sshd_config=/etc/ssh/sshd_config

usage() {
  printf 'Usage: sudo %s --public-key-file /root/volt220test-relay.pub --confirm-new-user\n' "$0" >&2
  exit 2
}

[[ $# -eq 3 && $1 == --public-key-file && $3 == --confirm-new-user ]] || usage
public_file=$2
[[ $(id -u) -eq 0 ]] || { printf 'Run as root on 213.165.41.225.\n' >&2; exit 1; }
[[ -r $public_file && -f $public_file && ! -L $public_file ]] || {
  printf 'Public key file must be a readable regular file, not a symlink.\n' >&2
  exit 1
}
[[ -f $sshd_config && ! -L $sshd_config ]] || { printf 'Unexpected sshd_config.\n' >&2; exit 1; }
for command_name in useradd getent ssh-keygen install sshd stat diff systemctl; do
  command -v "$command_name" >/dev/null || { printf 'Missing %s.\n' "$command_name" >&2; exit 1; }
done
getent passwd "$relay_user" >/dev/null && {
  printf 'Dedicated account already exists; inspect it manually instead of overwriting.\n' >&2
  exit 1
}
grep -q '^# BEGIN VOLT220TEST RELAY USER$' "$sshd_config" && {
  printf 'Dedicated sshd Match block already exists; inspect it manually.\n' >&2
  exit 1
}

# Only an Ed25519 public key is accepted. Discard untrusted comments entirely.
[[ $(wc -l <"$public_file") -eq 1 ]] || { printf 'Expected exactly one public key.\n' >&2; exit 1; }
key_type=$(awk '{ print $1 }' "$public_file")
key_blob=$(awk '{ print $2 }' "$public_file")
[[ $key_type == ssh-ed25519 && $key_blob =~ ^[A-Za-z0-9+/=]+$ ]] || {
  printf 'Expected one Ed25519 public key.\n' >&2
  exit 1
}
ssh-keygen -lf "$public_file" -E sha256 >/dev/null || {
  printf 'Invalid public key.\n' >&2
  exit 1
}

sshd_bin=$(command -v sshd)
"$sshd_bin" -t
install -d -m 0700 -o root -g root "$operator_dir"
backup="$operator_dir/sshd_config.before-volt220test-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e $backup ]] || { printf 'Backup path collision; retry later.\n' >&2; exit 1; }
cp -p -- "$sshd_config" "$backup"
"$sshd_bin" -T -C user=root,host=localhost,addr=127.0.0.1 >"$operator_dir/.root-before"

config_modified=0
provision_complete=0
on_exit() {
  status=$?
  if [[ $provision_complete -ne 1 ]]; then
    if [[ $config_modified -eq 1 ]]; then
      cp -p -- "$backup" "$sshd_config" || true
      "$sshd_bin" -t || true
      if [[ -n ${service:-} ]]; then systemctl reload "$service" || true; fi
      printf 'sshd config restored from %s.\n' "$backup" >&2
    fi
    if [[ -n ${auth:-} && -f $auth ]]; then
      chmod 000 "$auth" || true
      printf 'New account key disabled because setup did not complete.\n' >&2
    fi
  fi
  rm -f -- "$operator_dir/.root-before" "$operator_dir/.root-after" "$operator_dir/.relay-effective"
  return "$status"
}
trap on_exit EXIT

service=
if systemctl is-active --quiet ssh; then
  service=ssh
elif systemctl is-active --quiet sshd; then
  service=sshd
else
  printf 'No active systemd SSH service found; no account created.\n' >&2
  exit 1
fi

nologin=$(command -v nologin)
[[ -x $nologin ]] || { printf 'Missing executable nologin shell.\n' >&2; exit 1; }
useradd --system --user-group --home-dir "$relay_home" --shell "$nologin" --no-create-home "$relay_user"
install -d -m 0700 -o "$relay_user" -g "$relay_user" "$relay_home" "$relay_home/.ssh"
auth="$relay_home/.ssh/authorized_keys"
printf 'from="%s",restrict,port-forwarding,permitopen="%s",command="/bin/false" %s %s\n' \
  "$relay_source" "$relay_target" "$key_type" "$key_blob" >"$auth"
chown "$relay_user:$relay_user" "$auth"
chmod 0600 "$auth"
config_modified=1
cat >>"$sshd_config" <<'MATCH_BLOCK'

# BEGIN VOLT220TEST RELAY USER
Match User volt220relay
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PubkeyAuthentication yes
    AuthenticationMethods publickey
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:19084
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    PermitTunnel no
    ForceCommand /bin/false
# END VOLT220TEST RELAY USER
MATCH_BLOCK

if ! "$sshd_bin" -t; then
  exit 1
fi
"$sshd_bin" -T -C user=root,host=localhost,addr=127.0.0.1 >"$operator_dir/.root-after"
if ! diff -q -- "$operator_dir/.root-before" "$operator_dir/.root-after" >/dev/null; then
  printf 'Existing root SSH effective settings changed; refused reload.\n' >&2
  exit 1
fi
"$sshd_bin" -T -C "user=$relay_user,host=213.165.41.225,addr=$relay_source" >"$operator_dir/.relay-effective"
for setting in \
  'passwordauthentication no' \
  'kbdinteractiveauthentication no' \
  'authenticationmethods publickey' \
  'allowtcpforwarding local' \
  'permitopen 127.0.0.1:19084' \
  'gatewayports no' \
  'permittty no' \
  'x11forwarding no' \
  'allowagentforwarding no' \
  'allowstreamlocalforwarding no' \
  'forcecommand /bin/false'; do
  if ! grep -Fxq -- "$setting" "$operator_dir/.relay-effective"; then
    printf 'Missing effective dedicated setting: %s\n' "$setting" >&2
    exit 1
  fi
done

if ! systemctl reload "$service"; then
  exit 1
fi
provision_complete=1
printf 'Dedicated SSH account ready. Existing SSH service settings for root unchanged.\n'
printf 'Backup: %s\n' "$backup"
printf 'Authorized key fingerprint: '
ssh-keygen -lf "$public_file" -E sha256 | awk '{ print $2 }'
