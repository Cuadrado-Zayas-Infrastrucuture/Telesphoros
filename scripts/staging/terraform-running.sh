# shellcheck shell=bash
# Shared by scripts/staging/staging-status.sh and scripts/staging/release/lib.sh (gate_quiet). Sourced, never run.
#
# terraform_running [NAME...]: whether a Terraform plan, apply, import or untaint is running on this machine.
#   exit 0  a process is: callers stop
#   exit 1  none is
#   exit 2  the process list could not be read (a sandboxed agent session cannot): callers stop too, never read this as quiet
#
# The output is read whole before it is filtered. `pgrep | grep -q` would let grep stop early, pgrep die of SIGPIPE, and pipefail turn a
# running plan into "nothing running".
#
# Only pgrep's exit 1 means "nothing matches". Any other failure (2 or 3: it cannot read the process list, as in the macOS sandbox; 127: no
# pgrep) counts as running, so gate_quiet stops instead of letting a plan or apply start beside one it cannot see.
TERRAFORM_RUN_PATTERN='terraform.*(apply|plan|import|untaint)'
# A process counts by its executable's name, never by its command line alone: several sessions share this Mac, and the command line of a
# `zsh -c`, a `codex exec`, an `rg` or a `tail` can mention "terraform ... plan" (on 2026-11-07 one such shell stopped the status plan and
# 21 tests). The names are terraform, the file name of TERRAFORM (the pinned binary in stack.env), and docker, whose command line must also
# name terraform: on macOS a containerised Terraform runs in Docker's VM, where this machine's pgrep cannot see it. Of those processes, one
# counts when apply, plan, import or untaint is a whole argument, and its command is not a shell: Linux names a script's process after the
# script, so the test suites' stand-in `terraform` (a bash script) has that name there. NAME... replaces the three names (tests only).
SHELL_COMMAND_LINE='^[0-9]+ (/usr/bin/env +)?([^ ]*/)?-?(ba|da|k|z)?sh( |$)'

# shellcheck disable=SC2120 # the callers pass no names, on purpose
terraform_running() {
  local lines rc=0
  lines="$(pgrep -fl "$TERRAFORM_RUN_PATTERN" 2>/dev/null)" || rc=$?
  [ "$rc" = 1 ] && return 1
  if [ "$rc" != 0 ]; then printf 'cannot read the process list (pgrep exit %s): treating Terraform as running\n' "$rc" >&2; return 0; fi
  printf '%s\n' "$lines" | grep -Ev "$SHELL_COMMAND_LINE" >/dev/null
  local names=("$@") name pids pid args st
  [ "${#names[@]}" -gt 0 ] || names=(terraform "${TERRAFORM:-terraform}" docker)
  for name in "${names[@]}"; do
    name="${name##*/}"
    st=0
    pids="$(pgrep -x -- "$name" 2>/dev/null)" || st=$?
    [ "$st" -le 1 ] || return 2
    for pid in $pids; do
      args="$(ps -o args= -p "$pid" 2>/dev/null)" || continue # it ended between pgrep and ps
      [[ "$pid $args" =~ $SHELL_COMMAND_LINE ]] && continue
      [ "$name" != docker ] || [[ "$args" == *terraform* ]] || continue
      [[ " $args " =~ [[:space:]](apply|plan|import|untaint)[[:space:]] ]] && return 0
    done
  done
  return 1
}
