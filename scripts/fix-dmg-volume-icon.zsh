#!/usr/bin/env zsh
# Tauri's DMG helper adds .VolumeIcon.icns but does not mark it Finder-invisible.
# Ensure it never appears as an extra item in the normal drag-to-Applications view.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

root_dir="${0:A:h:h}"
dmg_dir="$root_dir/src-tauri/target/release/bundle/dmg"
dmg_files=("$dmg_dir"/*.dmg(N))

if (( ${#dmg_files} == 0 )); then
  exit 0
fi

fix_dmg() (
  local dmg="$1"
  local work_dir rw_dmg fixed_dmg attachment device mount_dir

  work_dir="$(mktemp -d "${TMPDIR%/}/vocalis-dmg.XXXXXX")"
  rw_dmg="$work_dir/writable.dmg"
  fixed_dmg="$work_dir/fixed.dmg"

  cleanup() {
    if [[ -n "${device:-}" ]]; then
      hdiutil detach "$device" -quiet || true
    fi
    rm -rf "$work_dir"
  }
  trap cleanup EXIT

  hdiutil convert "$dmg" -format UDRW -o "$rw_dmg" -quiet
  attachment="$(hdiutil attach "$rw_dmg" -readwrite -noverify -noautoopen -nobrowse)"
  device="$(print -r -- "$attachment" | awk '/^\/dev\// { print $1; exit }')"
  mount_dir="$(print -r -- "$attachment" | awk 'NF >= 3 { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }')"

  if [[ -z "$device" || -z "$mount_dir" || ! -f "$mount_dir/.VolumeIcon.icns" ]]; then
    print -u2 "Unable to locate .VolumeIcon.icns in $dmg"
    exit 1
  fi

  SetFile -a V "$mount_dir/.VolumeIcon.icns"
  hdiutil detach "$device" -quiet
  device=""

  hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 -o "$fixed_dmg" -quiet
  mv "$fixed_dmg" "$dmg"
)

for dmg in $dmg_files; do
  fix_dmg "$dmg"
done
