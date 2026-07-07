import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

function packageName(): string {
  // dist/init.js -> ../package.json, whether running from the dev repo or installed under
  // node_modules/<pkg>/dist/init.js — package.json is always one directory up from dist/.
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name: string };
  return pkg.name;
}

interface ConfigLocation {
  path: string;
  supported: boolean;
  note?: string;
}

function claudeDesktopConfigLocation(): ConfigLocation {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return { path: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), supported: true };
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return { path: path.join(appData, "Claude", "claude_desktop_config.json"), supported: true };
  }
  // Claude Desktop has no official Linux build as of this writing. This path matches the
  // conventional ~/.config location an unofficial/community build would likely use, but it's
  // unverified — flagged to the user rather than asserted confidently.
  return {
    path: path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    supported: false,
    note: "Claude Desktop has no official Linux release — this path is a best guess for unofficial builds, not a verified location.",
  };
}

function validateVaultPath(candidate: string): string | undefined {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`"${resolved}" does not exist or is not a directory.`);
    return undefined;
  }
  return resolved;
}

async function resolveVaultPath(rl: readline.Interface, cliArg: string | undefined): Promise<string | undefined> {
  if (cliArg) return validateVaultPath(cliArg);

  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, ".obsidian"))) {
    const answer = (await rl.question(`Detected an Obsidian vault at "${cwd}" (found .obsidian/). Use this vault? [Y/n] `)).trim();
    if (!/^n(o)?$/i.test(answer)) return cwd;
  }

  const entered = (await rl.question("Enter the full path to your Obsidian vault: ")).trim();
  if (!entered) return undefined;
  return validateVaultPath(entered);
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(
      `Existing config at "${configPath}" isn't valid JSON. Fix or remove it by hand, then run init again.`
    );
  }
}

/** Merges in one mcpServers entry, preserving every other key already in the file (other servers included). */
function mergeServerBlock(configPath: string, serverKey: string, serverBlock: unknown): void {
  const config = readConfig(configPath);
  const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  config.mcpServers = { ...mcpServers, [serverKey]: serverBlock };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export async function runInit(cliVaultArg: string | undefined): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const vaultPath = await resolveVaultPath(rl, cliVaultArg);
    if (!vaultPath) {
      console.error("\nNo valid vault path — aborting. Run this again and point it at your Obsidian vault folder.");
      process.exitCode = 1;
      return;
    }

    const pkgName = packageName();
    const serverKey = "second-brain";
    const serverBlock = {
      command: "npx",
      args: ["-y", pkgName],
      env: { OBSIDIAN_VAULT_PATH: vaultPath },
    };
    const { path: configPath, supported, note } = claudeDesktopConfigLocation();

    console.log("\nThis will add the following entry to your Claude Desktop config:\n");
    console.log(JSON.stringify({ mcpServers: { [serverKey]: serverBlock } }, null, 2));
    console.log(`\nConfig file: ${configPath}`);
    if (!supported) console.log(`Note: ${note}`);

    const proceed = (await rl.question("\nWrite this automatically (merging with any existing config)? [y/N] ")).trim();
    if (!/^y(es)?$/i.test(proceed)) {
      console.log(
        "\nNot writing anything. Paste the JSON block above into the \"mcpServers\" section of your Claude Desktop config yourself, then restart Claude Desktop completely."
      );
      return;
    }

    mergeServerBlock(configPath, serverKey, serverBlock);
    console.log(`\nDone — wrote ${configPath}.`);
    console.log("Restart Claude Desktop completely (quit, don't just close the window) to pick it up.");
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
