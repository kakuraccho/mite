#!/bin/bash
# Exercise installation and recovery against temporary files, without sudo,
# systemd, network access, or changes to /opt/mite.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'result=$?; if [[ "$result" != 0 && -f "${directory:-}/output" ]]; then cat "$directory/output"; fi; rm -rf -- "$test_root"' EXIT

cat > "$test_root/scenario.sh" <<'BASH'
set -euo pipefail
source "$1"
scenario="$2"
directory="$3"
digest="$4"

# These stand in for the VPS process and HTTP response; filesystem operations,
# checksums, flock, signal handling, and rollback run unchanged.
mite_service_ready() {
  [[ "$scenario" != unhealthy-before ]] || return 1
  if [[ "$scenario" == unhealthy-after ]] && cmp -s "$1" "$directory/new"; then
    return 1
  fi
  if [[ "$scenario" == interrupted ]] && cmp -s "$1" "$directory/new"; then
    kill -TERM "$BASHPID"
    return 1
  fi
  return 0
}
systemctl() {
  [[ "$*" == "restart mite-api.service" ]]
  printf 'restart\n' >> "$directory/restarts"
  if [[ "$scenario" == restart-fails ]] && cmp -s "$directory/mite-api" "$directory/new"; then
    return 1
  fi
}
sleep() { :; }

mite_install "$directory" "$directory/deploy.lock" "$digest" < "$directory/new"
BASH

for scenario in success checksum-mismatch unhealthy-before unhealthy-after restart-fails interrupted locked; do
  directory="$test_root/$scenario"
  mkdir "$directory"
  printf 'old-binary\n' > "$directory/old"
  printf 'new-binary\n' > "$directory/new"
  cp "$directory/old" "$directory/mite-api"
  chmod 755 "$directory/mite-api"
  digest="$(sha256sum "$directory/new")"
  digest="${digest%% *}"
  if [[ "$scenario" == checksum-mismatch ]]; then
    digest="$(sha256sum "$directory/old")"
    digest="${digest%% *}"
  fi
  if [[ "$scenario" == locked ]]; then
    exec 8>"$directory/deploy.lock"
    flock -n 8
  fi

  status=0
  bash "$test_root/scenario.sh" "$script_directory/mite-deploy.sh" "$scenario" "$directory" "$digest" \
    > "$directory/output" 2>&1 || status="$?"
  if [[ "$scenario" == locked ]]; then
    exec 8>&-
  fi

  if [[ "$scenario" == success ]]; then
    [[ "$status" -eq 0 ]]
    cmp "$directory/mite-api" "$directory/new"
    cmp "$directory/mite-api.previous" "$directory/old"
    [[ "$(stat -c %a "$directory/mite-api")" == 755 ]]
    [[ "$(wc -l < "$directory/restarts")" -eq 1 ]]
  else
    [[ "$status" -ne 0 ]]
    cmp "$directory/mite-api" "$directory/old"
    case "$scenario" in
      unhealthy-after|restart-fails|interrupted)
        [[ "$(wc -l < "$directory/restarts")" -eq 2 ]]
        ;;
      *)
        [[ ! -e "$directory/restarts" ]]
        ;;
    esac
  fi
  shopt -s nullglob
  leftovers=("$directory"/.mite-api.*)
  [[ "${#leftovers[@]}" -eq 0 ]]
  printf 'PASS %s\n' "$scenario"
done

# Verify that readiness rejects HTTP errors and processes running another file.
(
  source "$script_directory/mite-deploy.sh"
  # Command substitution has its own BASHPID; use the parent process explicitly.
  probe_pid="$BASHPID"
  systemctl() {
    case "$1" in
      is-active) return 0 ;;
      show) printf '%s\n' "$probe_pid" ;;
    esac
  }
  curl() { printf '%s' "$probe_status"; }
  probe_status=401
  mite_service_ready /bin/bash
  probe_status=500
  if mite_service_ready /bin/bash; then
    exit 1
  fi
  probe_status=401
  if mite_service_ready "$test_root/success/mite-api"; then
    exit 1
  fi
)
printf 'PASS readiness status and process identity\n'
