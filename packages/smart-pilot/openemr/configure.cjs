// Provision only the fixed synthetic container; never a web route or remote host.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const runtime = path.join(__dirname, ".runtime");
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const seed = path.join(runtime, "seed.json");
const container = "telesphoros-remastered-smart-synthetic-openemr-1";
if (!fs.existsSync(seed))
  fs.writeFileSync(
    seed,
    JSON.stringify({
      clinicianUuid: crypto.randomUUID(),
      patients: Array.from({ length: 2 }, () => ({
        fhirId: crypto.randomUUID(),
        medicationUuid: crypto.randomUUID(),
      })),
    }),
    { flag: "wx", mode: 0o600 },
  );
const data = JSON.parse(fs.readFileSync(seed, "utf8"));
for (const args of [
  ["cp", seed, container + ":/tmp/smart-pilot-seed.json"],
  [
    "cp",
    path.join(__dirname, "seed-openemr.php"),
    container + ":/tmp/smart-pilot-seed.php",
  ],
  ["exec", container, "php", "/tmp/smart-pilot-seed.php"],
]) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 60000,
  });
  // SQL errors can include row values. Never forward raw diagnostics.
  if (result.status !== 0) {
    process.stderr.write(
      "Synthetic provisioning failed; inspect the isolated container locally.\n",
    );
    process.exit(1);
  }
}
const registration = {
  tenantId: "synthetic-office",
  clientId: "synthetic-telesphoros",
  issuer: "http://127.0.0.1:8301/apis/default/fhir",
  authorizationEndpoint: "http://127.0.0.1:8301/oauth2/default/authorize",
  tokenEndpoint: "http://127.0.0.1:8301/oauth2/default/token",
  jwksUri: "http://127.0.0.1:8301/oauth2/default/jwk",
  oidcIssuer: "http://127.0.0.1:8301/oauth2/default",
  patients: data.patients.map((p, index) => ({
    ...p,
    patientId: "pat_" + String(index + 1).padStart(24, "0"),
    syntheticIdentifier: "TSP-SYNTHETIC-" + (index + 1),
    consent: index === 0,
    interpretable: true,
    profile: [
      {
        gene: "CYP2C19",
        result: "Synthetic fixture; not a clinical interpretation",
      },
    ],
  })),
};
fs.writeFileSync(
  path.join(runtime, "registration.json"),
  JSON.stringify(registration, null, 2) + "\n",
  { mode: 0o600 },
);
process.stdout.write(
  "Two synthetic patients provisioned; registration remains in the ignored runtime directory.\n",
);
