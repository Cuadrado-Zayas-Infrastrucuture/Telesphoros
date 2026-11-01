# Minimal hosted runtime and security follow-up
Date: 2026-11-01

The API/task image now contains Node and its reviewed shared-library closure, rather than the build distribution's unused tools and libraries. It retains Debian identity and copied-library package inventory, rejects unexpected native dependencies, and defaults to the C locale without copying other locales. System zlib, mount/libmount/libblkid and SUID utilities are absent; Node compression remains supported.

The older zlib writer failure was reproduced in source after clearing an I/O error; its published fix removed the failure. No private library fork is shipped. Glibc's gettext finding remains open and mitigated, not waived or called patched. See [security scope](../../infrastructure/docker/runtime-security.md) for all seven finding dispositions and limitations.

The existing real-image rehearsal now checks the minimal runtime before its database, worker and API flows. No Terraform apply, cloud task, image publication, staging/frontend deployment or database migration is authorized or performed by this change.
