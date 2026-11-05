#!/usr/bin/env bash
# Same launcher as start-meridex.sh, including the stale-pid check and the database wait.
exec "$(cd "$(dirname "$0")" && pwd)/start-meridex.sh" "$@"
