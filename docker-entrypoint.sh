#!/bin/sh
set -e

# Load Docker secrets as environment variables.
# Each file in /run/secrets/ is expected to be named after its env var,
# e.g. /run/secrets/JWT_SECRET → export JWT_SECRET=<contents>
SECRETS_DIR=/run/secrets
if [ -d "$SECRETS_DIR" ]; then
  for secret_file in "$SECRETS_DIR"/*; do
    [ -f "$secret_file" ] || continue
    var_name=$(basename "$secret_file")
    var_value=$(cat "$secret_file")
    export "$var_name=$var_value"
  done
fi

exec "$@"
