#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version_file="$root/VERSION"
target_dir="${HOME}/.local/bin"
version=$(tr -d '[:space:]' < "$version_file")

case "${1:-}" in
  --set-version)
    [ "$#" -eq 2 ] || { printf '%s\n' 'usage: install.sh [--bump-version | --set-version X.Y.Z]' >&2; exit 2; }
    version=$2
    ;;
  --bump-version)
    [ "$#" -eq 1 ] || { printf '%s\n' 'usage: install.sh [--bump-version | --set-version X.Y.Z]' >&2; exit 2; }
    previous_ifs=$IFS
    IFS=.
    set -- $version
    IFS=$previous_ifs
    version="$1.$2.$(( ${3:-0} + 1 ))"
    ;;
  '') ;;
  *) printf '%s\n' 'usage: install.sh [--bump-version | --set-version X.Y.Z]' >&2; exit 2 ;;
esac

case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) printf '%s\n' 'version must use X.Y.Z format' >&2; exit 2 ;;
esac

printf '%s\n' "$version" > "$version_file"
mkdir -p "$target_dir"
cd "$root"
go build -ldflags "-X main.version=$version" -o "$target_dir/triangulate" .
printf '%s\n' "Installed triangulate $version to $target_dir/triangulate"
