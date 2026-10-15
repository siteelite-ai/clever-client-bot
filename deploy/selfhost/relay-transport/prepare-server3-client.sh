#!/usr/bin/env bash
# Run on server3 only. Prepare a dedicated, pinned SSH identity for the
# test-only OpenRouter tunnel. Never print or transmit the private key.
set -euo pipefail

relay_host=213.165.41.225
relay_port=22
relay_uid=10001
relay_dir=/var/lib/volt220-test-relay-ssh

usage() {
  printf 'Usage: sudo %s --expected-hostkey SHA256:<trusted fingerprint>\n' "$0" >&2
  exit 2
}

[[ $# -eq 2 && $1 == --expected-hostkey ]] || usage
expected=$2
[[ $expected =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || usage
[[ $(id -u) -eq 0 ]] || { printf 'Run as root on server3.\n' >&2; exit 1; }

for command_name in getent ssh-keygen ssh-keyscan install stat awk mktemp; do
  command -v "$command_name" >/dev/null || { printf 'Missing %s.\n' "$command_name" >&2; exit 1; }
done

# File ownership must not map to an existing interactive host user.
if getent passwd "$relay_uid" >/dev/null; then
  printf 'Host UID %s is occupied; choose a different isolated container UID before proceeding.\n' "$relay_uid" >&2
  exit 1
fi

if [[ -e $relay_dir || -L $relay_dir ]]; then
  [[ -d $relay_dir && ! -L $relay_dir ]] || { printf 'Unsafe relay directory.\n' >&2; exit 1; }
  [[ $(stat -c '%u:%g:%a' "$relay_dir") == 0:0:700 ]] || {
    printf 'Relay directory must be root:root mode 0700.\n' >&2
    exit 1
  }
else
  install -d -m 0700 -o root -g root "$relay_dir"
fi

scan=$(mktemp "$relay_dir/.hostkey.XXXXXX")
trap 'rm -f -- "$scan"' EXIT
ssh-keyscan -T 8 -p "$relay_port" -t ed25519 "$relay_host" 2>/dev/null >"$scan" || {
  printf 'SSH host-key scan failed. No key was created.\n' >&2
  exit 1
}
awk -v host="$relay_host" '
  NF == 3 && $1 == host && $2 == "ssh-ed25519" { count++; next }
  { bad = 1 }
  END { exit (bad || count != 1) }
' "$scan" || { printf 'Expected exactly one Ed25519 host key.\n' >&2; exit 1; }
actual=$(ssh-keygen -lf "$scan" -E sha256 | awk 'NR == 1 { print $2 }')
[[ $actual == "$expected" ]] || {
  printf 'SSH host-key fingerprint differs from the trusted out-of-band value.\n' >&2
  exit 1
}

key=$relay_dir/id_ed25519
public=$relay_dir/id_ed25519.pub
known=$relay_dir/known_hosts
if [[ -e $key || -e $public || -e $known || -L $key || -L $public || -L $known ]]; then
  [[ -f $key && ! -L $key && -f $public && ! -L $public && -f $known && ! -L $known ]] || {
    printf 'Incomplete or unsafe existing relay identity; inspect manually, do not overwrite.\n' >&2
    exit 1
  }
  [[ $(stat -c '%u:%g:%a' "$key") == "$relay_uid:$relay_uid:600" ]] || {
    printf 'Unexpected relay private-key ownership or permissions.\n' >&2
    exit 1
  }
  [[ $(stat -c '%u:%g:%a' "$known") == "$relay_uid:$relay_uid:600" ]] || {
    printf 'Unexpected known_hosts ownership or permissions.\n' >&2
    exit 1
  }
  cmp -s -- "$scan" "$known" || {
    printf 'Existing known_hosts differs from pinned host key; do not replace automatically.\n' >&2
    exit 1
  }
  ssh-keygen -y -f "$key" | awk '{ print $1, $2 }' >"$relay_dir/.public-verify"
  trap 'rm -f -- "$scan" "$relay_dir/.public-verify"' EXIT
  awk '{ print $1, $2 }' "$public" | cmp -s -- - "$relay_dir/.public-verify" || {
    printf 'Existing relay public/private key pair does not match.\n' >&2
    exit 1
  }
else
  ssh-keygen -q -t ed25519 -N '' -C volt220test-relay-client -f "$key"
  install -m 0600 -o "$relay_uid" -g "$relay_uid" "$scan" "$known"
  chown "$relay_uid:$relay_uid" "$key"
  chmod 0600 "$key"
  chmod 0644 "$public"
fi

printf 'Pinned host key: %s\n' "$actual"
printf 'Dedicated public key (safe to copy to 213.165.41.225):\n'
cat "$public"
printf 'Private key remains only in %s (not printed).\n' "$relay_dir"
