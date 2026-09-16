// Prompts for creating a profile. Kept apart from the launcher so the
// decisions can be unit tested without a terminal.

import { input, select } from "@inquirer/prompts";

import { guard, withSignal } from "./prompt.js";

/** @returns {Promise<string>} */
export function askProfileName(suggestion = "") {
  return guard(
    input(
      {
        message: "Name for this profile (you will type it as --profile <name>):",
        default: suggestion,
        validate: (value) => (String(value).trim() ? true : "A name is required."),
      },
      { signal: withSignal() },
    ),
  );
}

/** @returns {Promise<"anthropic" | "zai">} */
export function askProvider() {
  return guard(
    select(
      {
        message: "What does this profile sign in to?",
        choices: [
          {
            name: "An Anthropic account",
            value: "anthropic",
            description: "Claude subscription or Console billing, signed in through Claude Code",
          },
          {
            name: "A Z.ai GLM Coding Plan",
            value: "zai",
            description: "GLM models through api.z.ai, signed in through your browser",
          },
        ],
      },
      { signal: withSignal() },
    ),
  );
}

/** @returns {Promise<{config: boolean, history: boolean}>} */
export async function askSharing() {
  const choice = await guard(
    select(
      {
        message: "What should this profile share with your main Claude Code setup?",
        choices: [
          {
            name: "Settings and history",
            value: "all",
            description:
              "Ready to use at once: your settings, skills, commands and agents, plus /resume and prompt history",
          },
          {
            name: "Settings only",
            value: "config",
            description:
              "Your setup, but its own transcripts and prompt history. Sensible when one profile is work and another personal",
          },
          {
            name: "History only",
            value: "history",
            description: "Shared transcripts and prompt history, but its own settings",
          },
          { name: "Nothing", value: "none", description: "A clean Claude Code, configured from scratch" },
        ],
      },
      { signal: withSignal() },
    ),
  );
  return { config: choice === "all" || choice === "config", history: choice === "all" || choice === "history" };
}

/**
 * Copying MCP servers duplicates any secrets in their definitions, so the
 * ones carrying values are named before the question is asked.
 * @param {string[]} withSecrets
 */
export function askCopyMcp(names, withSecrets) {
  const secretNote = withSecrets.length > 0 ? ` ${withSecrets.join(", ")} carry values that are probably secrets.` : "";
  return guard(
    select(
      {
        message: `Copy your ${names.length} MCP server${names.length === 1 ? "" : "s"} into this profile?${secretNote}`,
        choices: [
          { name: "Yes, copy them", value: true, description: names.join(", ") },
          { name: "No, start without MCP servers", value: false },
        ],
      },
      { signal: withSignal() },
    ),
  );
}

export function askCopyTrust(count) {
  return guard(
    select(
      {
        message: `Trust the ${count} folder${count === 1 ? "" : "s"} you already trust, so this profile does not ask again?`,
        choices: [
          { name: "Yes", value: true },
          { name: "No, ask me per folder", value: false },
        ],
      },
      { signal: withSignal() },
    ),
  );
}

export function askSignIn(name) {
  return guard(
    select(
      {
        message: `Sign in to "${name}" now?`,
        choices: [
          { name: "Yes, open the sign-in flow", value: true },
          { name: "Later", value: false },
        ],
      },
      { signal: withSignal() },
    ),
  );
}
