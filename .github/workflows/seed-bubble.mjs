import axios from "axios";
import { faker } from "@faker-js/faker";
import pLimit from "p-limit";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import fs from "fs";

const argv = yargs(hideBin(process.argv))
  .option("config", { type: "string", demandOption: true })
  .option("wipe", { type: "boolean", default: false })
  .argv;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildBaseUrl(baseUrl, env) {
  if (!baseUrl) throw new Error("baseUrl missing");
  if (env === "dev") {
    const u = new URL(baseUrl);
    if (!u.pathname.includes("version-test")) {
      u.pathname = (u.pathname.replace(/\/$/, "")) + "/version-test";
    }
    return u.toString().replace(/\/$/, "");
  }
  return baseUrl.replace(/\/$/, "");
}

// Render fields with template placeholders (faker, refs, etc.)
function renderFields(fields, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = renderValue(v, ctx);
  return out;
}

function renderValue(v, ctx) {
  if (v === null || v === undefined) return v;
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(x => renderValue(x, ctx));
  if (typeof v === "object") {
    const o = {};
    for (const [kk, vv] of Object.entries(v)) o[kk] = renderValue(vv, ctx);
    return o;
  }
  if (typeof v !== "string") return v;

  return v.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    expr = expr.trim();

    // faker.*
    if (expr.startsWith("faker.")) {
      const path = expr.split(".").slice(1);
      let cur = faker;
      for (const p of path) {
        if (!(p in cur)) throw new Error(`Invalid faker path: ${expr}`);
        cur = cur[p];
      }
      return typeof cur === "function" ? cur() : String(cur);
    }

    // refRandom:collection
    if (expr.startsWith("refRandom:")) {
      const coll = expr.split(":")[1];
      const list = ctx.collections[coll] || [];
      if (list.length === 0) throw new Error(`No refs for ${coll}`);
      const idx = Math.floor(Math.random() * list.length);
      return list[idx].id;
    }

    // refThis (parent id)
    if (expr === "refThis") {
      if (!ctx.parent) throw new Error("refThis used without parent");
      return ctx.parent.id;
    }

    // refLinked:fieldName (value from parent's created payload)
    if (expr.startsWith("refLinked:")) {
      const f = expr.split(":")[1];
      if (!ctx.parent || !ctx.parent.links) throw new Error("refLinked without parent links");
      const val = ctx.parent.links[f];
      if (!val) throw new Error(`No linked value for ${f}`);
      return val;
    }

    if (expr === "now") return new Date().toISOString();

    return expr; // literal
  });
}

async function requestWithRetry(fn, { retries = 3, backoffMs = 500 } = {}) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try { return await fn(); }
    catch (e) { lastErr = e; attempt++; if (attempt > retries) break; await sleep(backoffMs * attempt); }
  }
  throw lastErr;
}

async function createOne(http, endpoint, payload, retryCfg) {
  const res = await requestWithRetry(() => http.post(endpoint, payload), retryCfg);
  const data = res.data && (res.data.response || res.data);
  const id = data.id || data._id || (data.results?.[0]?._id);
  if (!id) throw new Error(`Create failed: ${JSON.stringify(res.data).slice(0,200)}`);
  return id;
}

async function searchIds(http, endpoint, constraints, retryCfg) {
  const res = await requestWithRetry(
    () => http.get(endpoint, { params: { constraints: JSON.stringify(constraints || []) } }),
    retryCfg
  );
  const results = res.data && (res.data.response ? res.data.response.results : res.data.results);
  if (!Array.isArray(results)) throw new Error("Search failed: unexpected response");
  return results.map(r => ({ id: r._id || r.id }));
}

async function deleteOne(http, endpoint, id, retryCfg) {
  await requestWithRetry(() => http.delete(`${endpoint}/${id}`), retryCfg);
}

async function run() {
  const config = JSON.parse(fs.readFileSync(argv.config, "utf8"));

  const baseUrl = buildBaseUrl(config.baseUrl, config.env);
  const http = axios.create({
    baseURL: baseUrl,
    headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
    timeout: 30000
  });

  const retryCfg = config.retry || { retries: 3, backoffMs: 500 };
  const limit = pLimit(config.batchSize && config.batchSize > 0 ? config.batchSize : 25);

  if (argv.wipe) {
    console.log("Wiping seeded data (is_seed == true) in reverse order...");
    for (const t of [...config.types].reverse()) {
      const ids = await searchIds(http, t.endpoint, [{ key: "is_seed", constraint_type: "equals", value: true }], retryCfg);
      console.log(`Found ${ids.length} ${t.name} to delete.`);
      await Promise.all(ids.map(({ id }) => limit(() => deleteOne(http, t.endpoint, id, retryCfg))));
    }
    console.log("Wipe complete.");
    return;
  }

  const collections = {}; // saveAs -> [{id, links}]
  for (const t of config.types) {
    console.log(`\nSeeding ${t.name}...`);
    const created = [];

    if (t.countPer) {
      const parents = collections[t.countPer.from] || [];
      await Promise.all(parents.map(parent =>
        Promise.all(Array.from({ length: t.countPer.value || 1 }, () =>
          limit(async () => {
            const ctx = { collections, parent };
            const payload = renderFields(t.fields, ctx);
            const id = await createOne(http, t.endpoint, payload, retryCfg);
            created.push({ id, links: { ...payload } });
            if (config.throttleMs) await sleep(config.throttleMs);
          })
        ))
      ));
    } else {
      await Promise.all(Array.from({ length: t.count || 0 }, () =>
        limit(async () => {
          const ctx = { collections };
          const payload = renderFields(t.fields, ctx);
          const id = await createOne(http, t.endpoint, payload, retryCfg);
          created.push({ id, links: { ...payload } });
          if (config.throttleMs) await sleep(config.throttleMs);
        })
      ));
    }

    if (t.saveAs) collections[t.saveAs] = created;
    console.log(`Created ${created.length} ${t.name}.`);
  }

  console.log("\nAll done.");
}

run().catch(e => {
  console.error("Failed:", e.response?.data || e);
  process.exit(1);
});
