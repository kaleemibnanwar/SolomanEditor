/**
 * Starts the desktop app — having first worked out what this machine can do
 * about Chromium's Linux sandbox.
 *
 * The problem this exists for: on Linux, Chromium's sandbox comes from either a
 * setuid `chrome-sandbox` helper or an unprivileged user namespace. `pnpm
 * install` cannot produce the first — the helper is unpacked from the `electron`
 * package as the installing user, and only root may setuid a file — so a fresh
 * checkout has the helper *present but unconfigured*. That is the one state
 * Electron aborts on rather than working around:
 *
 *   The SUID sandbox helper binary was found, but is not configured correctly.
 *   Rather than run without sandboxing I'm aborting now.
 *
 * So the options are ranked, best first, and the one taken is named out loud:
 *
 *   1. helper setuid root, mode 4755 — launch as-is. This is the configuration
 *      the sandbox is documented against, and the only one that needs no flag.
 *   2. a usable user namespace — add `--disable-setuid-sandbox`, which takes the
 *      broken helper out of the picture so Chromium falls back to a namespace.
 *      The renderer is still sandboxed; only the mechanism differs.
 *   3. neither — add `--no-sandbox` and say so. This one is a genuine (if
 *      dev-machine-sized) concession, and silence about it would be the bug.
 *
 * The decision has to happen HERE, as command-line switches, because the sandbox
 * is set up before `main.cjs` is ever evaluated: `app.commandLine` in the main
 * process runs long after this abort, so it cannot prevent it.
 *
 * Only the development entry points go through this file. `electron-builder`
 * packages its own helper and sets its mode in the installer, so the packaged
 * app is untouched by all of the above.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LOG = "[octo-cut] ";

/** Tells Chromium to stop considering the setuid helper at all. */
const SKIP_HELPER_FLAG = "--disable-setuid-sandbox";
/** Tells Chromium to stop sandboxing. The last resort, never the default. */
const NO_SANDBOX_FLAG = "--no-sandbox";

/* ------------------------------------------------------------------ *
 * What this machine can offer
 * ------------------------------------------------------------------ */

/** The helper ships beside the executable `require("electron")` resolves to. */
function helperPath(electronPath) {
  return path.join(path.dirname(electronPath), "chrome-sandbox");
}

/** Setuid root, executable, mode 4755 — what Chromium insists on. */
function helperIsConfigured(electronPath) {
  try {
    const stat = fs.statSync(helperPath(electronPath));
    return stat.uid === 0 && (stat.mode & 0o4000) !== 0 && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readProc(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Whether an unprivileged user namespace can really be created.
 *
 * Three separate switches can take that away, and a distribution may use any of
 * them — checking only the classic `unprivileged_userns_clone` reports a working
 * sandbox on Ubuntu 24.04, where AppArmor is what actually blocks it. Each file
 * is absent on kernels that never had the restriction, so absence is permission.
 */
function namespacesUsable() {
  const max = readProc("/proc/sys/user/max_user_namespaces");
  if (max !== null && Number(max) === 0) return false;
  if (readProc("/proc/sys/kernel/unprivileged_userns_clone") === "0") return false;
  if (readProc("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") return false;
  return true;
}

/**
 * The switches to add, and one line to explain them. An empty `flags` means the
 * machine is already correctly set up and needs nothing from us.
 */
function sandboxPlan(electronPath, args) {
  if (process.platform !== "linux") return { flags: [], note: null };
  // Whatever was asked for on the command line wins — including a deliberate
  // `--no-sandbox` — since this file is a fallback, not an authority.
  if (args.includes(NO_SANDBOX_FLAG) || args.includes(SKIP_HELPER_FLAG)) return { flags: [], note: null };

  // Chromium refuses to sandbox as root, so a root shell (a container, CI) has
  // no other option to offer.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { flags: [NO_SANDBOX_FLAG], note: "running as root, where Chromium refuses its sandbox — no sandbox this run" };
  }

  if (helperIsConfigured(electronPath)) return { flags: [], note: null };

  if (namespacesUsable()) {
    return {
      flags: [SKIP_HELPER_FLAG],
      note: `chrome-sandbox is not setuid root, so the sandbox comes from a user namespace instead (${SKIP_HELPER_FLAG})`,
    };
  }

  return {
    flags: [NO_SANDBOX_FLAG],
    note: [
      `no usable sandbox here — starting with ${NO_SANDBOX_FLAG}.`,
      "To get it back, run once:",
      `sudo chown root:root ${helperPath(electronPath)} && sudo chmod 4755 ${helperPath(electronPath)}`,
    ].join(" "),
  };
}

/* ------------------------------------------------------------------ *
 * Launch
 * ------------------------------------------------------------------ */

function main() {
  let electronPath;
  try {
    electronPath = require("electron");
  } catch {
    console.error(`${LOG}The \`electron\` package is not installed here — run \`pnpm install\` first.`);
    process.exit(1);
  }

  // Everything after this file: the app path (`.`) and Electron's own flags.
  const args = process.argv.slice(2);
  const { flags, note } = sandboxPlan(electronPath, args);
  if (note) console.log(`${LOG}sandbox: ${note}`);

  const child = spawn(electronPath, [...args, ...flags], { stdio: "inherit" });

  // `concurrently -k` stops the pair by signalling this process; the signal has
  // to reach Electron too, or closing the terminal leaves a window behind.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on("error", (error) => {
    console.error(`${LOG}could not start Electron — ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    // Ctrl+C arrives as a signal, not an exit code; reporting failure for it
    // would make an ordinary quit look like a crash in the script output.
    const interrupted = signal === "SIGINT" || signal === "SIGTERM";
    process.exit(interrupted ? 0 : (code ?? 1));
  });
}

main();
