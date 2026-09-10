#!/bin/bash
# Install as root-owned /usr/local/bin/mite-pwa-deploy on the existing VPS.
# Run it as the unprivileged VPS deployment user. That user owns only the
# family PWA release directory, while Apache reads the selected release.

mite_pwa_directory=/var/www/mite-family-pwa
mite_pwa_public_url=https://priv.chi-llenge.com/mite/family-pwa/
mite_pwa_api_probe=https://priv.chi-llenge.com/mite/v1/support-requests
mite_pwa_origin=https://priv.chi-llenge.com

mite_pwa_check_self() {
  local expected="$1" script actual
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  script="$(readlink -f -- "${BASH_SOURCE[0]}")" || return 1
  actual="$(sha256sum -- "$script")" || return 1
  [[ "${actual%% *}" == "$expected" ]]
}

mite_pwa_release_target() {
  local directory="$1" link="$2" target
  [[ -L "$directory/$link" ]] || return 1
  target="$(readlink -- "$directory/$link")" || return 1
  [[ "$target" =~ ^releases/[0-9a-f]{40}$ ]] || return 1
  [[ -d "$directory/$target" && ! -L "$directory/$target" ]] || return 1
  printf '%s\n' "$target"
}

mite_pwa_validate_tree() {
  local root="$1" unexpected oversized
  [[ -f "$root/index.html" && ! -L "$root/index.html" ]] || return 1
  [[ -f "$root/manifest.webmanifest" && ! -L "$root/manifest.webmanifest" ]] || return 1
  [[ -f "$root/sw.js" && ! -L "$root/sw.js" ]] || return 1
  [[ -f "$root/icon.svg" && ! -L "$root/icon.svg" ]] || return 1
  [[ -d "$root/assets" && ! -L "$root/assets" ]] || return 1
  unexpected="$(find "$root" -mindepth 1 ! -type f ! -type d -print -quit)"
  [[ -z "$unexpected" ]] || return 1
  oversized="$(find "$root" -type f -size +10M -print -quit)"
  [[ -z "$oversized" ]] || return 1
  grep -Fq '/mite/family-pwa/assets/' "$root/index.html" || return 1
  grep -Fq '"start_url": "./"' "$root/manifest.webmanifest" || return 1
  grep -Fq '"scope": "./"' "$root/manifest.webmanifest" || return 1
  grep -Fq 'self.registration.scope' "$root/sw.js" || return 1
}

mite_pwa_check_directory() {
  local directory="$1" target
  [[ -d "$directory" && ! -L "$directory" && -w "$directory" ]] || return 1
  [[ -d "$directory/releases" && ! -L "$directory/releases" && -w "$directory/releases" ]] || return 1
  if [[ -e "$directory/current" || -L "$directory/current" ]]; then
    target="$(mite_pwa_release_target "$directory" current)" || return 1
    mite_pwa_validate_tree "$directory/$target" || return 1
  fi
  if [[ -e "$directory/previous" || -L "$directory/previous" ]]; then
    mite_pwa_release_target "$directory" previous >/dev/null || return 1
  fi
}

mite_pwa_api_ready() {
  local status
  status="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
    --header "Origin: $mite_pwa_origin" --connect-timeout 5 --max-time 10 \
    "$mite_pwa_api_probe")" || return 1
  [[ "$status" == 401 ]]
}

mite_pwa_ready() {
  local directory="$1" public_url="$2" target root
  target="$(mite_pwa_release_target "$directory" current)" || return 1
  root="$directory/$target"
  mite_pwa_validate_tree "$root" || return 1
  curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    "$public_url" | cmp -s - "$root/index.html" || return 1
  curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    "${public_url}manifest.webmanifest" | cmp -s - "$root/manifest.webmanifest" || return 1
  curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    "${public_url}sw.js" | cmp -s - "$root/sw.js"
}

mite_pwa_wait_ready() {
  local directory="$1" public_url="$2" attempt
  for ((attempt = 0; attempt < 30; attempt++)); do
    mite_pwa_ready "$directory" "$public_url" && return 0
    sleep 1
  done
  return 1
}

mite_pwa_switch_link() {
  local directory="$1" link="$2" target="$3" temporary
  temporary="$directory/.$link.$BASHPID"
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  mv -fT -- "$temporary" "$directory/$link"
}

