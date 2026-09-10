#!/bin/bash
# Package the public build for the family PWA deployment script.
set -euo pipefail

[[ "$#" -eq 2 && -d "$1" ]] || {
  printf 'Usage: bash package-family-pwa.sh <build-directory> <archive.tar.gz>\n' >&2
  exit 1
}
[[ "${SOURCE_DATE_EPOCH:-}" =~ ^[0-9]+$ ]] || {
  printf 'Set SOURCE_DATE_EPOCH to the release commit timestamp in Unix seconds.\n' >&2
  exit 1
}

# Rebuilding the same commit must not change the archive checksum merely
# because checkout/build timestamps, file order or runner ownership changed.
# Keep a per-commit mtime so Apache can distinguish successive releases.
LC_ALL=C tar --sort=name --format=gnu --mtime="@$SOURCE_DATE_EPOCH" \
  --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
  -cf - -C "$1" . | gzip -n > "$2"
