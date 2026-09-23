// The local page. Hand-written, no framework, no build step, no bundle.
//
// It never sees the router's bearer token. `zclaude router open` mints a
// single-use ticket, the browser trades it for an HttpOnly cookie on the first
// load, and every fetch below rides that cookie. So there is nothing here for a
// page to read, a bookmark to leak, or browser history to keep.
//
// Every model dropdown is filled from the live catalogue, never from a list in
// this file. There is not a single model id anywhere in this directory, which
// is the point: a route configured today keeps meaning what it said after the
// provider ships something new.

const state = {
  /** @type {object | null} */ data: null,
  /** @type {Record<string, {models: Array<{id: string, fast: boolean}>, source: string, detail: string | null}>} */
  models: {},
  /** @type {Record<string, string[]>} */ draft: {},
  dirty: false,
};

const $ = (selector) => document.querySelector(selector);
const rows = (selector) => $(selector).querySelector("tbody");

/**
 * The CSRF value, read from the readable half of the pair of cookies the
 * ticket exchange set. Echoing it in a header is something only a page served
 * from this origin can do, because a cross-site request cannot read it.
 */
function csrf() {
  const found = document.cookie
    .split(";")
    .map((part) => part.trimStart())
    .find((part) => part.startsWith("zclaude_router_csrf="));
  return found ? decodeURIComponent(found.slice("zclaude_router_csrf=".length)) : "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "x-zclaude-csrf": csrf(), ...options.headers },
  });
  if (response.status === 401) {
    $("#where").textContent = "this page's session has expired — run `zclaude router open` again";
    throw new Error("unauthenticated");
  }
  return response;
}

function text(cell, value, className) {
  const td = document.createElement("td");
  td.textContent = value;
  if (className) td.className = className;
  cell.append(td);
  return td;
}

// ------------------------------------------------------------------- routes

/** One <select> per position in a chain, plus one empty slot to extend it. */
function chainEditor(klass, chain, targetNames) {
  const box = document.createElement("div");
  box.className = "chain";
  const slots = [...chain, ""];

  for (const [index, current] of slots.entries()) {
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = index === 0 ? "— nowhere —" : "— add —";
    select.append(blank);
    for (const name of targetNames) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === current;
      select.append(option);
    }
    select.addEventListener("change", () => {
      const next = [...slots];
      next[index] = select.value;
      // A blank in the middle removes that hop rather than leaving a hole, and
      // a duplicate is dropped: both are what the validator would refuse, and
      // refusing a click is worse than doing the obvious thing.
      state.draft[klass] = [...new Set(next.filter(Boolean))];
      state.dirty = true;
      render();
    });
    box.append(select);
  }

  if (chain.length === 1) {
    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = "pinned";
    pin.title = "When this target is spent, these requests wait and then fail rather than moving elsewhere.";
    box.append(pin);
  }
  return box;
}

function renderRoutes() {
  const body = rows("#routes");
  body.replaceChildren();
  const targetNames = Object.keys(state.data.targets);
  for (const klass of state.data.classes) {
    const chain = state.draft[klass] ?? state.data.routes[klass]?.to ?? [];
    const tr = document.createElement("tr");
    text(tr, klass);
    const cell = document.createElement("td");
    cell.append(chainEditor(klass, chain, targetNames));
    tr.append(cell);
    body.append(tr);
  }
  $("#save").disabled = !state.dirty;
}

// ------------------------------------------------------------------ targets

/** What a selector resolves to right now, against the live catalogue. */
function resolves(target) {
  if (target.kind !== "zai") return target.model ? `${target.model} (as asked)` : "whatever was requested";
  const catalogue = state.models.zai;
  if (!catalogue) return "…";
  const models = catalogue.models ?? [];
  const wanted = String(target.model ?? "latest");
  if (wanted === "latest") return models[0]?.id ?? "nothing published";
  if (wanted === "latest:fast") return (models.find((one) => one.fast) ?? models[0])?.id ?? "nothing published";
  if (models.some((one) => one.id === wanted)) return wanted;
  return `${models[0]?.id ?? "nothing published"} — "${wanted}" is no longer listed`;
}

