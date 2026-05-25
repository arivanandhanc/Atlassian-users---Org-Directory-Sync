import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
dotenv.config();

// ======================================================
// ENV
// ======================================================

const {
  SYNC_API_KEY,
  SYNC_HOURS = "12",
  OKTA_DOMAIN,
  OKTA_TOKEN,
  ATLASSIAN_DOMAIN,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  ATLASSIAN_ADMIN_TOKEN,
  JSM_SERVICE_DESK_ID,
  JSM_GROUP_ID,
  SLACK_WEBHOOK_URL,
} = process.env;

const required = [
  "SYNC_API_KEY",
  "OKTA_DOMAIN", "OKTA_TOKEN",
  "ATLASSIAN_DOMAIN", "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN", "ATLASSIAN_ADMIN_TOKEN",
  "JSM_SERVICE_DESK_ID", "JSM_GROUP_ID",
  "SLACK_WEBHOOK_URL",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[STARTUP] MISSING ENV: ${key}`);
    process.exit(1);
  }
}

// ======================================================
// SECURITY
// ======================================================

const EXPECTED_KEY = process.env.SYNC_API_KEY;

if (EXPECTED_KEY.length < 32) {
  console.error("[SECURITY] SYNC_API_KEY must be at least 32 chars. Run: openssl rand -hex 32");
  process.exit(1);
}

function validateApiKey(key) {
  if (!key || key.length !== EXPECTED_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(EXPECTED_KEY));
}

if (!validateApiKey(EXPECTED_KEY)) {
  console.error("[SECURITY] SYNC_API_KEY validation failed");
  process.exit(1);
}

// ======================================================
// RUN ID + CONFIG
// ======================================================

const RUN_ID = crypto.randomBytes(6).toString("hex");
const HOURS  = parseInt(SYNC_HOURS, 10) || 12;

// ======================================================
// LOGGER
// ======================================================

function log(msg) {
  console.log(`[${new Date().toISOString()}] [RUN:${RUN_ID}] ${msg}`);
}

// ======================================================
// SLACK
// ======================================================

async function sendSlackAlert(title, details = {}, blocks = null) {
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      blocks: blocks || [
        {
          type: "header",
          text: { type: "plain_text", text: `🔄 ${title}` },
        },
        {
          type: "section",
          fields: Object.entries(details).map(([k, v]) => ({
            type: "mrkdwn",
            text: `*${k}:*\n${String(v ?? "N/A")}`,
          })),
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Run ID: \`${RUN_ID}\` | ${new Date().toISOString()}` }],
        },
      ],
    });
  } catch (err) {
    log(`[SLACK ERROR] ${err.message}`);
  }
}

// ======================================================
// API CLIENTS
// ======================================================

const oktaAPI = axios.create({
  baseURL: OKTA_DOMAIN,
  timeout: 30000,
  headers: { Authorization: `SSWS ${OKTA_TOKEN}`, Accept: "application/json" },
});

const basicAuth = Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString("base64");

