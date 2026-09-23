// What a request is asking for, read once from the body.
//
// Pure, and deliberately forgiving. Everything here is derived from a body that
// Claude Code wrote and an upstream would have accepted, so a shape this does
// not recognise is a reason to pass the request through untouched rather than
// to refuse it. A router that rejects what the provider would have served is
// worse than no router.
//
// The `[1m]` suffix is handled here and nowhere else. Claude Code appends it to
// a model id to turn on its own 1M-context path; it is not an API model id, and
// sending it upstream is a 404 at either provider. So it is captured as a fact
// about the request and stripped from the id, and the header layer turns it
// back into the beta that actually means it.

import { classOf } from "../auto/cost.js";
import { normalizeModelId } from "../config.js";

/** A class every route table has an entry for, including the one `classOf` cannot name. */
export const UNKNOWN_CLASS = "unknown";

/**
 * @typedef {object} Request
 * @property {string} model the id as Claude Code sent it, suffix and all
 * @property {string} normalized the same id with any `[1m]` marker removed
 * @property {string} klass fable | opus | sonnet | haiku | unknown
 * @property {boolean} oneMillion whether Claude Code asked for its 1M path
 * @property {boolean} stream
 * @property {string[]} betas the anthropic-beta values the client sent
 * @property {boolean} hasCacheControl whether any block carries a cache breakpoint
 * @property {string[]} toolNames
 * @property {string} firstUserText the opening of the conversation, capped
 */

/** The `anthropic-beta` header is a comma-separated list, and may repeat. */
export function parseBetas(header) {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(",") : String(header);
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** The text of the first user turn, which is what identifies a conversation. */
export function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const first = messages.find((message) => message?.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((entry) => entry?.type === "text" && typeof entry.text === "string");
  return block?.text ?? "";
}

/**
 * Whether any block carries a cache breakpoint.
 *
 * Walks only the three places the Messages API puts them. A generic deep walk
 * over a body that can hold tens of megabytes of base64 images would be a CPU
 * problem on every request, for an answer three shallow loops already give.
 */
export function hasCacheControl(body) {
  const marked = (entry) => Boolean(entry?.cache_control);
  const inContent = (content) => Array.isArray(content) && content.some((entry) => marked(entry));
  const anyMarked = (list) => Array.isArray(list) && list.some((entry) => marked(entry));
  if (anyMarked(body?.system) || anyMarked(body?.tools)) return true;
  if (!Array.isArray(body?.messages)) return false;
  return body.messages.some((message) => marked(message) || inContent(message?.content));
}

/**
 * Everything a routing decision needs, from the parsed body and the headers.
 * @param {object | null} body
 * @param {{betas?: string | string[]}} [headers]
 * @returns {Request}
 */
export function classifyRequest(body, { betas } = {}) {
  const model = typeof body?.model === "string" ? body.model : "";
  const normalized = normalizeModelId(model);
  // `classOf` returns null for a Z.ai id, for `<synthetic>` and for a missing
  // model. All three are the same thing here: a class the table must still have
  // an answer for, rather than a request to drop on the floor.
  const klass = classOf(normalized) ?? UNKNOWN_CLASS;
  return {
    model,
    normalized,
    klass,
    oneMillion: /\[1m\]$/iu.test(model),
    stream: body?.stream === true,
    betas: parseBetas(betas),
    hasCacheControl: hasCacheControl(body),
    toolNames: Array.isArray(body?.tools)
      ? body.tools.map((tool) => (typeof tool?.name === "string" ? tool.name : "")).filter(Boolean)
      : [],
    firstUserText: firstUserText(body?.messages).slice(0, 4096),
  };
}
