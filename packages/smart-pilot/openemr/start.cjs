// Fixed, local synthetic project only. Credentials never enter output.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const runtime = path.join(__dirname, ".runtime");
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const env = path.join(runtime, "docker.env");
if (!fs.existsSync(env))
  fs.writeFileSync(
    env,
    ["PILOT_DB_ROOT", "PILOT_DB_APP", "PILOT_ADMIN_PASSWORD"]
      .map(
        (name) => `${name}=${crypto.randomBytes(32).toString("base64url")}\n`,
      )
      .join(""),
    { flag: "wx", mode: 0o600 },
  );
const result = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    env,
    "-f",
    path.join(__dirname, "compose.yml"),
    "up",
    "-d",
    "--build",
  ],
  { stdio: "inherit", timeout: 600000 },
);
if (result.status !== 0) process.exit(1);
(async () => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        "http://127.0.0.1:8301/interface/login/login.php",
        { signal: AbortSignal.timeout(2000) },
      );
      await response.body?.cancel();
      if (response.status === 200) {
        process.stdout.write(
          "Synthetic OpenEMR ready at http://127.0.0.1:8301. Credentials remain in the ignored runtime file.\n",
        );
        return;
      }
    } catch {
      /* bounded readiness retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("readiness timeout");
})().catch(() => {
  process.stderr.write("Synthetic OpenEMR readiness failed.\n");
  process.exitCode = 1;
});
