#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fw="${1:-$here/../upstream/hoja-device-fw}"
fw_rev="$(grep -v '^#' "$here/UPSTREAM" | sed -n 1p | cut -d' ' -f1)"
lib_rev="$(grep -v '^#' "$here/UPSTREAM" | sed -n 2p | cut -d' ' -f1)"

if [ ! -d "$fw/.git" ]; then
  git clone https://github.com/HandHeldLegend/hoja-device-fw.git "$fw"
fi
git -C "$fw" checkout --quiet "$fw_rev"
git -C "$fw" submodule update --init --recursive
lib="$fw/library/HOJA-LIB-RP2040"
git -C "$lib" checkout --quiet "$lib_rev"
git -C "$lib" submodule update --init --recursive

git -C "$fw" apply --whitespace=nowarn "$here/patches/hoja-device-fw.patch"
git -C "$lib" apply --whitespace=nowarn "$here/patches/HOJA-LIB-RP2040.patch"
echo "patched: $fw"
