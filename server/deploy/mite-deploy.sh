#!/bin/bash
# Install as root-owned /usr/local/sbin/mite-deploy on the existing VPS.
# Usage: sudo -n /usr/local/sbin/mite-deploy <sha256> <prompt-version> < mite-api

mite_check_environment_file() {
  local directory="$1" files
  files="$(systemctl show --property EnvironmentFiles --value mite-api.service)" || return 1
  # Require the managed file last, so another EnvironmentFile cannot override it.
  [[ "$files" == *"$directory/mite-api.env (ignore_errors=yes)" ]] || {
    printf 'Install server/deploy/50-mite-deploy.conf and run systemctl daemon-reload before deploying.\n' >&2
    return 1
  }
  [[ ! -L "$directory/mite-api.env" && (! -e "$directory/mite-api.env" || -f "$directory/mite-api.env") ]] || {
    printf 'The deployment environment must be a regular file, or absent.\n' >&2
    return 1
  }
}

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
  directory="$1" lock="$2" digest="$3" prompt_version="$4"
  binary="$directory/mite-api" incoming="" backup="" switched=false
  environment_file="$directory/mite-api.env" environment_incoming="" environment_backup=""
  environment_switched=false

  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    printf 'Expected one lowercase SHA-256 digest.\n' >&2
    exit 1
  }
  [[ "$prompt_version" =~ ^v[1-9][0-9]*$ ]] || {
    printf 'Expected a prompt version such as v2.\n' >&2
    exit 1
  }
  exec 9>"$lock"
  flock -n 9 || {
    printf 'Another Mite deployment is running.\n' >&2
    exit 1
  }
  mite_check_environment_file "$directory"
  [[ -f "$binary" && ! -L "$binary" && -x "$binary" ]] || {
    printf 'The existing Mite binary must be a regular executable file.\n' >&2
    exit 1
  }
  mite_service_ready "$binary" || {
    printf 'The existing service is not healthy; deployment was not started.\n' >&2
    exit 1
  }

  cleanup() {
    local status="$?" restored=true
    trap - EXIT
    trap '' HUP INT TERM
    if [[ "$switched" == true ]]; then
      printf 'Deployment failed; restoring the previous binary and environment.\n' >&2
      if mv -fT -- "$backup" "$binary"; then
        backup=""
      else
        printf 'Rollback failed; the recovery binary is at %s.\n' "$backup" >&2
        # Preserve the recovery copy when it could not be restored.
        backup=""
        restored=false
      fi
      if [[ "$environment_switched" == true ]]; then
        if [[ -n "$environment_backup" ]]; then
          if ! mv -fT -- "$environment_backup" "$environment_file"; then
            printf 'Environment rollback failed; the recovery file is at %s.\n' "$environment_backup" >&2
            restored=false
          fi
          environment_backup=""
        elif ! rm -f -- "$environment_file"; then
          printf 'Could not remove the new deployment environment.\n' >&2
          restored=false
        fi
      fi
      if [[ "$restored" == true ]] && systemctl restart mite-api.service && mite_wait_ready "$binary"; then
        printf 'Previous binary and environment restored and running.\n' >&2
      else
        printf 'Rollback startup failed; inspect mite-api.service on the VPS.\n' >&2
      fi
      status=1
    fi
    [[ -z "$incoming" ]] || rm -f -- "$incoming"
    [[ -z "$backup" ]] || rm -f -- "$backup"
    [[ -z "$environment_incoming" ]] || rm -f -- "$environment_incoming"
    [[ -z "$environment_backup" ]] || rm -f -- "$environment_backup"
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
  environment_incoming="$(mktemp "$directory/.mite-api.env.incoming.XXXXXXXX")"
  printf 'AI_PROMPT_VERSION=%s\n' "$prompt_version" > "$environment_incoming"
  # This file contains only the non-secret release setting; systemd reads it as root.
  if [[ -f "$environment_file" ]]; then
    environment_backup="$(mktemp "$directory/.mite-api.env.backup.XXXXXXXX")"
    cp --preserve=mode,ownership,timestamps -- "$environment_file" "$environment_backup"
  fi

  # rename on the same filesystem never truncates the running executable.
  switched=true
  mv -fT -- "$incoming" "$binary"
  environment_switched=true
  mv -fT -- "$environment_incoming" "$environment_file"
  systemctl restart mite-api.service
  mite_wait_ready "$binary"
  # Keep the temporary recovery path valid until rollback is disarmed.
  ln -fT -- "$backup" "$directory/mite-api.previous"
  switched=false
  printf 'Mite deployed successfully (SHA-256: %s, AI_PROMPT_VERSION: %s).\n' "$digest" "$prompt_version"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  # Ignore the caller's PATH when running through sudo.
  export PATH=/usr/sbin:/usr/bin:/sbin:/bin
  if [[ "$EUID" -eq 0 && "$#" -eq 1 && "$1" == --check ]]; then
    mite_check_environment_file /opt/mite
    mite_service_ready /opt/mite/mite-api
    exit
  fi
  if [[ "$EUID" -ne 0 || "$#" -ne 2 ]]; then
    printf 'Usage: sudo -n /usr/local/sbin/mite-deploy <sha256> <prompt-version> < mite-api\n' >&2
    exit 1
  fi
  mite_install /opt/mite /run/lock/mite-api-deploy.lock "$1" "$2"
fi
