#!/bin/sh
# Copy this repo's mod into the Herdr app home. A symlink doesn't work: Herdr doesn't load a
# mod's images through one. Run again after each change. Your own files in the mod folder
# that this repo doesn't ship (servers.json) are kept.
set -eu
repo="$(cd "$(dirname "$0")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
for mod in "$repo"/mods/*/; do
  name="$(basename "$mod")"
  mkdir -p "$home/mods/$name"
  # mod.json first: a mod folder without one gets placed in the window by Herdr.
  cp "$mod/mod.json" "$home/mods/$name/mod.json"
  rsync -a --delete --exclude servers.json --exclude jsconfig.json --exclude gpui-kit.d.ts "$mod" "$home/mods/$name/"
  if [ -e "$mod/servers.example.json" ] && [ ! -e "$home/mods/$name/servers.json" ]; then
    cp "$mod/servers.example.json" "$home/mods/$name/servers.json"
    echo "Wrote mods/$name/servers.json from the example: edit it for your apps."
  fi
  herdr-app check "$home/mods/$name"
done