function renderTargets() {
  const body = rows("#targets");
  body.replaceChildren();
  for (const [name, target] of Object.entries(state.data.targets)) {
    const tr = document.createElement("tr");
    text(tr, name);
    text(tr, target.kind);
    text(tr, target.kind === "zai" ? (target.model ?? "latest") : (target.profile ?? "auto"));
    text(tr, resolves(target));
    body.append(tr);
  }
  $("#model-source").textContent = Object.entries(state.models)
    .map(
      ([provider, catalogue]) => `${provider}: ${catalogue.source}${catalogue.detail ? ` (${catalogue.detail})` : ""}`,
    )
    .join(" · ");
}

// ----------------------------------------------------------------- accounts

function percent(value) {
  return typeof value === "number" ? `${Math.round(value)}%` : "—";
}

function renderAccounts() {
  const body = rows("#accounts");
  body.replaceChildren();
  for (const account of state.data.accounts) {
    const tr = document.createElement("tr");
    text(tr, account.name);
    text(tr, account.state ?? "—");
    text(tr, percent(account.usage?.fiveHour?.utilization));
    text(tr, percent(account.usage?.sevenDay?.utilization));
    body.append(tr);
  }
  const out = state.data.sittingOut ?? [];
  $("#sitting-out").textContent =
    out.length === 0 ? "" : `sitting out: ${out.map((one) => `${one.name} (${one.why})`).join(", ")}`;
}

// ---------------------------------------------------------------------- log

function logRow(entry) {
  const tr = document.createElement("tr");
  text(tr, new Date(entry.at).toTimeString().slice(0, 8));
  text(tr, entry.klass);
  text(tr, entry.via && entry.via !== entry.target ? `${entry.target} → ${entry.via}` : (entry.target ?? "—"));
  text(tr, entry.model ?? "—");
  const ok = entry.status >= 200 && entry.status < 300;
  text(tr, String(entry.status), ok ? "status-ok" : entry.status === 429 ? "status-wait" : "status-bad");
  text(tr, String(entry.ms));
  text(tr, entry.usage ? `${entry.usage.input ?? 0}/${entry.usage.output ?? 0}` : "—");
  return tr;
}

function renderLog(entries) {
  const body = rows("#log");
  body.replaceChildren(...entries.map((entry) => logRow(entry)));
}

function renderTotals() {
  const summary = state.data.summary ?? { requests: 0, tokens: 0 };
  $("#totals").textContent = `${summary.requests} requests · ${summary.tokens.toLocaleString()} tokens`;
}

// -------------------------------------------------------------------- wiring

function render() {
  if (!state.data) return;
  renderRoutes();
  renderTargets();
  renderAccounts();
  renderTotals();
}

async function load() {
  const response = await api("/__zclaude/api/state");
  state.data = await response.json();
  const { router, config } = state.data;
  const trouble = config.warnings.length > 0 ? ` · ${config.warnings.join("; ")}` : "";
  $("#where").textContent =
    `127.0.0.1:${router.port} · pid ${router.pid} · ${router.mode} mode · ${config.path}${trouble}`;
  render();
}

async function loadModels(force = false) {
  const response = await api(`/__zclaude/api/models${force ? "?force=1" : ""}`);
  state.models = await response.json();
  render();
}

async function loadLog() {
  const response = await api("/__zclaude/api/log?n=100");
  renderLog((await response.json()).entries ?? []);
}

async function save() {
  const routes = { ...state.data.routes };
  for (const [klass, to] of Object.entries(state.draft)) routes[klass] = { to };
  const response = await api("/__zclaude/api/routes", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routes }),
  });
  const answer = await response.json();
  const errors = $("#route-errors");
  if (!answer.ok) {
    errors.hidden = false;
    errors.textContent = answer.errors.map((one) => `${one.path}: ${one.message}`).join("\n");
    return;
  }
  errors.hidden = true;
  state.draft = {};
  state.dirty = false;
  await load();
}

function live() {
  // The feed is an aid. If it drops, the page still works from the poll below,
  // so there is no reconnect storm to get wrong.
  const feed = new EventSource("/__zclaude/api/events");
  feed.addEventListener("message", (event) => {
    const body = rows("#log");
    body.prepend(logRow(JSON.parse(event.data)));
    while (body.children.length > 100) body.lastElementChild.remove();
  });
}

$("#save").addEventListener("click", () => {
  save().catch((error) => {
    $("#route-errors").hidden = false;
    $("#route-errors").textContent = error.message;
  });
});
$("#refresh-models").addEventListener("click", () => {
  loadModels(true).catch(() => {});
});

await load();
await Promise.all([loadModels().catch(() => {}), loadLog().catch(() => {})]);
live();
setInterval(() => {
  load().catch(() => {});
}, 15_000);
