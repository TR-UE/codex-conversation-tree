#!/bin/sh
set -eu
tree_package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /bin/sh "$tree_package_dir/scripts/launch-node.sh" "$tree_package_dir/server/setup.mjs"
