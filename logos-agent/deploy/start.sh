#!/bin/sh
set -eu
logos_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$logos_root/logos-agent/bin/logos.mjs" "$@"