mite_pwa_install() (
  set -euo pipefail
  local directory="$1" lock="$2" public_url="$3" expected_digest="$4" release="$5"
  local archive incoming release_directory actual_digest member old_target=""
  local switched=false installed=false

  [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || {
    printf 'Expected one lowercase SHA-256 digest.\n' >&2
    exit 1
  }
  [[ "$release" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'Expected a 40-character lowercase release commit.\n' >&2
    exit 1
  }
  mite_pwa_check_directory "$directory" || {
    printf 'The family PWA deployment directory is not ready.\n' >&2
    exit 1
  }
  exec 9>"$lock"
  flock -n 9 || {
    printf 'Another family PWA deployment is running.\n' >&2
    exit 1
  }

  archive="$(mktemp "$directory/.mite-family-pwa.archive.XXXXXXXX")"
  incoming="$(mktemp -d "$directory/releases/.incoming.XXXXXXXX")"
  release_directory="$directory/releases/$release"

  cleanup() {
    local status="$?" restored=true
    trap - EXIT
    trap '' HUP INT TERM
    if [[ "$status" -ne 0 && "$switched" == true ]]; then
      printf 'Family PWA deployment failed; restoring the previous release.\n' >&2
      if [[ -n "$old_target" ]]; then
        mite_pwa_switch_link "$directory" current "$old_target" || restored=false
        if [[ "$restored" == true ]]; then
          mite_pwa_wait_ready "$directory" "$public_url" || restored=false
        fi
      else
        rm -f -- "$directory/current" || restored=false
      fi
      if [[ "$restored" != true ]]; then
        printf 'Family PWA rollback failed; inspect the current symlink and Apache.\n' >&2
      fi
    fi
    rm -f -- "$archive" "$directory/.current.$BASHPID" "$directory/.previous.$BASHPID"
    [[ -z "$incoming" ]] || rm -rf -- "$incoming"
    if [[ "$status" -ne 0 && "$installed" == true ]]; then
      rm -rf -- "$release_directory"
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  head -c 26214401 > "$archive"
  [[ "$(stat -c %s "$archive")" -le 26214400 ]] || {
    printf 'Family PWA archive exceeds 25 MiB.\n' >&2
    exit 1
  }
  actual_digest="$(sha256sum -- "$archive")"
  [[ "${actual_digest%% *}" == "$expected_digest" ]] || {
    printf 'Family PWA archive checksum mismatch.\n' >&2
    exit 1
  }
  tar -tzf "$archive" >/dev/null
  while IFS= read -r member; do
    [[ -n "$member" && "$member" != /* && "/$member/" != *'/../'* && "$member" != *'\\'* ]] || {
      printf 'Family PWA archive contains an unsafe path.\n' >&2
      exit 1
    }
  done < <(tar -tzf "$archive")
  tar -xzf "$archive" --directory "$incoming" --no-same-owner --no-same-permissions
  mite_pwa_validate_tree "$incoming" || {
    printf 'Family PWA archive does not contain a valid build.\n' >&2
    exit 1
  }
  chmod -R u=rwX,go=rX "$incoming"
  printf '%s\n' "$expected_digest" > "$incoming/.mite-archive.sha256"
  chmod 644 "$incoming/.mite-archive.sha256"

  if [[ -e "$release_directory" || -L "$release_directory" ]]; then
    [[ -d "$release_directory" && ! -L "$release_directory" ]] || exit 1
    [[ "$(cat "$release_directory/.mite-archive.sha256" 2>/dev/null)" == "$expected_digest" ]] || {
      printf 'The release commit already exists with different contents.\n' >&2
      exit 1
    }
    rm -rf -- "$incoming"
    incoming=""
  else
    mv -- "$incoming" "$release_directory"
    incoming=""
    installed=true
  fi

  if [[ -e "$directory/current" || -L "$directory/current" ]]; then
    old_target="$(mite_pwa_release_target "$directory" current)" || exit 1
  fi
  mite_pwa_switch_link "$directory" current "releases/$release"
  switched=true
  if ! mite_pwa_wait_ready "$directory" "$public_url"; then
    exit 1
  fi
  if [[ -n "$old_target" && "$old_target" != "releases/$release" ]]; then
    mite_pwa_switch_link "$directory" previous "$old_target"
  fi
  switched=false
  printf 'Family PWA deployed successfully (%s).\n' "$release"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  export PATH=/usr/local/bin:/usr/bin:/bin
  if [[ "$EUID" -eq 0 ]]; then
    printf 'Run mite-pwa-deploy as the unprivileged VPS deployment user.\n' >&2
    exit 1
  fi
  if [[ "$#" -eq 2 && "$1" == --check ]]; then
    mite_pwa_check_self "$2"
    mite_pwa_check_directory "$mite_pwa_directory"
    mite_pwa_api_ready
    if [[ -e "$mite_pwa_directory/current" || -L "$mite_pwa_directory/current" ]]; then
      mite_pwa_ready "$mite_pwa_directory" "$mite_pwa_public_url"
    fi
    exit
  fi
  if [[ "$#" -ne 3 ]]; then
    printf 'Usage: mite-pwa-deploy <script-sha256> <archive-sha256> <release-commit> < archive.tar.gz\n' >&2
    exit 1
  fi
  mite_pwa_check_self "$1" || {
    printf 'Install the deployment script from the commit being deployed.\n' >&2
    exit 1
  }
  mite_pwa_install "$mite_pwa_directory" /run/lock/mite-family-pwa-deploy.lock \
    "$mite_pwa_public_url" "$2" "$3"
fi
