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
TERRAFORM_RUN_PATTERN='terraform.*(apply|plan|import|untaint)'
SHELL_COMMAND_LINE='^[0-9]+ (/usr/bin/env +)?([^ ]*/)?-?(ba|da|k|z)?sh( |$)'

terraform_running() {
  local lines
  lines="$(pgrep -fl "$TERRAFORM_RUN_PATTERN" 2>/dev/null)" || return 1
  printf '%s\n' "$lines" | grep -Ev "$SHELL_COMMAND_LINE" >/dev/null
}
