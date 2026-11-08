# shellcheck shell=bash
# Shared by scripts/staging/staging-status.sh and scripts/staging/release/lib.sh (gate_quiet). Sourced, never run.
#
# terraform_running: whether a Terraform plan, apply, import or untaint is running on this machine. It matches the whole command line, as
# before, but ignores a line whose command is a shell: the test suites' stand-in `terraform` is a bash script, and another session running
# `pnpm test:infra` must not stop this one. A real run is still seen, because Terraform is a binary: run from a shell or through a shim
# such as tfenv, the binary has its own command line.
#
# The output is read whole before it is filtered. `pgrep | grep -q` would let grep stop early, pgrep die of SIGPIPE, and pipefail turn a
# running plan into "nothing running".
#
# Only pgrep's exit 1 means "nothing matches". Any other failure (2 or 3: it cannot read the process list, as in the macOS sandbox; 127: no
# pgrep) counts as running, so gate_quiet stops instead of letting a plan or apply start beside one it cannot see.
TERRAFORM_RUN_PATTERN='terraform.*(apply|plan|import|untaint)'
SHELL_COMMAND_LINE='^[0-9]+ (/usr/bin/env +)?([^ ]*/)?-?(ba|da|k|z)?sh( |$)'

terraform_running() {
  local lines rc=0
  lines="$(pgrep -fl "$TERRAFORM_RUN_PATTERN" 2>/dev/null)" || rc=$?
  [ "$rc" = 1 ] && return 1
  if [ "$rc" != 0 ]; then printf 'cannot read the process list (pgrep exit %s): treating Terraform as running\n' "$rc" >&2; return 0; fi
  printf '%s\n' "$lines" | grep -Ev "$SHELL_COMMAND_LINE" >/dev/null
}
