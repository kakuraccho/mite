#!/bin/bash
# Install as root-owned /usr/local/sbin/mite-deploy on the existing VPS.
# Usage: sudo -n /usr/local/sbin/mite-deploy <sha256> < mite-api

mite_service_ready() {
  local binary="$1" pid status
  systemctl is-active --quiet mite-api.service || return 1
  pid="$(systemctl show --property MainPID --value mite-api.service)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && "/proc/$pid/exe" -ef "$binary" ]] || return 1
  status="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 3 http://127.0.0.1:3000/v1/support-requests)" || return 1
  # No demo token is needed: the existing authentication middleware returns 401.
  [[ "$status" == 401 ]]
}

mite_wait_ready() {
  local binary="$1" attempt successes=0
  for ((attempt = 0; attempt < 30; attempt++)); do
    if mite_service_ready "$binary"; then
      successes=$((successes + 1))
      [[ "$successes" -ge 3 ]] && return 0
    else
      successes=0
    fi
    sleep 1
  done
  return 1
}

# Run in a subshell so the cleanup trap also covers failures and SSH disconnects.
# The CLI below fixes the destination; path arguments exist for isolated tests.
mite_install() (
  set -euo pipefail
  # Subshell variables must outlive function unwinding when EXIT runs.
  directory="$1" lock="$2" digest="$3"
  binary="$directory/mite-api" incoming="" backup="" switched=false

  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    printf 'Expected one lowercase SHA-256 digest.\n' >&2
    exit 1
  }
  exec 9>"$lock"
  flock -n 9 || {
    printf 'Another Mite deployment is running.\n' >&2
    exit 1
  }
  [[ -f "$binary" && ! -L "$binary" && -x "$binary" ]] || {
    printf 'The existing Mite binary must be a regular executable file.\n' >&2
    exit 1
  }
  mite_service_ready "$binary" || {
    printf 'The existing service is not healthy; deployment was not started.\n' >&2
    exit 1
  }

  cleanup() {
    local status="$?"
    trap - EXIT
    trap '' HUP INT TERM
    if [[ "$switched" == true ]]; then
      printf 'Deployment failed; restoring the previous binary.\n' >&2
      if mv -fT -- "$backup" "$binary"; then
        backup=""
        if systemctl restart mite-api.service && mite_wait_ready "$binary"; then
          printf 'Previous binary restored and running.\n' >&2
        else
          printf 'Rollback startup failed; inspect mite-api.service on the VPS.\n' >&2
        fi
      else
        printf 'Rollback failed; the recovery binary is at %s.\n' "$backup" >&2
        # Preserve the recovery copy when it could not be restored.
        backup=""
      fi
      status=1
    fi
    [[ -z "$incoming" ]] || rm -f -- "$incoming"
    [[ -z "$backup" ]] || rm -f -- "$backup"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  umask 077
  incoming="$(mktemp "$directory/.mite-api.incoming.XXXXXXXX")"
  cat > "$incoming"
  if ! printf '%s  %s\n' "$digest" "$incoming" | sha256sum --check --status; then
    printf 'Binary checksum mismatch; the running service was not changed.\n' >&2
    exit 1
  fi
  chmod --reference="$binary" "$incoming"
  chown --reference="$binary" "$incoming"
  backup="$(mktemp "$directory/.mite-api.backup.XXXXXXXX")"
  cp --preserve=mode,ownership,timestamps -- "$binary" "$backup"

  # rename on the same filesystem never truncates the running executable.
  switched=true
  mv -fT -- "$incoming" "$binary"
  systemctl restart mite-api.service
  mite_wait_ready "$binary"
  # Keep the temporary recovery path valid until rollback is disarmed.
  ln -fT -- "$backup" "$directory/mite-api.previous"
  switched=false
  printf 'Mite deployed successfully (SHA-256: %s).\n' "$digest"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  # Ignore the caller's PATH when running through sudo.
  export PATH=/usr/sbin:/usr/bin:/sbin:/bin
  if [[ "$EUID" -ne 0 || "$#" -ne 1 ]]; then
    printf 'Usage: sudo -n /usr/local/sbin/mite-deploy <sha256> < mite-api\n' >&2
    exit 1
  fi
  mite_install /opt/mite /run/lock/mite-api-deploy.lock "$1"
fi
