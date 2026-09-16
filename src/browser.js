// Open a URL in the user's browser. Never throws: a failure just means the
// user opens the printed URL by hand.

import { spawn } from "node:child_process";

function run(command, args, { shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", detached: false, shell });
    } catch (error) {
      resolve({ opened: false, reason: error.message });
      return;
    }
    child.on("error", (error) => resolve({ opened: false, reason: error.message }));
    child.on("exit", (code) =>
      resolve(code === 0 ? { opened: true } : { opened: false, reason: `${command} exited with status ${code}` }),
    );
  });
}

function browserCommand(platform = process.platform, env = process.env) {
  const custom = typeof env.BROWSER === "string" ? env.BROWSER.trim() : "";
  if (custom) return { command: custom, args: [], shell: false };
  if (platform === "darwin") return { command: "/usr/bin/open", args: [], shell: false };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""'], shell: true };
  return { command: "xdg-open", args: [], shell: false };
}

export function openUrl(url, { platform = process.platform, env = process.env } = {}) {
  const { command, args, shell } = browserCommand(platform, env);
  const target = shell ? `"${String(url).replaceAll('"', "")}"` : url;
  return run(command, [...args, target], { shell });
}
