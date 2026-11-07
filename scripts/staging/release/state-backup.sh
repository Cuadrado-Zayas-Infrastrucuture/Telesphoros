#!/usr/bin/env bash
# Encrypted backup of the staging Terraform state after a release (spec 027, PR 3b). Founder-run; changes nothing in AWS.
#   scripts/staging/release/state-backup.sh BACKUP COMMIT
# One run at a time (a lock). The expected address count comes from the IMAGE plan's own prior state plus its creates minus its deletes (data
# sources count); a flag apply after it replaces the API task definition one for one, so the count still holds. The written state's serial must
# be newer than the one recorded with the IMAGE plan, and the live state must match it by an ORDER-FREE JSON hash (`state pull` is not
# byte-stable). The state holds secrets: it is written ONLY inside the encrypted volume, and nothing here prints it.
# hdiutil asks for a NEW passphrase (create), then again (attach), then once more (read-only re-open). Save it before the third prompt.
# The image lands in ~/telesphoros-private/tfstate-backup-<day>-<commit8>.dmg; the Drive copy and its round trip come next, by hand. A run
# that stops after step 2 leaves its image behind, and the next run refuses it: read why it stopped, then delete that image yourself.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
[ "${1:-}" = BACKUP ] || die "usage: state-backup.sh BACKUP COMMIT (BACKUP confirms that this writes the state into a new encrypted image)"
COMMIT="${2:-}"
release_folder "$COMMIT"
load_stack
DAY=$(date +%Y-%m-%d)
IMG="$PRIVATE/tfstate-backup-$DAY-${COMMIT:0:8}.dmg"
VOL="tfstate-$DAY-${COMMIT:0:8}"
MNT="$PRIVATE/mnt-$VOL"
LOCK="$PRIVATE/.state-backup.lock"
mkdir "$LOCK" 2>/dev/null || die "another run of this script holds $LOCK"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
echo "state-backup ${COMMIT:0:8} started $(date -u +%H:%M:%SZ)"

SUM='const c=require("crypto"),h=(x)=>c.createHash("sha256").update(x).digest("hex");
const norm=(v)=>Array.isArray(v)?v.map(norm).map((x)=>JSON.stringify(x)).sort().map((x)=>JSON.parse(x)):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map((k)=>[k,norm(v[k])])):v;
const sum=(b)=>{const j=JSON.parse(b);return [j.serial,String(j.lineage).slice(0,8),b.length,h(JSON.stringify(norm(j)))].join(" ")};'

echo "== 1. Preconditions"
[ ! -e "$IMG" ] || die "$IMG already exists"
[ ! -e "$MNT" ] || die "$MNT exists: tell Claude"
if ! { grep -qx '== apply exit status: 0' "$OUT/m-apply.txt" 2>/dev/null && grep -qx '== apply exit status: 0' "$OUT/i-apply.txt" 2>/dev/null; }; then
  die "the MIGRATE and IMAGE apply logs of this release are missing or not clean"
fi
FLOOR=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).serial;if(!Number.isInteger(s))process.exit(3);console.log(s)' "$OUT/i.tfplan.meta.json") \
  || die "no state serial in the IMAGE plan's record (i.tfplan.meta.json)"
gate_quiet
gate_identity
EXPECT=$(node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const count = (m) => (m?.resources ?? []).length + (m?.child_modules ?? []).reduce((n, c) => n + count(c), 0);
let add = 0, del = 0;
for (const rc of p.resource_changes ?? []) { const a = rc.change.actions; if (a.includes("create")) add++; if (a.includes("delete")) del++; }
console.log(count(p.prior_state?.values?.root_module) + add - del);' "$OUT/i.plan.json") || die "cannot read i.plan.json"
LIST=$("$TERRAFORM" -chdir="$TFDIR" state list </dev/null) || die "state list failed"
COUNT=$(printf '%s\n' "$LIST" | grep -c .)
echo "live: $COUNT addresses; expected from the IMAGE plan: $EXPECT"
[ "$COUNT" = "$EXPECT" ] || die "expected $EXPECT addresses, found $COUNT: the state moved; tell Claude"
echo ok

echo "== 2. Create the encrypted image (enter a NEW passphrase)"
hdiutil create -size 20m -fs APFS -volname "$VOL" -encryption AES-256 -stdinpass -quiet "$IMG" || die "create failed"

echo "== 3. Attach (enter the passphrase again)"
mkdir "$MNT"
hdiutil attach "$IMG" -stdinpass -mountpoint "$MNT" -nobrowse -quiet || { rmdir "$MNT"; die "attach failed"; }
"$TERRAFORM" -chdir="$TFDIR" state pull </dev/null > "$MNT/terraform.tfstate" || { hdiutil detach "$MNT" -quiet; rmdir "$MNT"; die "state pull failed"; }
INNER=$(sha "$MNT/terraform.tfstate")
read -r ISERIAL ILIN IBYTES ICANON <<<"$(node -e "$SUM"'console.log(sum(require("fs").readFileSync(process.argv[1],"utf8")))' "$MNT/terraform.tfstate")"
hdiutil detach "$MNT" -quiet || die "detach failed"
rmdir "$MNT"
echo "written: serial $ISERIAL, lineage $ILIN..., $IBYTES bytes, order-free sha256 $ICANON"
[ "$ISERIAL" -gt "$FLOOR" ] || die "serial $ISERIAL is not newer than the $FLOOR recorded with the IMAGE plan"

echo "== 4. Same content as the live state? (one more pull, summarized in memory)"
read -r LSERIAL LLIN LBYTES LCANON <<<"$("$TERRAFORM" -chdir="$TFDIR" state pull </dev/null | node -e "$SUM"'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d).on("end",()=>console.log(sum(s)))')"
echo "live:    serial $LSERIAL, lineage $LLIN..., $LBYTES bytes, order-free sha256 $LCANON"
[ "$LSERIAL" = "$ISERIAL" ] && [ "$LLIN" = "$ILIN" ] || die "the state changed while backing up (serial or lineage): tell Claude"
[ "$LCANON" = "$ICANON" ] || die "same serial, but the content differs: tell Claude (do not upload)"

echo "== 5. Re-open read-only (enter the passphrase a third time)"
mkdir "$MNT"
hdiutil attach "$IMG" -stdinpass -readonly -mountpoint "$MNT" -nobrowse -quiet || { rmdir "$MNT"; die "re-attach failed: wrong passphrase?"; }
AGAIN=$(sha "$MNT/terraform.tfstate")
hdiutil detach "$MNT" -quiet; rmdir "$MNT"
[ "$AGAIN" = "$INNER" ] || die "inner file changed after re-open"
echo "re-open ok"

echo "== 6. Result"
hdiutil isencrypted "$IMG" | grep -E '^encrypted'
echo "image:  $IMG"
echo "image sha256: $(sha "$IMG")"
echo "image bytes:  $(wc -c < "$IMG" | tr -d ' ')"
echo "Done. Next: the Drive copy and its round trip."
