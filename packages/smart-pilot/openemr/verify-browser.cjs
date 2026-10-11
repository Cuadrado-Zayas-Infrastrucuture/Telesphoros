// Optional installed gstack browser driver. Only dedicated synthetic localhost pages.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const runtime = path.join(__dirname, ".runtime");
const browser = path.join(
  os.homedir(),
  ".agents/skills/gstack/browse/dist/browse",
);
function run(...args) {
  const result = spawnSync(browser, args, { encoding: "utf8", timeout: 25000 });
  if (result.status !== 0)
    throw new Error(
      "Browser step failed: " +
        args[0] +
        (args[0] === "wait" ? " " + args[1] : ""),
    );
  return result.stdout.trim();
}
try {
  const password = fs
    .readFileSync(path.join(runtime, "docker.env"), "utf8")
    .match(/^PILOT_ADMIN_PASSWORD=(.+)$/m)?.[1];
  if (!password) throw new Error("Generated synthetic credentials missing");
  const reset = path.join(runtime, "reset-oauth-cookie.json");
  fs.writeFileSync(
    reset,
    JSON.stringify([
      {
        name: "authserverOpenEMR",
        value: "",
        domain: "127.0.0.1",
        path: "/oauth2/",
        expires: 1,
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
    ]),
    { mode: 0o600 },
  );
  run("frame", "main");
  run("newtab", "http://127.0.0.1:8301/interface/login/login.php");
  run("cookie-import", reset);
  const main = run("tabs").match(/→\s*\[(\d+)\]/)?.[1];
  if (!main) throw new Error("Main tab missing");
  run("snapshot", "-i");
  run("fill", "@e1", "synthetic-admin");
  run("fill", "@e2", password);
  run("click", "@e41");
  run("wait", 'iframe[name="cal"]');
  if (
    run(
      "js",
      "Array.from(document.querySelectorAll('button')).some(x=>x.textContent.trim()==='Ask again later')",
    ) === "true"
  )
    run("click", "text=Ask again later");
  const results = [];
  for (const [number, expected] of [
    [1, "Synthetic context verified"],
    [2, "Genomic consent required"],
  ]) {
    run("tab", main);
    run("frame", "main");
    run("snapshot", "-i");
    run("fill", "@e10", "Synthetic");
    run("press", "Enter");
    run("wait", 'iframe[name="fin"]');
    run("frame", 'iframe[name="fin"]');
    run("wait", `text=Pilot ${number}, Synthetic`);
    run("click", `text=Pilot ${number}, Synthetic`);
    run("frame", "main");
    run("wait", 'iframe[name="pat"]');
    run("frame", 'iframe[name="pat"]');
    run("wait", "text=Open synthetic PGx review in a new tab");
    const url = run(
      "js",
      "document.querySelector('a[href*=\"oe-module-telesphoros-pilot/launch.php\"]').href",
    ).replace(/^"|"$/g, "");
    if (
      !url.startsWith(
        "http://127.0.0.1:8301/interface/modules/custom_modules/oe-module-telesphoros-pilot/launch.php?",
      )
    )
      throw new Error("Unexpected launch target");
    run("newtab", url);
    run("wait", 'input[type="password"]');
    run("snapshot", "-i");
    run("fill", "@e2", "synthetic-admin");
    run("fill", "@e3", password);
    run("click", "@e4");
    run("wait", "text=Authorize");
    run("click", "text=Authorize");
    run("wait", "text=" + expected);
    if (
      run(
        "js",
        "location.pathname === '/smart/evidence' && location.hash === ''",
      ) !== "true"
    )
      throw new Error("Route/fragment check failed");
    if (
      run(
        "js",
        "document.body.textContent.includes('Clinical recommendations are disabled')",
      ) !== "true"
    )
      throw new Error("Clinical boundary disclosure missing");
    const hasPreview = run("js", "document.body.textContent.includes('Versioned FHIR preview (synthetic only)')") === "true";
    if (hasPreview !== (number === 1)) throw new Error("Versioned FHIR consent boundary failed");
    if (number === 1) {
      run("click", "text=Versioned FHIR preview (synthetic only)");
      if (run("js", "document.querySelector('pre').textContent.includes('synthetic-evaluation-2') && document.querySelector('pre').textContent.includes('DocumentReference')") !== "true")
        throw new Error("Version/source preview missing");
    }
    run("screenshot", path.join(runtime, `patient-${number}.png`));
    results.push({
      syntheticPatient: number,
      expectedState: expected,
      result: "PASS",
      fragmentCleared: true,
      versionedPreviewVisible: hasPreview,
    });
  }
  fs.writeFileSync(
    path.join(runtime, "browser-verification.json"),
    JSON.stringify(
      {
        runtime: "OpenEMR 8.4.1 with pinned UUID corrections; Remastered pilot",
        results,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    "PASS: two real synthetic OpenEMR launches, read-only FHIR, consent withholding and cleared fragments.\n",
  );
} catch (error) {
  process.stderr.write(error.message + "; sensitive diagnostics withheld.\n");
  process.exitCode = 1;
}
