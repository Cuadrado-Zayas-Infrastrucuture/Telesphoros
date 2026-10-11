// Exercise the actual seed predicate on MariaDB. The temporary table shadows
// patient_data in this one connection; no persistent patient records are touched.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const source = fs.readFileSync(
  path.join(__dirname, "seed-openemr.php"),
  "utf8",
);
const sql = source.match(
  /query\('(SELECT COUNT\(\*\) n FROM patient_data WHERE [^']+)'/,
)?.[1];
if (!sql) throw new Error("Cannot locate synthetic guard predicate");
const encoded = Buffer.from(sql).toString("base64");
const php = `<?php
if (getenv('TELESPHOROS_SYNTHETIC_PILOT') !== '1') exit(2);
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db=new mysqli(getenv('MYSQL_HOST'),'root',getenv('MYSQL_ROOT_PASS'),'openemr');
$db->query('CREATE TEMPORARY TABLE patient_data (pubpid VARCHAR(255) NULL)');
$insert=$db->prepare('INSERT INTO patient_data (pubpid) VALUES (?)');
$guard=$db->prepare(base64_decode('${encoded}'));
foreach ([['TSP-SYNTHETIC-1',0],['TSP-SYNTHETIC-2',0],[null,1],['',2],['SYNTHETIC-UNREGISTERED',3]] as [$value,$expected]) {
  $insert->execute([$value]);
  $guard->execute(['TSP-SYNTHETIC-1','TSP-SYNTHETIC-2']);
  if ((int)$guard->get_result()->fetch_assoc()['n'] !== $expected) exit(3);
}
echo "PASS: synthetic guard rejects NULL, empty and unregistered identifiers; both registered fixtures accepted.\\n";
`;
const result = spawnSync(
  "docker",
  ["exec", "-i", "telesphoros-remastered-smart-synthetic-openemr-1", "php"],
  { input: php, encoding: "utf8", timeout: 30000 },
);
if (result.status !== 0) {
  process.stderr.write(
    result.status === 3
      ? "FAIL: actual guard count did not reject an unregistered identifier.\n"
      : "Synthetic seed guard execution failed; sensitive diagnostics withheld.\n",
  );
  process.exitCode = 1;
} else process.stdout.write(result.stdout);
