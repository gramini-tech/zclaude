// Profile picker shown at the start of every interactive launch.

import { select } from "@inquirer/prompts";

import { guard, withSignal } from "./prompt.js";

/**
 * @param {Array<{id: string, label: string, description?: string}>} profiles
 * @param {{defaultId?: string}} [options]
 * @returns {Promise<string>} the chosen profile id
 */
export function chooseProfile(profiles, { defaultId } = {}) {
  const choices = profiles.map((profile) => ({
    name: profile.label,
    value: profile.id,
    description: profile.description,
  }));
  const fallback = choices[0]?.value;
  const initial = choices.some((choice) => choice.value === defaultId) ? defaultId : fallback;
  return guard(
    select(
      {
        message: "What do you want to launch?",
        choices,
        default: initial,
        pageSize: Math.min(12, choices.length + 1),
      },
      { signal: withSignal() },
    ),
  );
}
