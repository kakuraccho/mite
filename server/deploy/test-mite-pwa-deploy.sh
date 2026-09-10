#!/bin/bash
# Exercise family PWA installation and rollback against temporary files.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'result=$?; if [[ "$result" != 0 && -f "${directory:-}/output" ]]; then cat "$directory/output"; fi; rm -rf -- "$test_root"' EXIT
source "$script_directory/mite-pwa-deploy.sh"

old_release=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
new_release=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
public_url=https://priv.chi-llenge.com/mite/pwa/

create_build() {
  local root="$1" label="$2"
  mkdir -p "$root/assets"
  printf '<!doctype html><script src="/mite/pwa/assets/app-%s.js"></script>\n' "$label" > "$root/index.html"
  printf '{\n  "start_url": "./",\n  "scope": "./"\n}\n' > "$root/manifest.webmanifest"
  printf 'const root = self.registration.scope\n' > "$root/sw.js"
  printf '<svg>%s</svg>\n' "$label" > "$root/icon.svg"
  printf '%s\n' "$label" > "$root/assets/app-$label.js"
}

prepare_directory() {
  directory="$1"
  mkdir -p "$directory/releases/$old_release"
  create_build "$directory/releases/$old_release" old
  ln -s "releases/$old_release" "$directory/current"
}

create_archive() {
  local label="$1" fixture archive
  fixture="$test_root/fixture-$label"
  archive="$test_root/$label.tar.gz"
  mkdir -p "$fixture"
  create_build "$fixture" "$label"
  bash "$script_directory/package-family-pwa.sh" "$fixture" "$archive"
  printf '%s\n' "$archive"
}

scenario=success
curl() {
  local url="${*: -1}" target root
  if [[ "$*" == *'--write-out'* ]]; then
    [[ "$*" == *'Origin: https://priv.chi-llenge.com'* ]]
    if [[ "$scenario" == api-unavailable ]]; then return 7; fi
    if [[ "$scenario" == api-forbidden ]]; then printf '403'; return; fi
    printf '401'
    return
  fi
  if [[ "$scenario" == public-mismatch ]]; then printf 'wrong build'; return; fi
  target="$(readlink "$directory/current")"
  root="$directory/$target"
  if [[ "$scenario" == unhealthy-after && "$target" == "releases/$new_release" ]]; then
    return 22
  fi
  case "$url" in
    "$public_url") cat "$root/index.html" ;;
    "${public_url}manifest.webmanifest") cat "$root/manifest.webmanifest" ;;
    "${public_url}sw.js") cat "$root/sw.js" ;;
    *) return 22 ;;
  esac
}
sleep() { :; }

archive="$(create_archive new)"
digest="$(sha256sum "$archive")"
digest="${digest%% *}"

directory="$test_root/success"
prepare_directory "$directory"
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$digest" "$new_release" < "$archive"
[[ "$(readlink "$directory/current")" == "releases/$new_release" ]]
[[ "$(readlink "$directory/previous")" == "releases/$old_release" ]]
[[ "$(cat "$directory/releases/$new_release/.mite-archive.sha256")" == "$digest" ]]
grep -q new "$directory/releases/$new_release/index.html"
printf 'PASS successful update\n'

# Replaying the same verified release is safe and keeps the current selection.
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$digest" "$new_release" < "$archive"
[[ "$(readlink "$directory/current")" == "releases/$new_release" ]]
printf 'PASS idempotent update\n'

# A new runner rebuilds the same files with different timestamps and order.
rebuilt_fixture="$test_root/rebuilt-new"
mkdir -p "$rebuilt_fixture/assets"
for file in icon.svg sw.js manifest.webmanifest index.html assets/app-new.js; do
  cp "$test_root/fixture-new/$file" "$rebuilt_fixture/$file"
done
find "$rebuilt_fixture" -exec touch -d '2001-01-01 00:00:00 UTC' {} +
chmod -R u=rwX,go= "$rebuilt_fixture"
rebuilt_archive="$test_root/rebuilt.tar.gz"
bash "$script_directory/package-family-pwa.sh" "$rebuilt_fixture" "$rebuilt_archive"
cmp "$archive" "$rebuilt_archive"
rebuilt_digest="$(sha256sum "$rebuilt_archive")"
rebuilt_digest="${rebuilt_digest%% *}"
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$rebuilt_digest" "$new_release" < "$rebuilt_archive"
[[ "$(readlink "$directory/current")" == "releases/$new_release" ]]
[[ "$(readlink "$directory/previous")" == "releases/$old_release" ]]
printf 'PASS rebuilt identical release\n'

