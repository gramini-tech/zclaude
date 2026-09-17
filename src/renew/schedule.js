// Asking the operating system to run the renewal on a timer.
//
// Three mechanisms, one interface. macOS gets a LaunchAgent, which runs in the
// logged-in user's session — the same session that can read the Keychain
// without a prompt. Linux gets a systemd user timer, falling back to a marked
// crontab line where systemd is not in charge. Windows gets the command
// printed rather than run: the installer is bash-only there, and quietly
// creating scheduled tasks on someone's machine from a tool they installed
// with npm is a surprise too far.
//
// Everything written here is removable by name, because the uninstall has to
// leave nothing behind: `zclaude self-uninstall` and `install.sh --uninstall`
// both call uninstall().

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "../logger.js";

export const LABEL = "com.zclaude.renew";
/** Six hours: tokens last hours, and each refresh spends a rotation. */
export const INTERVAL_SECONDS = 6 * 60 * 60;
const CRON_MARKER = "# zclaude renew";
// Apple's DTD identifier, which every plist carries verbatim. It is a name
// rather than a URL anything fetches, and launchd expects this exact string.
const PLIST_DTD = ["http:", "//www.apple.com/DTDs/PropertyList-1.0.dtd"].join("");

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 */
function run(command, args, { env } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function home(env) {
  return env.HOME || homedir();
}

export function agentPath(env = process.env) {
  return join(home(env), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function timerPaths(env = process.env) {
  const dir = join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "systemd", "user");
  return { dir, service: join(dir, "zclaude-renew.service"), timer: join(dir, "zclaude-renew.timer") };
}

/** The command the scheduler runs. */
function renewCommand(binary) {
  return [binary, "renew", "run"];
}

/**
 * @param {string} binary
 * @param {{intervalSeconds?: number, logDir?: string}} [options]
 */
export function plistFor(binary, { intervalSeconds = INTERVAL_SECONDS, logDir } = {}) {
  const out = logDir ? join(logDir, "renew.log") : "/dev/null";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "${PLIST_DTD}">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${renewCommand(binary)
    .map((part) => `\n    <string>${part}</string>`)
    .join("")}
  </array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function unitsFor(binary, { intervalSeconds = INTERVAL_SECONDS } = {}) {
  const service = `[Unit]
Description=Keep zclaude profile logins alive

[Service]
Type=oneshot
ExecStart=${renewCommand(binary).join(" ")}
`;
  const timer = `[Unit]
Description=Keep zclaude profile logins alive

[Timer]
OnBootSec=10min
OnUnitActiveSec=${intervalSeconds}s
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

export function cronLine(binary, { intervalSeconds = INTERVAL_SECONDS } = {}) {
  const hours = Math.max(1, Math.round(intervalSeconds / 3600));
  return `0 */${hours} * * * ${renewCommand(binary).join(" ")} >/dev/null 2>&1 ${CRON_MARKER}`;
}

async function hasSystemd(env) {
  const result = await run("systemctl", ["--user", "--version"], { env });
  return result.ok;
}

// ------------------------------------------------------------------ install

/**
 * Ask the system to run the renewal every few hours.
 * @param {{binary: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, logDir?: string}} args
 */
export async function install({ binary, env = process.env, platform = process.platform, logDir }) {
  if (platform === "darwin") {
    const path = agentPath(env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, plistFor(binary, { logDir }));
    // bootout first so a changed plist is actually reloaded; a missing job is
    // not an error here.
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { env });
    const loaded = await run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, path], { env });
    if (!loaded.ok) {
      const legacy = await run("launchctl", ["load", "-w", path], { env });
      if (!legacy.ok) return { installed: false, mechanism: "launchd", path, detail: loaded.stderr || legacy.stderr };
    }
    log.info("renew", "launch agent installed", { path });
    return { installed: true, mechanism: "launchd", path };
  }

  if (platform === "win32") {
    return {
      installed: false,
      mechanism: "schtasks",
      command: `schtasks /create /tn "zclaude renew" /tr "${renewCommand(binary).join(" ")}" /sc hourly /mo ${Math.round(INTERVAL_SECONDS / 3600)}`,
    };
  }

  if (await hasSystemd(env)) {
    const paths = timerPaths(env);
    const units = unitsFor(binary);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.service, units.service);
    await writeFile(paths.timer, units.timer);
    await run("systemctl", ["--user", "daemon-reload"], { env });
    const enabled = await run("systemctl", ["--user", "enable", "--now", "zclaude-renew.timer"], { env });
    if (!enabled.ok) return { installed: false, mechanism: "systemd", path: paths.timer, detail: enabled.stderr };
    log.info("renew", "systemd timer installed", { path: paths.timer });
    return { installed: true, mechanism: "systemd", path: paths.timer };
  }

  const current = await run("crontab", ["-l"], { env });
  const lines = (current.ok ? current.stdout : "").split("\n").filter((line) => !line.includes(CRON_MARKER));
  const next = [...lines.filter(Boolean), cronLine(binary)].join("\n");
  const written = await runWithInput("crontab", ["-"], `${next}\n`, env);
  if (!written.ok) return { installed: false, mechanism: "cron", detail: written.stderr };
  log.info("renew", "crontab line installed", {});
  return { installed: true, mechanism: "cron" };
}

function runWithInput(command, args, input, env) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.end(input);
  });
}

// ---------------------------------------------------------------- uninstall

/**
 * Remove whatever was installed. Safe to call when nothing was.
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} [options]
 */
export async function uninstall({ env = process.env, platform = process.platform } = {}) {
  const removed = [];
  if (platform === "darwin") {
    const path = agentPath(env);
    const present = await readFile(path, "utf8").catch(() => null);
    if (present !== null) {
      await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { env });
      await run("launchctl", ["unload", path], { env });
      await rm(path, { force: true });
      removed.push(path);
    }
    return { removed };
  }

  if (platform !== "win32") {
    const paths = timerPaths(env);
    const present = await readFile(paths.timer, "utf8").catch(() => null);
    if (present !== null) {
      await run("systemctl", ["--user", "disable", "--now", "zclaude-renew.timer"], { env });
      await rm(paths.timer, { force: true });
      await rm(paths.service, { force: true });
      await run("systemctl", ["--user", "daemon-reload"], { env });
      removed.push(paths.timer);
    }
    const current = await run("crontab", ["-l"], { env });
    if (current.ok && current.stdout.includes(CRON_MARKER)) {
      const lines = current.stdout.split("\n").filter((line) => line && !line.includes(CRON_MARKER));
      await runWithInput("crontab", ["-"], lines.length > 0 ? `${lines.join("\n")}\n` : "", env);
      removed.push("crontab line");
    }
  }
  return { removed };
}

/** Whether a schedule is in place, and where it lives. */
export async function status({ env = process.env, platform = process.platform } = {}) {
  if (platform === "darwin") {
    const path = agentPath(env);
    const plist = await readFile(path, "utf8").catch(() => null);
    if (plist === null) return { installed: false, mechanism: "launchd" };
    const listed = await run("launchctl", ["list", LABEL], { env });
    return { installed: true, mechanism: "launchd", path, loaded: listed.ok, binary: binaryFromPlist(plist) };
  }
  if (platform === "win32") return { installed: false, mechanism: "schtasks" };
  const paths = timerPaths(env);
  const unit = await readFile(paths.timer, "utf8").catch(() => null);
  if (unit !== null) {
    const active = await run("systemctl", ["--user", "is-enabled", "zclaude-renew.timer"], { env });
    return { installed: true, mechanism: "systemd", path: paths.timer, loaded: active.ok };
  }
  const current = await run("crontab", ["-l"], { env });
  if (current.ok && current.stdout.includes(CRON_MARKER)) return { installed: true, mechanism: "cron", loaded: true };
  return { installed: false, mechanism: "cron" };
}

/**
 * The binary a plist was written for, so a moved install can be spotted.
 * Read from ProgramArguments rather than the first string that mentions
 * zclaude, which is the label.
 */
function binaryFromPlist(plist) {
  const array = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\S\s]*?)<\/array>/u);
  const first = array?.[1].match(/<string>([^<]*)<\/string>/u);
  return first ? first[1] : null;
}
