// Runs install.sh against this checkout (no network for zclaude itself; npm
// still fetches @inquirer/prompts) into a scratch HOME and checks the result.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { tempHome } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = process.platform === "win32" ? "bash installer is not for Windows" : false;
// Keychain items only exist on macOS; elsewhere the installer skips that work.
const macOnly = process.platform === "darwin" ? false : "Keychain cleanup is macOS only";

function sh(args, env) {
  return new Promise((resolve) => {
    execFile("bash", args, { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

describe("install.sh", { skip }, () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = {
      PATH: process.env.PATH,
      HOME: home.dir,
      ZCLAUDE_INSTALL_SOURCE: root,
      ZCLAUDE_INSTALL_NO_CLAUDE: "1",
      ZCLAUDE_INSTALL_NO_RC: "1",
      ZCLAUDE_NO_KEYCHAIN: "1",
      // PATH here is the real one, which on a developer's machine has a real
      // `code` and a real editor to install into. Off by default; the tests
      // that care turn it on against a fake.
      ZCLAUDE_INSTALL_NO_VSIX: "1",
      ZCLAUDE_INSTALL_NO_RENEW: "1",
      NO_COLOR: "1",
    };
  });
  after(() => home.cleanup());

  it("installs from a local source, links the command, and is re-runnable", async () => {
    const first = await sh([join(root, "install.sh")], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stderr, /zclaude \d+\.\d+\.\d+ installed in .*\.zclaude\/app/u);
    assert.match(first.stderr, /Skipping Claude Code|Claude Code found/u);
    const link = join(home.dir, ".local", "bin", "zclaude");
    assert.equal(await readlink(link), join(home.dir, ".zclaude", "app", "zclaude"));
    assert.ok((await stat(join(home.dir, ".zclaude", "app", "node_modules", "@inquirer"))).isDirectory());
    const version = await new Promise((resolve) => {
      execFile(
        link,
        ["--version"],
        { env: { ...env, ZCLAUDE_CLAUDE_BIN: "/nonexistent" }, encoding: "utf8" },
        (error, stdout) => resolve(error ? `error ${error.code}` : stdout),
      );
    });
    assert.match(version, /^zclaude \d+\.\d+\.\d+/u);
    const again = await sh([join(root, "install.sh")], env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stderr, /installed in/u);
  });

  it("survives repeated install and uninstall cycles", async () => {
    const link = join(home.dir, ".local", "bin", "zclaude");
    const app = join(home.dir, ".zclaude", "app");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const installed = await sh([join(root, "install.sh")], env);
      assert.equal(installed.code, 0, `cycle ${cycle} install: ${installed.stderr}`);
      assert.ok((await stat(link)).isFile() || (await stat(link)).isSymbolicLink());
      const removed = await sh([join(root, "install.sh"), "--uninstall"], env);
      assert.equal(removed.code, 0, `cycle ${cycle} uninstall: ${removed.stderr}`);
      await assert.rejects(stat(app), /ENOENT/u, `cycle ${cycle} left the app directory`);
      await assert.rejects(readlink(link), /ENOENT/u, `cycle ${cycle} left a dangling command`);
    }
    await sh([join(root, "install.sh")], env);
  });

  it("links into a directory already on PATH so the command works at once", async () => {
    const binDir = join(home.dir, ".local", "bin");
    const onPath = await sh([join(root, "install.sh")], { ...env, PATH: `${binDir}:${process.env.PATH}` });
    assert.equal(onPath.code, 0, onPath.stderr);
    assert.match(onPath.stderr, /Ready\. Run: zclaude/u);
    assert.equal(await readlink(join(binDir, "zclaude")), join(home.dir, ".zclaude", "app", "zclaude"));
  });

  it("rejects unknown arguments and uninstalls cleanly", async () => {
    const bad = await sh([join(root, "install.sh"), "--bogus"], env);
    assert.equal(bad.code, 1);
    const gone = await sh([join(root, "install.sh"), "--uninstall"], env);
    assert.equal(gone.code, 0, gone.stderr);
    await assert.rejects(stat(join(home.dir, ".zclaude", "app")), /ENOENT/u);
    await assert.rejects(stat(join(home.dir, ".local", "bin", "zclaude")), /ENOENT/u);
    await assert.rejects(stat(join(home.dir, ".zclaude")), /ENOENT/u, "settings and logs are purged by default");
    assert.match(gone.stderr, /gone from this machine/u);
  });

  // Each profile's Claude Code login lives in a Keychain item outside
  // ~/.zclaude, so removing the directory is not enough. `security` is faked
  // here: the real one would prompt, and there is nothing to delete anyway.
  it("signs every profile out of Claude Code when it removes the config", { skip: macOnly }, async () => {
    await sh([join(root, "install.sh")], env);
    const fakeBin = join(home.dir, "fake-bin");
    const calls = join(home.dir, "security-calls.txt");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "security"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`);
    await chmod(join(fakeBin, "security"), 0o755);
    await mkdir(join(home.dir, ".zclaude"), { recursive: true });
    await writeFile(
      join(home.dir, ".zclaude", "profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            work: {
              name: "work",
              provider: "anthropic",
              dir: "/x/work",
              credentialService: "Claude Code-credentials-aaaaaaaa",
            },
            personal: {
              name: "personal",
              provider: "anthropic",
              dir: "/x/p",
              credentialService: "Claude Code-credentials-bbbbbbbb",
            },
          },
        },
        null,
        2,
      ),
    );
    const keychainEnv = { ...env, PATH: `${fakeBin}:${env.PATH}`, ZCLAUDE_NO_KEYCHAIN: "" };
    const gone = await sh([join(root, "install.sh"), "--uninstall"], keychainEnv);
    assert.equal(gone.code, 0, gone.stderr);
    const recorded = (await readFile(calls, "utf8")).trim().split("\n");
    assert.ok(
      recorded.includes("delete-generic-password -s Claude Code-credentials-aaaaaaaa"),
      `wanted the work item removed, got: ${recorded.join(" | ")}`,
    );
    assert.ok(recorded.includes("delete-generic-password -s Claude Code-credentials-bbbbbbbb"));
    assert.ok(recorded.includes("delete-generic-password -s zclaude"), "the Z.ai keys go too");
    assert.match(gone.stderr, /Signed 2 profile\(s\) out of Claude Code/u);
  });

  it("keeps a profile's login when it keeps the config", { skip: macOnly }, async () => {
    await sh([join(root, "install.sh")], env);
    const fakeBin = join(home.dir, "fake-bin-keep");
    const calls = join(home.dir, "security-keep.txt");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "security"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`);
    await chmod(join(fakeBin, "security"), 0o755);
    await writeFile(
      join(home.dir, ".zclaude", "profiles.json"),
      JSON.stringify({ version: 1, profiles: { work: { credentialService: "Claude Code-credentials-cccccccc" } } }),
    );
    const kept = await sh([join(root, "install.sh"), "--uninstall", "--keep-config"], {
      ...env,
      PATH: `${fakeBin}:${env.PATH}`,
      ZCLAUDE_NO_KEYCHAIN: "",
    });
    assert.equal(kept.code, 0, kept.stderr);
    const recorded = await readFile(calls, "utf8").catch(() => "");
    assert.doesNotMatch(
      recorded,
      /Claude Code-credentials-cccccccc/u,
      "the profiles are still there, so are their logins",
    );
  });

  it("keeps settings with --keep-config", async () => {
    await sh([join(root, "install.sh")], env);
    const settings = join(home.dir, ".zclaude", "settings");
    await writeFile(settings, "ZCLAUDE_MODEL=glm-5.3\n");
    const kept = await sh([join(root, "install.sh"), "--uninstall", "--keep-config"], env);
    assert.equal(kept.code, 0, kept.stderr);
    assert.equal(await readFile(settings, "utf8"), "ZCLAUDE_MODEL=glm-5.3\n");
    await assert.rejects(stat(join(home.dir, ".zclaude", "app")), /ENOENT/u);
  });

  // The installer offers the VS Code item and the renewal job. Both are run
  // against fakes: a real `code` would install into the developer's editor.
  let editorCall = 0;
  async function fakeEditor(name = "code") {
    // A fresh calls file each time: these tests share one HOME, and an old
    // recording would answer for the run under test.
    editorCall += 1;
    const bin = join(home.dir, `fake-editor-${editorCall}`);
    const calls = join(home.dir, `editor-calls-${editorCall}.txt`);
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit 0\n`);
    await chmod(join(bin, name), 0o755);
    return { bin, calls, read: () => readFile(calls, "utf8").catch(() => "") };
  }

  it("installs the VS Code item unattended when an editor is there", async () => {
    const editor = await fakeEditor();
    const installed = await sh([join(root, "install.sh")], {
      ...env,
      ZCLAUDE_INSTALL_NO_VSIX: "",
      PATH: `${editor.bin}:${process.env.PATH}`,
    });
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stderr, /Installed zclaude .* into VS Code/u);
    assert.match(await editor.read(), /code --install-extension .*zclaude\.vsix --force/u);
    await sh([join(root, "install.sh"), "--uninstall"], env);
  });

  it("skips it when ZCLAUDE_INSTALL_NO_VSIX is set, and says so", async () => {
    const editor = await fakeEditor();
    const installed = await sh([join(root, "install.sh")], { ...env, PATH: `${editor.bin}:${process.env.PATH}` });
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stderr, /Skipping the VS Code status bar item/u);
    assert.doesNotMatch(await editor.read(), /--install-extension/u);
    await sh([join(root, "install.sh"), "--uninstall"], env);
  });

  it("takes the VS Code item out again on uninstall", async () => {
    const editor = await fakeEditor();
    const withEditor = { ...env, PATH: `${editor.bin}:${process.env.PATH}` };
    await sh([join(root, "install.sh")], withEditor);
    const gone = await sh([join(root, "install.sh"), "--uninstall"], withEditor);
    assert.equal(gone.code, 0, gone.stderr);
    assert.match(await editor.read(), /code --uninstall-extension vipincr\.zclaude/u);
    assert.match(gone.stderr, /Removed the status bar item from 1 editor/u);
  });

  it("offers the renewal job only when there is an Anthropic profile to keep alive", async () => {
    const fresh = await sh([join(root, "install.sh")], { ...env, ZCLAUDE_INSTALL_NO_RENEW: "" });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stderr, /renewal/u, "a fresh machine has nothing to renew yet");
    await mkdir(join(home.dir, ".zclaude"), { recursive: true });
    await writeFile(
      join(home.dir, ".zclaude", "profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: { work: { name: "work", provider: "anthropic", dir: join(home.dir, "w"), share: {} } },
      }),
    );
    const scheduler = join(home.dir, "fake-sched");
    await mkdir(scheduler, { recursive: true });
    for (const tool of ["launchctl", "systemctl", "crontab"]) {
      await writeFile(join(scheduler, tool), "#!/bin/sh\nexit 0\n");
      await chmod(join(scheduler, tool), 0o755);
    }
    const withProfile = await sh([join(root, "install.sh")], {
      ...env,
      ZCLAUDE_INSTALL_NO_RENEW: "",
      PATH: `${scheduler}:${process.env.PATH}`,
    });
    assert.equal(withProfile.code, 0, withProfile.stderr);
    assert.match(withProfile.stderr, /Scheduled with (launchd|systemd|cron)/u);
    const gone = await sh([join(root, "install.sh"), "--uninstall"], env);
    assert.equal(gone.code, 0, gone.stderr);
    // Whichever mechanism this platform used, the uninstall leaves nothing.
    for (const path of [
      join(home.dir, "Library", "LaunchAgents", "com.zclaude.renew.plist"),
      join(home.dir, ".config", "systemd", "user", "zclaude-renew.timer"),
    ]) {
      await assert.rejects(stat(path), /ENOENT/u, `the uninstall left ${path} behind`);
    }
  });

  it("warns instead of editing rc files when told to, and appends once otherwise", async () => {
    const rc = join(home.dir, ".zshrc");
    await sh([join(root, "install.sh")], {
      ...env,
      ZCLAUDE_INSTALL_NO_RC: "",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    });
    const text = await readFile(rc, "utf8");
    assert.match(text, /export PATH=".*\.local\/bin:\$PATH" # added by the zclaude installer/u);
    await sh([join(root, "install.sh")], {
      ...env,
      ZCLAUDE_INSTALL_NO_RC: "",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    });
    assert.equal((await readFile(rc, "utf8")).split("zclaude installer").length, 2, "added only once");
  });
});