# A real content change must still be rejected for an existing commit.
printf 'changed application\n' > "$rebuilt_fixture/assets/app-new.js"
bash "$script_directory/package-family-pwa.sh" "$rebuilt_fixture" "$rebuilt_archive"
changed_digest="$(sha256sum "$rebuilt_archive")"
changed_digest="${changed_digest%% *}"
[[ "$changed_digest" != "$digest" ]]
status=0
set +e
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$changed_digest" "$new_release" < "$rebuilt_archive" > "$directory/output" 2>&1
status="$?"
set -e
[[ "$status" -ne 0 ]]
grep -Fq 'The release commit already exists with different contents.' "$directory/output"
[[ "$(readlink "$directory/current")" == "releases/$new_release" ]]
[[ "$(readlink "$directory/previous")" == "releases/$old_release" ]]
[[ "$(cat "$directory/releases/$new_release/assets/app-new.js")" == new ]]
[[ "$(cat "$directory/releases/$new_release/.mite-archive.sha256")" == "$digest" ]]
printf 'PASS changed content rejection\n'

directory="$test_root/first"
mkdir -p "$directory/releases"
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$digest" "$new_release" < "$archive"
[[ "$(readlink "$directory/current")" == "releases/$new_release" ]]
[[ ! -e "$directory/previous" && ! -L "$directory/previous" ]]
printf 'PASS first deployment\n'

directory="$test_root/checksum"
prepare_directory "$directory"
wrong_digest="$(printf 'wrong\n' | sha256sum)"
wrong_digest="${wrong_digest%% *}"
set +e
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$wrong_digest" "$new_release" < "$archive" > "$directory/output" 2>&1
status="$?"
set -e
[[ "$status" -ne 0 ]]
[[ "$(readlink "$directory/current")" == "releases/$old_release" ]]
[[ ! -e "$directory/releases/$new_release" ]]
printf 'PASS checksum rejection\n'

directory="$test_root/unhealthy"
prepare_directory "$directory"
scenario=unhealthy-after
set +e
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$digest" "$new_release" < "$archive" > "$directory/output" 2>&1
status="$?"
set -e
[[ "$status" -ne 0 ]]
scenario=success
[[ "$(readlink "$directory/current")" == "releases/$old_release" ]]
[[ ! -e "$directory/releases/$new_release" ]]
mite_pwa_ready "$directory" "$public_url"
printf 'PASS unhealthy release rollback\n'

directory="$test_root/locked"
prepare_directory "$directory"
exec 8>"$directory/deploy.lock"
flock -n 8
set +e
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$digest" "$new_release" < "$archive" > "$directory/output" 2>&1
status="$?"
set -e
[[ "$status" -ne 0 ]]
exec 8>&-
[[ "$(readlink "$directory/current")" == "releases/$old_release" ]]
printf 'PASS deployment lock\n'

directory="$test_root/symlink"
prepare_directory "$directory"
malicious_fixture="$test_root/malicious-fixture"
create_build "$malicious_fixture" malicious
ln -s /tmp "$malicious_fixture/escape"
malicious_archive="$test_root/malicious.tar.gz"
tar -czf "$malicious_archive" -C "$malicious_fixture" .
malicious_digest="$(sha256sum "$malicious_archive")"
malicious_digest="${malicious_digest%% *}"
set +e
mite_pwa_install "$directory" "$directory/deploy.lock" "$public_url" "$malicious_digest" cccccccccccccccccccccccccccccccccccccccc < "$malicious_archive" > "$directory/output" 2>&1
status="$?"
set -e
[[ "$status" -ne 0 ]]
[[ "$(readlink "$directory/current")" == "releases/$old_release" ]]
printf 'PASS unsafe archive rejection\n'

directory="$test_root/preflight"
prepare_directory "$directory"
mite_pwa_check_directory "$directory"
mite_pwa_api_ready
mite_pwa_ready "$directory" "$public_url"
rm "$directory/current"
ln -s ../../outside "$directory/current"
if mite_pwa_check_directory "$directory" 2>/dev/null; then
  exit 1
fi
printf 'PASS deployment preflight\n'

script_digest="$(sha256sum "$script_directory/mite-pwa-deploy.sh")"
script_digest="${script_digest%% *}"
for scenario in ready empty checksum-mismatch missing-directory api-forbidden api-unavailable public-mismatch; do
  directory="$test_root/preflight-$scenario"
  prepare_directory "$directory"
  expected_script_digest="$script_digest"
  checked_directory="$directory"
  case "$scenario" in
    empty) rm "$directory/current" ;;
    checksum-mismatch) expected_script_digest="$wrong_digest" ;;
    missing-directory) checked_directory="$directory/missing" ;;
  esac
  status=0
  mite_pwa_preflight "$expected_script_digest" "$checked_directory" "$public_url" > "$directory/output" 2>&1 || status="$?"
  case "$scenario" in
    ready|empty) [[ "$status" -eq 0 ]]; message='Family PWA preflight passed.' ;;
    checksum-mismatch) message='deployment script checksum mismatch' ;;
    missing-directory) message='deployment directory is not ready' ;;
    api-forbidden) message='expected HTTP 401, got 403' ;;
    api-unavailable) message='API preflight failed' ;;
    public-mismatch) message='public files do not match current' ;;
  esac
  case "$scenario" in ready|empty) ;; *) [[ "$status" -ne 0 ]] ;; esac
  grep -Fq "$message" "$directory/output"
  [[ ! -f "$directory/deploy.lock" ]]
  printf 'PASS preflight %s\n' "$scenario"
done
