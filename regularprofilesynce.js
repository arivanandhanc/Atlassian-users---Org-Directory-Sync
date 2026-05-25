import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ======================================================
// ENV
// ======================================================

const {
  OKTA_DOMAIN,
  OKTA_TOKEN,
  ATLASSIAN_DOMAIN,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  ATLASSIAN_ADMIN_TOKEN,
  SLACK_WEBHOOK_URL,
  OKTA_FILTER_FIELD,
  OKTA_FILTER_VALUE,
} = process.env;

const required = [
  "OKTA_DOMAIN", "OKTA_TOKEN",
  "ATLASSIAN_DOMAIN", "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN", "ATLASSIAN_ADMIN_TOKEN",
  "SLACK_WEBHOOK_URL",
  "OKTA_FILTER_FIELD", "OKTA_FILTER_VALUE",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[STARTUP] MISSING ENV: ${key}`);
    process.exit(1);
  }
}

// ======================================================
// LOGGER
// ======================================================

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logData(message, data) {
  console.log(`[${new Date().toISOString()}] ${message}`);
  console.log(JSON.stringify(data, null, 2));
}

// ======================================================
// SLACK ALERT
// ======================================================

async function sendSlackAlert(title, details = {}) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const fields = Object.entries(details).map(([key, value]) => ({
      type: "mrkdwn",
      text: `*${key}:*\n${String(value || "N/A")}`,
    }));

    await axios.post(SLACK_WEBHOOK_URL, {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `🚨 ${title}` },
        },
        {
          type: "section",
          fields: fields.length ? fields : [{ type: "mrkdwn", text: "*Info:*\nNo details" }],
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Time: ${new Date().toISOString()}` }],
        },
      ],
    });
    log(`[SLACK] Alert sent`);
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
  headers: {
    Authorization: `SSWS ${OKTA_TOKEN}`,
    Accept: "application/json",
  },
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
// ======================================================

async function safeRequest(label, fn) {
  try {
    return await fn();
  } catch (err) {
    logData(`[ERROR] ${label}`, {
      status: err.response?.status,
      message: err.message,
      detail: err.response?.data || null,
    });
    return null;
  }
}

// ======================================================
// GET ORG ID
// ======================================================

async function getOrgId() {
  const res = await safeRequest("getOrgId", () => adminAPI.get("/admin/v1/orgs"));
  return res?.data?.data?.[0]?.id || null;
}

// ======================================================
// UPDATE PROFILE
// ======================================================

async function updateProfile(accountId, profile) {
  return await safeRequest("updateProfile", () =>
    adminAPI.patch(`/users/${accountId}/manage/profile`, {
      name: profile.name,
      locale: "en-US",
      extended_profile: {
        job_title: profile.title || "",
        department: profile.department || "",
        location: profile.location || "",
      },
    })
  );
}

// ======================================================
// MAIN — SYNC EXISTING ATLASSIAN USERS
// ======================================================

async function main() {
  log(`[START] Profile sync started`);

  // 1. Get all Okta users matching the filter
  // Use 'search' instead of 'filter' — Okta API requirement
  log(`[INFO] Fetching Okta users with filter: ${OKTA_FILTER_FIELD}=${OKTA_FILTER_VALUE}`);

  let allOktaUsers = [];
  let oktaUrl = `/api/v1/users?search=profile.${OKTA_FILTER_FIELD} eq "${OKTA_FILTER_VALUE}"&limit=200`;

  while (oktaUrl) {
    log(`[INFO] Fetching: ${oktaUrl}`);
    const res = await safeRequest("fetchOktaUsers", () => oktaAPI.get(oktaUrl));
    if (!res) break;

    allOktaUsers.push(...res.data);

    // Handle Okta pagination (Link header)
    const link = res.headers.link;
    if (link && link.includes('rel="next"')) {
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      oktaUrl = nextMatch ? nextMatch[1] : null;
    } else {
      oktaUrl = null;
    }
  }

  log(`[INFO] Found ${allOktaUsers.length} Okta users matching filter`);

  // 2. Also fetch all Atlassian users once (to avoid repeated lookups)
  const orgId = await getOrgId();
  let atlassianUsers = [];
  if (orgId) {
    try {
      const res = await adminAPI.get(`/admin/v1/orgs/${orgId}/users`);
      atlassianUsers = res.data?.data || [];
    } catch (err) {
      log(`[WARN] Could not fetch Atlassian users — will look up individually`);
    }
  }

  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const oktaUser of allOktaUsers) {
    const email = oktaUser.profile.email?.toLowerCase();
    if (!email) continue;

    // Check filter again (search can return partial matches)
    const fieldValue = (oktaUser.profile?.[OKTA_FILTER_FIELD] || "").toLowerCase();
    if (fieldValue !== OKTA_FILTER_VALUE.toLowerCase()) {
      log(`[FILTER] Skipped ${email} — ${OKTA_FILTER_FIELD} "${fieldValue}" ≠ "${OKTA_FILTER_VALUE}"`);
      skipped++;
      continue;
    }

    const name = `${oktaUser.profile.firstName || ""} ${oktaUser.profile.lastName || ""}`.replace(/\s+/g, " ").trim();
    const title = oktaUser.profile.title || "";
    const department = oktaUser.profile.department || "";
    const city = oktaUser.profile.city || "";
    const country = oktaUser.profile.countryCode || "";
    const location = [city, country].filter(Boolean).join(", ");

    const profile = { email, name, title, department, location };

    // Find in Atlassian (from pre-fetched list or direct lookup)
    let atlUser = atlassianUsers.find(u => u.email?.toLowerCase() === email);

    if (!atlUser) {
      // Fallback: search via Jira API
      try {
        const res = await jiraAPI.get("/rest/api/3/user/search", { params: { query: email } });
        atlUser = res.data?.find(u => u.accountType === "atlassian");
      } catch (err) {
        // skip
      }
    }

    if (!atlUser) {
      log(`[SKIP] ${email} — not found in Atlassian (no user creation in this script)`);
      skipped++;
      continue;
    }

    const accountId = atlUser.account_id || atlUser.accountId;

    // Sync profile
    const result = await updateProfile(accountId, profile);
    if (result) {
      log(`[OK] ${email} — profile synced | title: "${title}" | dept: "${department}" | location: "${location}"`);
      synced++;
    } else {
      log(`[FAIL] ${email} — profile sync failed`);
      failed++;
    }
  }

  log(`[DONE] Profile sync complete — Synced: ${synced} | Skipped: ${skipped} | Failed: ${failed}`);

  if (failed > 0) {
    await sendSlackAlert("Profile Sync Completed with Failures", {
      Synced: synced,
      Skipped: skipped,
      Failed: failed,
    });
  } else {
    await sendSlackAlert("Profile Sync Completed", {
      Synced: synced,
      Skipped: skipped,
      Failed: failed,
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();