// Model wizard: primary, subagent and fast (haiku-class) model choices from
// the live model list, plus where to save the result.

import { input, password, select, Separator } from "@inquirer/prompts";

import { describeContextWindow, MODEL_CONTEXT_WINDOWS } from "../config.js";
import { InterruptedError, isInterrupt } from "../errors.js";

const CUSTOM = "__custom__";

function guard(promise) {
  return promise.catch((error) => {
    if (isInterrupt(error)) throw new InterruptedError("Cancelled.");
    throw error;
  });
}

export function knownModels() {
  return Object.entries(MODEL_CONTEXT_WINDOWS).map(([id, value]) => ({ id, contextWindow: value }));
}

function choicesFor(models, current) {
  const ids = models.map((model) => model.id);
  if (current && !ids.includes(current)) ids.unshift(current);
  const choices = ids.map((id) => ({
    name: `${id}  (${describeContextWindow(id)})`,
    value: id,
    description: id === current ? "current selection" : undefined,
  }));
  choices.push(new Separator(), { name: "Enter a custom model id", value: CUSTOM });
  return choices;
}

async function pickModel({ message, models, current }) {
  const value = await guard(
    select({
      message,
      choices: choicesFor(models, current),
      default: current,
      pageSize: 14,
      loop: false,
    }),
  );
  if (value !== CUSTOM) return value;
  return (
    await guard(
      input({
        message: "Model id:",
        default: current,
        validate: (text) =>
          /^[A-Za-z0-9][A-Za-z0-9._\-[\]]*$/u.test(String(text).trim())
            ? true
            : "Use letters, digits, dots and dashes only.",
      }),
    )
  ).trim();
}

/**
 * models: [{id, contextWindow}]; current: {primary, subagent, fast}.
 * Returns the new {primary, subagent, fast}.
 */
export async function runModelWizard({ models, current }) {
  const list = models.length > 0 ? models : knownModels();
  const primary = await pickModel({
    message: "Primary model (what you talk to):",
    models: list,
    current: current.primary,
  });
  const subagent = await pickModel({
    message: "Subagent model (background agents, Task tool):",
    models: list,
    current: list.some((m) => m.id === current.subagent) || list.length === 0 ? current.subagent : primary,
  });
  const flashDefault = list.find((m) => /flash/iu.test(m.id))?.id;
  const fast = await pickModel({
    message: "Fast model (haiku-class helpers, summaries):",
    models: list,
    current: current.fast || flashDefault || subagent,
  });
  return { primary, subagent, fast };
}

/** Returns "project" | "user" | "none". */
export function chooseSaveLocation({ projectPath, userPath, userExists }) {
  return guard(
    select({
      message: "Save these choices?",
      choices: [
        { name: "This project", value: "project", description: projectPath },
        { name: userExists ? "User default (update)" : "User default", value: "user", description: userPath },
        { name: "Don't save", value: "none", description: "use them for this session only" },
      ],
      default: userExists ? "project" : "user",
    }),
  );
}

export async function promptApiKey() {
  const value = await guard(
    password({
      message: "Paste your Z.ai coding-plan API key:",
      mask: "*",
      validate: (text) =>
        String(text).trim().length >= 16 ? true : "That does not look like a Z.ai key (expected id.secret).",
    }),
  );
  return value.trim();
}

export function confirmChoice(message, choices, defaultValue) {
  return guard(select({ message, choices, default: defaultValue }));
}
