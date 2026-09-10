#!/bin/bash
# Package the public build for the family PWA deployment script.
set -euo pipefail

[[ "$#" -eq 2 && -d "$1" ]] || {
  printf 'Usage: bash package-family-pwa.sh <build-directory> <archive.tar.gz>\n' >&2
  exit 1
}

# Rebuilding the same commit must not change the archive checksum merely
# because checkout/build timestamps, file order or runner ownership changed.
LC_ALL=C tar --sort=name --format=gnu --mtime=@0 \
  --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
  -cf - -C "$1" . | gzip -n > "$2"
