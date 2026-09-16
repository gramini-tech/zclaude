import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zaiConfig } from "../src/config.js";
import { EXIT } from "../src/errors.js";
import { mintApiKey, pickOrgProject } from "../src/provision.js";
import { bizEnvelope, jsonResponse, mockFetch } from "./helpers.js";

const config = zaiConfig({});
const KEYS_URL = `${config.apiBase}/api/biz/v1/organization/org-1/projects/proj-1/api_keys`;

function bizFetch({ existingKeys = [], customer, createResponse } = {}) {
  return mockFetch(({ url, method }) => {
    if (method === "POST" && url === config.bizLoginUrl)
      return bizEnvelope({ access_token: "biz-token", expires_in: 3600 });
    if (url === `${config.apiBase}/api/biz/customer/getCustomerInfo`) {
      return bizEnvelope(
        customer ?? {
          organizations: [
            { organizationId: "org-1", isDefault: true, projects: [{ projectId: "proj-1", isDefault: true }] },
          ],
        },
      );
    }
    if (url === KEYS_URL && method === "GET") return bizEnvelope(existingKeys);
    if (url === KEYS_URL && method === "POST")
      return createResponse ?? bizEnvelope({ name: "zclaude", apiKey: "created-id", secretKey: "inline-ignored" });
    if (url.startsWith(`${KEYS_URL}/copy/`))
      return bizEnvelope({
        apiKey: decodeURIComponent(url.slice(`${KEYS_URL}/copy/`.length)),
        secretKey: "real-secret",
      });
    return null;
  });
}

describe("pickOrgProject", () => {
  it("prefers isDefault, then the Chinese default name, then the first entry", () => {
    assert.deepEqual(
      pickOrgProject({
        organizations: [
          { organizationId: 1, projects: [{ projectId: "p1" }] },
          { organizationId: 2, isDefault: true, projects: [{ projectId: "p2" }, { projectId: "p3", isDefault: true }] },
        ],
      }),
      { organizationId: "2", projectId: "p3" },
    );
    assert.deepEqual(
      pickOrgProject({
        organizations: [
          { organizationId: "a", projects: [{ projectId: "x" }] },
          {
            organizationId: "b",
            organizationName: "默认机构",
            projects: [
              { projectId: "y", projectName: "other" },
              { projectId: "z", projectName: "默认项目" },
            ],
          },
        ],
      }),
      { organizationId: "b", projectId: "z" },
    );
    assert.deepEqual(
      pickOrgProject({ organizations: [{ organizationId: "only", projects: [{ projectId: "one" }] }] }),
      { organizationId: "only", projectId: "one" },
    );
  });
  it("returns null without organizations or projects", () => {
    assert.equal(pickOrgProject({}), null);
    assert.equal(pickOrgProject({ organizations: [{ organizationId: "o", projects: [] }] }), null);
  });
});

describe("mintApiKey", () => {
  it("creates a key when none matches and copies the secret", async () => {
    const fetchImpl = bizFetch();
    const result = await mintApiKey("oauth-short", config, { fetchImpl });
    assert.equal(result.apiKey, "created-id.real-secret");
    assert.equal(result.created, true);
    assert.deepEqual(
      fetchImpl.calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${config.bizLoginUrl}`,
        `GET ${config.apiBase}/api/biz/customer/getCustomerInfo`,
        `GET ${KEYS_URL}`,
        `POST ${KEYS_URL}`,
        `GET ${KEYS_URL}/copy/created-id`,
      ],
    );
    assert.deepEqual(fetchImpl.calls[0].body, { token: "oauth-short" });
    assert.equal(fetchImpl.calls[0].authorization, null);
    for (const call of fetchImpl.calls.slice(1)) assert.equal(call.authorization, "Bearer biz-token");
    assert.deepEqual(fetchImpl.calls[3].body, { name: "zclaude" });
  });

  it("reuses an existing key by name", async () => {
    const fetchImpl = bizFetch({
      existingKeys: [
        { name: "other", apiKey: "nope" },
        { name: "zclaude", apiKey: "existing-id" },
      ],
    });
    const result = await mintApiKey("oauth-short", config, { fetchImpl });
    assert.equal(result.apiKey, "existing-id.real-secret");
    assert.equal(result.created, false);
    assert.ok(fetchImpl.calls.every((call) => !(call.method === "POST" && call.url === KEYS_URL)));
  });

  it("honours ZCLAUDE_KEY_NAME", async () => {
    const custom = zaiConfig({ ZCLAUDE_KEY_NAME: "work-laptop" });
    const fetchImpl = bizFetch({ existingKeys: [{ name: "work-laptop", apiKey: "w" }] });
    const result = await mintApiKey("t", custom, { fetchImpl });
    assert.equal(result.apiKey, "w.real-secret");
    assert.equal(result.keyName, "work-laptop");
  });

  it("explains a missing organization", async () => {
    const fetchImpl = bizFetch({ customer: { organizations: [] } });
    await assert.rejects(mintApiKey("t", config, { fetchImpl }), (error) => {
      assert.equal(error.exitCode, EXIT.AUTH);
      assert.match(error.message, /no organization/u);
      assert.match(error.hint, /Coding Plan/u);
      return true;
    });
  });

  it("surfaces envelope failures and adds the key-limit hint on create", async () => {
    const fetchImpl = bizFetch({
      createResponse: jsonResponse({ code: 1300, msg: "key limit reached", success: false }),
    });
    await assert.rejects(mintApiKey("t", config, { fetchImpl }), (error) => {
      assert.match(error.message, /API key creation failed: key limit reached/u);
      assert.match(error.hint, /manage-apikey/u);
      return true;
    });
  });

  it("refuses an empty token", async () => {
    await assert.rejects(mintApiKey("", config, { fetchImpl: mockFetch(() => {}) }), /without an OAuth access token/u);
  });
});
