// A class of model to an ordered list of places it could go.
//
// Pure: no accounts, no credentials, no network. It turns the names in the
// route table into candidate targets and says why any were dropped. Which of
// them can actually take a request is select.js's question, and keeping the two
// apart is what makes this testable without a Keychain.
//
// The order is the whole answer. The first candidate is where the request goes;
// the rest is the order it falls back through when that one refuses. A class
// with one candidate is pinned, and a pinned class that cannot be served waits
// and then fails rather than quietly answering from somewhere else. That is
// what pinning is for, and it surprises people, so it is said out loud in the
// config's own `_readme`.

import { ROUTE_CLASSES } from "./config.js";

/**
 * @typedef {object} Target
 * @property {string} name the name it has in the table
 * @property {"anthropic" | "zai"} kind
 * @property {string} [profile] a profile name, or "auto"
 * @property {string | null} [model] a selector for zai, or an override for anthropic
 * @property {string | null} [zaiProfile]
 */

/**
 * The targets a class can go to, in order.
 *
 * A class with no entry falls back to `unknown`, which every table has, so a
 * model nobody anticipated still has somewhere to go.
 * @param {object} config
 * @param {string} klass
 * @returns {{targets: Target[], klass: string, pinned: boolean, detail: string | null}}
 */
export function candidatesFor(config, klass) {
  const wanted = ROUTE_CLASSES.includes(klass) ? klass : "unknown";
  const route = config?.routes?.[wanted] ?? config?.routes?.unknown;
  const names = Array.isArray(route?.to) ? route.to : [];
  const targets = [];
  const missing = [];
  for (const name of names) {
    const entry = config?.targets?.[name];
    if (!entry) {
      missing.push(name);
      continue;
    }
    targets.push({ name, ...entry });
  }
  return {
    targets,
    klass: wanted,
    // Pinned means one candidate and nowhere to fall back to, which changes
    // what exhaustion means for this class.
    pinned: targets.length === 1,
    detail: missing.length > 0 ? `${missing.join(", ")} no longer exists` : null,
  };
}

/** A target by name, for a caller that already knows which one it wants. */
export function targetByName(config, name) {
  const entry = config?.targets?.[name];
  return entry ? { name, ...entry } : null;
}

/**
 * Whether a proposed table is usable, without applying any of it.
 *
 * Used by `zclaude router route` and by the local page before a write. Returns
 * every problem rather than the first, because a form that reports one error
 * per submission is how people give up on a form.
 *
 * @param {object} next the table as proposed
 * @param {{profiles?: string[]}} [known]
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateRouteTable(next, { profiles = [] } = {}) {
  if (!next || typeof next !== "object") return { ok: false, errors: [{ path: "", message: "not an object" }] };
  const targets = next.targets ?? {};
  const routes = next.routes ?? {};
  const empty =
    Object.keys(targets).length === 0 ? [{ path: "targets", message: "at least one target is needed" }] : [];
  const errors = [...empty, ...validateTargets(targets, profiles), ...validateRoutes(routes, targets)];
  return { ok: errors.length === 0, errors };
}

/** One target at a time, so the reader above stays a sentence. */
function validateTargets(targets, profiles) {
  const errors = [];
  const at = (path, message) => {
    errors.push({ path, message });
  };
  for (const [name, target] of Object.entries(targets)) {
    if (!/^[\w.-]+$/u.test(name)) at(`targets.${name}`, "a target name is letters, digits, dots, dashes, underscores");
    if (target?.kind === "zai") {
      if (typeof target.model !== "string" || !target.model.trim()) {
        at(`targets.${name}.model`, "a Z.ai target needs a model, such as latest or latest:fast");
      }
      continue;
    }
    if (target?.kind !== "anthropic") {
      at(`targets.${name}.kind`, "kind is anthropic or zai");
      continue;
    }
    // "auto" is a value rather than a profile name: it means whichever account
    // has the most room, ranked by the same policy the watcher uses.
    const profile = target.profile ?? "auto";
    if (profile !== "auto" && profiles.length > 0 && !profiles.includes(profile)) {
      at(`targets.${name}.profile`, `there is no profile named "${profile}"`);
    }
  }
  return errors;
}

function validateRoutes(routes, targets) {
  const errors = [];
  const at = (path, message) => {
    errors.push({ path, message });
  };
  for (const [klass, route] of Object.entries(routes)) {
    if (!ROUTE_CLASSES.includes(klass)) {
      at(`routes.${klass}`, `not a class zclaude routes; expected one of ${ROUTE_CLASSES.join(", ")}`);
      continue;
    }
    const to = route?.to;
    if (!Array.isArray(to) || to.length === 0) {
      at(`routes.${klass}.to`, "an ordered list of target names is needed");
      continue;
    }
    for (const [index, name] of to.entries()) {
      if (!Object.hasOwn(targets, name)) at(`routes.${klass}.to[${index}]`, `there is no target named "${name}"`);
    }
    if (new Set(to).size !== to.length) at(`routes.${klass}.to`, "the same target is listed twice");
  }
  // Every class needs somewhere to go, and `unknown` is the one that catches a
  // model nobody has heard of yet, so its absence is a hole rather than taste.
  if (!routes.unknown) at("routes.unknown", "a route for unrecognised models is needed");
  return errors;
}