const jiraAPI = axios.create({
  baseURL: `https://${ATLASSIAN_DOMAIN}`,
  timeout: 30000,
  headers: {
    Authorization: `Basic ${basicAuth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

const adminAPI = axios.create({
  baseURL: "https://api.atlassian.com",
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${ATLASSIAN_ADMIN_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

// ======================================================
// SAFE REQUEST
// 204 No Content → axios resolves → NOT null
// null = genuine error only
// ======================================================

async function safeRequest(label, fn, { silent = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!silent) {
      log(`[ERROR] ${label} — status: ${err.response?.status} | ${err.message}`);
    }
    return null;
  }
}

// ======================================================
// ORG ID — cached once per run
// ======================================================

let _cachedOrgId = null;

async function getOrgId() {
  if (_cachedOrgId) return _cachedOrgId;
  const res = await safeRequest("getOrgId", () => adminAPI.get("/admin/v1/orgs"));
  _cachedOrgId = res?.data?.data?.[0]?.id ?? null;
  return _cachedOrgId;
}

// ======================================================
// STEP 1 — FETCH OKTA LOGS → FINAL STATE PER USER
// ======================================================

const WATCHED_EVENTS = [
  "user.lifecycle.activate",
  "user.lifecycle.unsuspend",
  "user.lifecycle.deactivate",
  "user.lifecycle.suspend",
];

async function fetchOktaFinalStates() {
  const since = new Date(Date.now() - HOURS * 60 * 60 * 1000).toISOString();
  log(`[OKTA] Fetching logs — past ${HOURS}h (since ${since})`);

  const allEvents = [];
  let url = "/api/v1/logs";
  let firstCall = true;

  while (url) {
    const res = await safeRequest("fetchOktaLogs", () =>
      firstCall
        ? oktaAPI.get(url, { params: { since, limit: 500 } })
        : oktaAPI.get(url)
    );
    if (!res) break;
    firstCall = false;

    allEvents.push(
      ...res.data.filter((e) => WATCHED_EVENTS.includes(e.eventType))
    );

    const next = (res.headers?.link || "").match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  log(`[OKTA] ${allEvents.length} relevant event(s) found`);

  // Deduplicate — keep only latest event per user
  const latestByUser = new Map();
  for (const event of allEvents) {
    const email = event.target
      ?.find((t) => t.type === "User")
      ?.alternateId?.toLowerCase();
    if (!email) continue;
    const existing = latestByUser.get(email);
    if (!existing || new Date(event.published) > new Date(existing.published)) {
      latestByUser.set(email, event);
    }
  }

  // Build TABLE A — Okta final state
  const tableA = [];
  for (const [email, event] of latestByUser) {
    const isActive =
      event.eventType === "user.lifecycle.activate" ||
      event.eventType === "user.lifecycle.unsuspend";
    tableA.push({
      email,
      eventType: event.eventType,
      oktaStatus: isActive ? "ACTIVE" : "INACTIVE",
      published: event.published,
    });
  }

  return tableA;
}

// ======================================================
// STEP 2 — FETCH ATLASSIAN CURRENT STATE FOR SAME USERS
// Checks: account status + JSM group + service desk
// ======================================================

async function getAtlassianUser(email) {
  const orgId = await getOrgId();

  if (orgId) {
    const res = await safeRequest("getAtlassianUser:admin", () =>
      adminAPI.get(`/admin/v1/orgs/${orgId}/users`)
    );
    const user = res?.data?.data?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );
    if (user) {
      return {
        accountId: user.account_id,
        displayName: user.display_name,
        email: user.email,
        // account_status from admin API: "active" | "inactive"
        accountActive: user.account_status === "active",
      };
    }
  }

  // Jira fallback — exact email match
  const res = await safeRequest("getAtlassianUser:jira", () =>
    jiraAPI.get("/rest/api/3/user/search", { params: { query: email } })
  );
  const user = res?.data?.find(
    (u) =>
      u.accountType === "atlassian" &&
      u.emailAddress?.toLowerCase() === email.toLowerCase()
  );
  if (user) {
    return {
      accountId: user.accountId,
      displayName: user.displayName,
      email: user.emailAddress,
      accountActive: user.active === true,
    };
  }

  return null;
}

async function isInJsmGroup(accountId) {
  const res = await safeRequest("isInJsmGroup", () =>
    jiraAPI.get(`/rest/api/3/group/member`, {
      params: { groupId: JSM_GROUP_ID, maxResults: 1000 },
    }),
    { silent: true }
  );
  return (
    res?.data?.values?.some((u) => u.accountId === accountId) ?? false
  );
}

async function isJsmCustomer(accountId) {
  const res = await safeRequest("isJsmCustomer", () =>
    jiraAPI.get(
      `/rest/servicedeskapi/servicedesk/${JSM_SERVICE_DESK_ID}/customer`,
      { headers: { "X-ExperimentalApi": "opt-in" } }
    ),
    { silent: true }
  );
  return (
    res?.data?.values?.some((u) => u.accountId === accountId) ?? false
  );
}

async function fetchAtlassianStates(tableA) {
  log(`[ATLASSIAN] Checking current state for ${tableA.length} user(s)...`);

  const tableB = [];

  for (const user of tableA) {
    const atlUser = await getAtlassianUser(user.email);

    if (!atlUser) {
      tableB.push({
        email: user.email,
        exists: false,
        accountActive: false,
        inGroup: false,
        isCustomer: false,
        accountId: null,
      });
      continue;
    }

    const [inGroup, isCustomer] = await Promise.all([
      isInJsmGroup(atlUser.accountId),
      isJsmCustomer(atlUser.accountId),
    ]);

    tableB.push({
      email: user.email,
      exists: true,
      accountActive: atlUser.accountActive,
      inGroup,
      isCustomer,
      accountId: atlUser.accountId,
    });
  }

  return tableB;
}

// ======================================================
// STEP 3 — COMPARE TABLES → BUILD DIFF
// Okta ACTIVE   = account active + in group + is customer
// Okta INACTIVE = account suspended + not in group
// ======================================================

function buildDiff(tableA, tableB) {
  const diff = [];

  for (const okta of tableA) {
    const atl = tableB.find((u) => u.email === okta.email);
    const oktaWantsActive = okta.oktaStatus === "ACTIVE";

    const actions = [];

    if (oktaWantsActive) {
      // What needs to be fixed to make Atlassian fully active?
      if (!atl?.exists)          actions.push("CREATE");
      if (atl?.exists && !atl.accountActive) actions.push("ENABLE");
      if (atl?.exists && !atl.inGroup)       actions.push("ADD_GROUP");
      if (atl?.exists && !atl.isCustomer)    actions.push("ADD_CUSTOMER");

      // New user — will need enable + group + customer after create
      if (!atl?.exists) {
        actions.length = 0;
        actions.push("CREATE", "ENABLE", "ADD_GROUP", "ADD_CUSTOMER");
      }
    } else {
      // What needs to be fixed to make Atlassian fully inactive?
      if (atl?.exists && atl.accountActive) actions.push("SUSPEND");
      if (atl?.exists && atl.inGroup)       actions.push("REMOVE_GROUP");
    }

    diff.push({
      email: okta.email,
      oktaStatus: okta.oktaStatus,
      atlAccountActive: atl?.accountActive ?? false,
      atlInGroup: atl?.inGroup ?? false,
      atlIsCustomer: atl?.isCustomer ?? false,
      atlExists: atl?.exists ?? false,
      accountId: atl?.accountId ?? null,
      actions, // empty = already in sync
      inSync: actions.length === 0,
    });
  }

  return diff;
}

// ======================================================
// STEP 4 — PRINT TABLES TO LOGS
// ======================================================

function printTables(tableA, tableB, diff) {
  // TABLE A — Okta final states
  log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("TABLE A — OKTA FINAL STATE (from logs)");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log(`  ${"EMAIL".padEnd(40)} STATUS`);
  log(`  ${"─".repeat(40)} ──────────`);
  for (const u of tableA) {
    log(`  ${u.email.padEnd(40)} ${u.oktaStatus}`);
  }

  // TABLE B — Atlassian current states
  log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("TABLE B — ATLASSIAN CURRENT STATE (live)");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log(`  ${"EMAIL".padEnd(40)} ACCOUNT    GROUP   CUSTOMER`);
  log(`  ${"─".repeat(40)} ─────────  ──────  ────────`);
  for (const u of tableB) {
    if (!u.exists) {
      log(`  ${u.email.padEnd(40)} NOT FOUND`);
    } else {
      const acc  = u.accountActive ? "ACTIVE    " : "SUSPENDED ";
      const grp  = u.inGroup    ? "YES   " : "NO    ";
      const cust = u.isCustomer ? "YES"     : "NO";
      log(`  ${u.email.padEnd(40)} ${acc} ${grp}  ${cust}`);
    }
  }

  // DIFF TABLE
  log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("DIFF — WHAT NEEDS TO CHANGE");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log(`  ${"EMAIL".padEnd(40)} OKTA      ACTIONS`);
  log(`  ${"─".repeat(40)} ────────  ───────────────────────`);
  for (const u of diff) {
    const actions = u.inSync ? "✓ in sync" : u.actions.join(", ");
    log(`  ${u.email.padEnd(40)} ${u.oktaStatus.padEnd(9)} ${actions}`);
  }
  log("");
}

// ======================================================
// ATLASSIAN ACTIONS
// ======================================================

async function createAtlassianUser(email) {
  return await safeRequest("createAtlassianUser", () =>
    jiraAPI.post("/rest/api/3/user", {
      emailAddress: email,
      displayName: email.split("@")[0],
      products: [],
    })
  );
}

async function enableAtlassianUser(accountId) {
  return await safeRequest(
    "enableAtlassianUser",
    () => adminAPI.post(`/users/${accountId}/manage/lifecycle/enable`),
    { silent: true }
  );
}

async function suspendAtlassianUser(accountId) {
  return await safeRequest(
    "suspendAtlassianUser",
    () => adminAPI.post(`/users/${accountId}/manage/lifecycle/disable`),
    { silent: true }
  );
}

async function addJsmCustomer(accountId) {
  await safeRequest(
    "addJsmCustomer",
    () =>
      jiraAPI.post(
        `/rest/servicedeskapi/servicedesk/${JSM_SERVICE_DESK_ID}/customer`,
        { accountIds: [accountId] },
        { headers: { "X-ExperimentalApi": "opt-in" } }
      ),
    { silent: true }
  );
}

async function addJsmGroupMembership(accountId) {
  await safeRequest(
    "addJsmGroupMembership",
    () => jiraAPI.post(`/rest/api/3/group/user?groupId=${JSM_GROUP_ID}`, { accountId }),
    { silent: true }
  );
}

async function removeJsmGroupMembership(accountId) {
  await safeRequest(
    "removeJsmGroupMembership",
    () => jiraAPI.delete(`/rest/api/3/group/user?groupId=${JSM_GROUP_ID}&accountId=${accountId}`),
    { silent: true }
  );
}

// ======================================================
// STEP 5 — APPLY DIFF
// Only touches what's actually out of sync
// ======================================================

async function applyDiff(diff) {
  const results = { synced: 0, skipped: 0, failed: 0 };

  for (const user of diff) {
    if (user.inSync) {
      log(`[SKIP] Already in sync — ${user.email}`);
      results.skipped++;
      continue;
    }

    log(`[SYNC] ${user.email} — applying: ${user.actions.join(", ")}`);
    let accountId = user.accountId;
    let failed = false;

    for (const action of user.actions) {
      switch (action) {

        case "CREATE": {
          const created = await createAtlassianUser(user.email);
          if (!created?.data?.accountId) {
            log(`[FAIL] CREATE failed — ${user.email}`);
            await sendSlackAlert("User Create Failed", { User: user.email, RunID: RUN_ID });
            failed = true;
          } else {
            accountId = created.data.accountId;
            log(`[OK] Created — accountId: ${accountId}`);
          }
          break;
        }

        case "ENABLE": {
          const res = await enableAtlassianUser(accountId);
          if (res === null) {
            log(`[FAIL] ENABLE failed — ${user.email}`);
            failed = true;
          } else {
            log(`[OK] Enabled — ${user.email}`);
          }
          break;
        }

        case "SUSPEND": {
          const res = await suspendAtlassianUser(accountId);
          if (res === null) {
            log(`[FAIL] SUSPEND failed — ${user.email}`);
            await sendSlackAlert("User Suspend Failed", { User: user.email, RunID: RUN_ID });
            failed = true;
          } else {
            log(`[OK] Suspended — ${user.email}`);
          }
          break;
        }

        case "ADD_GROUP": {
          await addJsmGroupMembership(accountId);
          log(`[OK] Added to group — ${user.email}`);
          break;
        }

        case "REMOVE_GROUP": {
          await removeJsmGroupMembership(accountId);
          log(`[OK] Removed from group — ${user.email}`);
          break;
        }

        case "ADD_CUSTOMER": {
          await addJsmCustomer(accountId);
          log(`[OK] Added as JSM customer — ${user.email}`);
          break;
        }
      }

      // Stop processing further actions for this user if a critical step failed
      if (failed) break;
    }

    if (failed) {
      results.failed++;
    } else {
      log(`[DONE] ${user.email}`);
      results.synced++;
    }
  }

  return results;
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  log("════════════════════════════════════════════════");
  log(`SYNC STARTED — window: ${HOURS}h`);
  log("════════════════════════════════════════════════");

  // STEP 1 — Okta logs → final state per user (Table A)
  const tableA = await fetchOktaFinalStates();

  if (tableA.length === 0) {
    log("[INFO] No relevant events in window. Nothing to do.");
    await sendSlackAlert("Okta → Atlassian Sync", {
      Window: `${HOURS}h`, Result: "No events found", RunID: RUN_ID,
    });
    process.exit(0);
  }

  // STEP 2 — Atlassian live state for same users (Table B)
  const tableB = await fetchAtlassianStates(tableA);

  // STEP 3 — Compare → build diff
  const diff = buildDiff(tableA, tableB);

  // STEP 4 — Print all 3 tables to logs
  printTables(tableA, tableB, diff);

  const toSync    = diff.filter((u) => !u.inSync);
  const alreadyOk = diff.filter((u) => u.inSync);

  log(`[INFO] ${alreadyOk.length} user(s) already in sync — skipping`);
  log(`[INFO] ${toSync.length} user(s) need changes — syncing now`);

  // Send diff to Slack before applying
  if (toSync.length > 0) {
    const diffLines = toSync
      .map((u) => `• \`${u.email}\` → ${u.actions.join(", ")}`)
      .join("\n");
    await sendSlackAlert("Sync Diff — Changes About to Apply", {
      Window: `${HOURS}h`,
      "Users to Sync": toSync.length,
      Changes: diffLines,
      RunID: RUN_ID,
    });
  }

  // STEP 5 — Apply only the diff
  const results = await applyDiff(diff);

  // Final summary
  log("\n════════════════════════════════════════════════");
  log("SYNC COMPLETE");
  log(`  Synced  : ${results.synced}`);
  log(`  Skipped : ${results.skipped} (already in sync)`);
  log(`  Failed  : ${results.failed}`);
  log("════════════════════════════════════════════════\n");

  await sendSlackAlert("Okta → Atlassian Sync Complete", {
    Window: `${HOURS}h`,
    Synced: results.synced,
    Skipped: results.skipped,
    Failed: results.failed,
    RunID: RUN_ID,
  });

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});