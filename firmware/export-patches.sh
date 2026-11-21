#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fw="$here/../upstream/hoja-device-fw"
lib="$fw/library/HOJA-LIB-RP2040"
mkdir -p "$here/patches"

skip=(':!rp2040/gcu_1/timestamp.h' ':!include/generated/*')

export_repo() {
  local repo="$1" out="$2" tmp
  tmp="$(mktemp)"
  GIT_INDEX_FILE="$tmp" git -C "$repo" read-tree HEAD
  GIT_INDEX_FILE="$tmp" git -C "$repo" add -A -- . "${skip[@]}"
  GIT_INDEX_FILE="$tmp" git -C "$repo" diff --cached --binary --ignore-submodules=all HEAD -- . "${skip[@]}" > "$out"
  rm -f "$tmp"
  echo "$(git -C "$repo" rev-parse HEAD)  $(git -C "$repo" remote get-url origin)"
}

{
  export_repo "$fw" "$here/patches/hoja-device-fw.patch"
  export_repo "$lib" "$here/patches/HOJA-LIB-RP2040.patch"
} > "$here/UPSTREAM"
cat "$here/UPSTREAM"
wc -l "$here"/patches/*.patch
