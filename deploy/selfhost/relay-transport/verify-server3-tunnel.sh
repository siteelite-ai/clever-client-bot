#!/usr/bin/env bash
# Read-only post-start checks. No API key and no paid OpenRouter request.
set -euo pipefail

container=volt220test-relay-client
network=volt220test_internal
relay_dir=/var/lib/volt220-test-relay-ssh

[[ $(id -u) -eq 0 ]] || { printf 'Run as root on server3.\n' >&2; exit 1; }
command -v docker >/dev/null || { printf 'Docker is unavailable.\n' >&2; exit 1; }
command -v stat >/dev/null || { printf 'stat is unavailable.\n' >&2; exit 1; }

[[ $(stat -c '%u:%g:%a' "$relay_dir") == 0:0:700 ]] || {
  printf 'Relay secret directory is not root:root 0700.\n' >&2
  exit 1
}
for file in id_ed25519 known_hosts; do
  [[ -f $relay_dir/$file && ! -L $relay_dir/$file ]] || {
    printf 'Missing or unsafe %s.\n' "$file" >&2
    exit 1
  }
  [[ $(stat -c '%u:%g:%a' "$relay_dir/$file") == 10001:10001:600 ]] || {
    printf 'Unexpected owner or mode on %s.\n' "$file" >&2
    exit 1
  }
done

[[ $(docker inspect -f '{{.State.Running}}' "$container") == true ]] || {
  printf 'Dedicated tunnel container is not running.\n' >&2
  exit 1
}
[[ $(docker inspect -f '{{.Config.User}}' "$container") == 10001:10001 ]] || {
  printf 'Dedicated tunnel does not run as its isolated UID.\n' >&2
  exit 1
}
[[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container") == true ]] || {
  printf 'Dedicated tunnel filesystem is writable.\n' >&2
  exit 1
}
bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$container")
[[ $bindings == '{}' || $bindings == null ]] || {
  printf 'Dedicated tunnel unexpectedly publishes a host port.\n' >&2
  exit 1
}
networks=$(docker inspect -f '{{range $name, $details := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container")
[[ $networks == "$network" ]] || {
  printf 'Dedicated tunnel attached to an unexpected Docker network.\n' >&2
  exit 1
}
[[ $(docker inspect -f '{{json .HostConfig.CapDrop}}' "$container") == '["ALL"]' ]] || {
  printf 'Dedicated tunnel capabilities were not dropped.\n' >&2
  exit 1
}
[[ $(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$container") == *no-new-privileges:true* ]] || {
  printf 'Dedicated tunnel lacks no-new-privileges.\n' >&2
  exit 1
}
docker exec --user 10001:10001 "$container" /bin/sh -c \
  'test -r /home/tunnel/.ssh/id_ed25519 && test -r /home/tunnel/.ssh/known_hosts' || {
    printf 'Container UID cannot read its pinned SSH identity.\n' >&2
    exit 1
  }

printf 'PASS: isolated tunnel container, private key, host key pin, and Docker network boundaries.\n'
printf 'This does not prove that the OpenRouter model responds; run one bounded model-backed smoke after dedicated keys are installed.\n'
