// Profile picker shown at the start of every interactive launch.

import { select } from "@inquirer/prompts";

import { InterruptedError, isInterrupt } from "../errors.js";

export async function chooseProfile(profiles, { defaultId } = {}) {
  const choices = profiles.map((profile) => ({
    name: profile.label,
    value: profile.id,
    description: profile.description,
  }));
  const fallback = choices[0]?.value;
  const initial = choices.some((choice) => choice.value === defaultId) ? defaultId : fallback;
  try {
    return await select({
      message: "What do you want to launch?",
      choices,
      default: initial,
      pageSize: Math.min(12, choices.length + 1),
    });
  } catch (error) {
    if (isInterrupt(error)) throw new InterruptedError("Cancelled.");
    throw error;
  }
}
