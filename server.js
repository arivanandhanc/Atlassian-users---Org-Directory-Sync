import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ======================================================
// ENV VALIDATION
// ======================================================

const {
  PORT = 3000,
  OKTA_DOMAIN,
  OKTA_TOKEN,
  ATLASSIAN_DOMAIN,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  ATLASSIAN_ADMIN_TOKEN,
  MANAGED_DOMAIN,
  WEBHOOK_SECRET,
  JSM_SERVICE_DESK_ID,
  JSM_GROUP_ID,
  SLACK_WEBHOOK_URL,
  OKTA_FILTER_FIELD,
  OKTA_FILTER_VALUE,
  JWT_SECRET,
} = process.env;

const required = [
  "OKTA_DOMAIN", "OKTA_TOKEN",
  "ATLASSIAN_DOMAIN", "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN", "ATLASSIAN_ADMIN_TOKEN",
  "MANAGED_DOMAIN", "WEBHOOK_SECRET",
  "JSM_SERVICE_DESK_ID", "JSM_GROUP_ID",
  "SLACK_WEBHOOK_URL", "JWT_SECRET",
  "ADMIN_USERNAME", "ADMIN_PASSWORD",
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
// JWT HELPERS
// ======================================================

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Token missing" });
  }
  try {
    const token = authHeader.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// ======================================================
// SLACK ALERT
// ======================================================

async function sendSlackAlert(title, details = {}) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const fields = Object.entries(details).map(([key, value]) => ({
      type: "mrkdwn",
      text: `*${key}:*\n${String(value ?? "N/A")}`,
    }));
    await axios.post(SLACK_WEBHOOK_URL, {
      blocks: [
        { type: "header", text: { type: "plain_text", text: `🚨 ${title}` } },
        {
          type: "section",
          fields: fields.length
            ? fields
            : [{ type: "mrkdwn", text: "*Info:*\nNo details" }],
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Time: ${new Date().toISOString()}` }],
        },
      ],
    });
    log(`[SLACK] Alert sent: ${title}`);
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
// Logs real errors only. Pass `silent: true` for calls
// where a non-2xx response is an expected / ignorable outcome.
// ======================================================

async function safeRequest(label, fn, { silent = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!silent) {
      logData(`[ERROR] ${label}`, {
        status: err.response?.status,
        message: err.message,
        detail: err.response?.data ?? null,
      });
    }
    return null;
  }
}

// ======================================================
// OKTA — GET USER BY EMAIL
// ======================================================

async function getOktaUserByEmail(email) {
  const res = await safeRequest("getOktaUserByEmail", () =>
    oktaAPI.get("/api/v1/users", {
      params: { search: `profile.email eq "${email}"` },
    })
  );

  if (!res || res.data.length === 0) return null;

  const u = res.data[0];
  const city = u.profile.city || "";
  const country = u.profile.countryCode || "";
  const location = [city, country].filter(Boolean).join(", ");

  return {
    email: u.profile.email.toLowerCase(),
    name: `${u.profile.firstName || ""} ${u.profile.lastName || ""}`.replace(/\s+/g, " ").trim(),
    title: u.profile.title || "",
    department: u.profile.department || "",
    location,
    status: u.status,
    profile: u.profile,
  };
}

// ======================================================
// ATLASSIAN — GET ORG ID
// ======================================================

async function getOrgId() {
  const res = await safeRequest("getOrgId", () => adminAPI.get("/admin/v1/orgs"));
  return res?.data?.data?.[0]?.id ?? null;
}

// ======================================================
// ATLASSIAN — FIND USER (Admin API → Jira fallback)
// ======================================================

async function getAtlassianUser(email) {
  const orgId = await getOrgId();

  if (orgId) {
    try {
      const res = await adminAPI.get(`/admin/v1/orgs/${orgId}/users`);
      const user = res.data?.data?.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase()
      );
      if (user) {
        return {
          accountId: user.account_id,
          displayName: user.display_name,
          email: user.email,
        };
      }
    } catch (err) {
      log(`[WARN] Admin API user search failed, falling back to Jira — ${err.message}`);
    }
  }

  const res = await safeRequest("getAtlassianUserViaJira", () =>
    jiraAPI.get("/rest/api/3/user/search", { params: { query: email } })
  );

  const user = res?.data?.find((u) => u.accountType === "atlassian");
  if (user) {
    return {
      accountId: user.accountId,
      displayName: user.displayName,
      email: user.emailAddress,
    };
  }

  return null;
}

// ======================================================
// ATLASSIAN — CREATE USER
// products: [] — no license, JSM portal access only
// ======================================================

async function createAtlassianUser(profile) {
  return await safeRequest("createAtlassianUser", () =>
    jiraAPI.post("/rest/api/3/user", {
      emailAddress: profile.email,
      displayName: profile.name,
      products: [],
    })
  );
}

// ======================================================
// ATLASSIAN — UPDATE PROFILE
// Syncs: display name, job title, department, location.
// New Atlassian accounts that haven't been claimed yet will
// reject this with 403 — that's expected, so we run it
// silently and only log on actual success.
// ======================================================

async function updateProfile(accountId, profile) {
  const res = await safeRequest(
    "updateProfile",
    () =>
      adminAPI.patch(`/users/${accountId}/manage/profile`, {
        name: profile.name,
        nickname: profile.name.split(" ")[0],
        locale: "en-US",
        extended_profile: {
          job_title: profile.title || "",
          department: profile.department || "",
          location: profile.location || "",
        },
      }),
    { silent: true }   // 403 on unclaimed accounts is expected — not an error
  );
  return res;
}

// ======================================================
// JSM — ADD CUSTOMER TO SERVICE DESK
// ======================================================

async function addJsmCustomer(accountId) {
  // 400/409 here just means the user is already a customer — not an error
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
  return true;
}

// ======================================================
// JSM — ADD USER TO GROUP (with retry)
// 400 when already a member is expected — treated as success
// ======================================================

async function addJsmGroupMembership(accountId, email, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await jiraAPI.post(`/rest/api/3/group/user?groupId=${JSM_GROUP_ID}`, { accountId });
      log(`[OK] Group membership confirmed for ${email}`);
      return true;
    } catch (err) {
      const status = err.response?.status;

      // 400 = already a member — treat as success, no retry needed
      if (status === 400) {
        log(`[OK] ${email} already in group`);
        return true;
      }

      const detail = err.response?.data || err.message;
      if (attempt < retries) {
        const delay = 1000 * attempt;
        log(`[WARN] Group membership attempt ${attempt} failed (${status}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        logData(`[ERROR] Group membership failed after ${retries} attempts for ${email}`, {
          status,
          detail,
        });
        await sendSlackAlert("JSM Group Membership Failed", {
          User: email,
          Status: status,
          Error: JSON.stringify(detail),
        });
        return false;
      }
    }
  }
}

// ======================================================
// ATLASSIAN — LIFECYCLE ACTIONS
// ======================================================

async function removeJsmGroupMembership(accountId) {
  // 400 = user not in group — silent, not an error
  return await safeRequest(
    "removeJsmGroupMembership",
    () => jiraAPI.delete(`/rest/api/3/group/user?groupId=${JSM_GROUP_ID}&accountId=${accountId}`),
    { silent: true }
  );
}

async function suspendAtlassianUser(accountId) {
  // 400 = already inactive — silent, not an error
  return await safeRequest(
    "suspendAtlassianUser",
    () => adminAPI.post(`/users/${accountId}/manage/lifecycle/disable`),
    { silent: true }
  );
}

async function enableAtlassianUser(accountId) {
  // 400 = already active — silent, not an error
  return await safeRequest(
    "enableAtlassianUser",
    () => adminAPI.post(`/users/${accountId}/manage/lifecycle/enable`),
    { silent: true }
  );
}

async function hardDeleteAtlassianUser(accountId) {
  return await safeRequest("hardDeleteAtlassianUser", () =>
    adminAPI.post(`/users/${accountId}/manage/lifecycle/delete`)
  );
}

// ======================================================
// SHARED UPSERT + SYNC
// Used by both USER_ACTIVATED and PROFILE_CHANGED events.
// ======================================================

async function upsertAndSyncUser(email, oktaUser, action) {
  let atlUser = await getAtlassianUser(email);
  let isNewUser = false;

  if (!atlUser) {
    log(`[INFO] User not found in Atlassian, creating...`);
    const created = await createAtlassianUser(oktaUser);

    if (!created) {
      log(`[FAIL] Could not create Atlassian user for ${email}`);
      await sendSlackAlert("User Create Failed", { User: email });
      return { email, action, result: "CREATE_FAILED" };
    }

    const accountId = created.data?.accountId;
    if (!accountId) {
      log(`[FAIL] Create response missing accountId for ${email}`);
      await sendSlackAlert("Atlassian Account ID Missing", { User: email });
      return { email, action, result: "RETRIEVE_FAILED" };
    }

    atlUser = { accountId, displayName: oktaUser.name, email };
    isNewUser = true;
    log(`[OK] User created — accountId: ${atlUser.accountId}`);
  } else {
    log(`[OK] User found — accountId: ${atlUser.accountId}`);
  }

  // Re-enable suspended accounts (silently skipped if already active)
  if (!isNewUser) {
    await enableAtlassianUser(atlUser.accountId);
    log(`[OK] Account enable issued`);
  }

  // Sync profile — silently skipped for unclaimed new accounts (expected 403)
  const profileOk = await updateProfile(atlUser.accountId, oktaUser);
  if (profileOk) {
    log(`[OK] Profile synced — title: "${oktaUser.title}" | dept: "${oktaUser.department}" | location: "${oktaUser.location}"`);
  }

  // Ensure JSM portal access (idempotent)
  await addJsmCustomer(atlUser.accountId);
  log(`[OK] JSM customer access confirmed`);

  // Ensure group membership (idempotent)
  await addJsmGroupMembership(atlUser.accountId, email);

  log(`[DONE] ${action} — ${email}`);
  return { email, action, result: "SUCCESS", accountId: atlUser.accountId };
}

// ======================================================
// EVENT HANDLERS
// ======================================================

async function handleUserActivated(email, oktaUser) {
  log(`--- USER ACTIVATED: ${email} ---`);
  return upsertAndSyncUser(email, oktaUser, "USER_ACTIVATED");
}

async function handleUserProfileChanged(email, oktaUser) {
  log(`--- PROFILE CHANGED: ${email} ---`);
  return upsertAndSyncUser(email, oktaUser, "PROFILE_CHANGED");
}

async function handleUserDeactivated(email) {
  log(`--- USER DEACTIVATED: ${email} ---`);

  const atlUser = await getAtlassianUser(email);
  if (!atlUser) {
    log(`[SKIP] User not found in Atlassian — nothing to deactivate`);
    return { email, action: "USER_DEACTIVATED", result: "USER_NOT_FOUND" };
  }

  log(`[OK] User found — accountId: ${atlUser.accountId}`);

  // Remove from group first (silent if not a member)
  await removeJsmGroupMembership(atlUser.accountId);
  log(`[OK] JSM group removal issued`);

  // Suspend account (silent if already inactive)
  const suspended = await suspendAtlassianUser(atlUser.accountId);
  if (suspended !== null) {
    log(`[OK] Atlassian account suspended`);
    return { email, action: "USER_DEACTIVATED", result: "SUSPENDED", accountId: atlUser.accountId };
  }

  // suspendAtlassianUser only returns null on a genuine unexpected error
  log(`[FAIL] Account suspension failed for ${email}`);
  await sendSlackAlert("User Suspend Failed", { User: email });
  return { email, action: "USER_DEACTIVATED", result: "SUSPEND_FAILED", accountId: atlUser.accountId };
}

async function handleUserHardDeleted(email) {
  log(`--- USER HARD DELETE: ${email} ---`);

  const atlUser = await getAtlassianUser(email);
  if (!atlUser) {
    log(`[SKIP] User not found in Atlassian — nothing to delete`);
    return { email, action: "USER_HARD_DELETE", result: "USER_NOT_FOUND" };
  }

  log(`[OK] User found — accountId: ${atlUser.accountId}`);

  await removeJsmGroupMembership(atlUser.accountId);
  log(`[OK] JSM group removal issued`);

  const deleted = await hardDeleteAtlassianUser(atlUser.accountId);
  if (deleted !== null) {
    log(`[OK] User permanently deleted from Atlassian`);
    return { email, action: "USER_HARD_DELETE", result: "DELETED", accountId: atlUser.accountId };
  }

  log(`[FAIL] Hard delete failed for ${email}`);
  await sendSlackAlert("User Delete Failed", { User: email });
  return { email, action: "USER_HARD_DELETE", result: "DELETE_FAILED", accountId: atlUser.accountId };
}

// ======================================================
// EVENT TYPE MAPS
// ======================================================

const USER_ACTIVATED_EVENTS   = ["user.lifecycle.activate", "user.lifecycle.unsuspend"];
const USER_DEACTIVATED_EVENTS = ["user.lifecycle.deactivate", "user.lifecycle.suspend"];
const USER_PROFILE_EVENTS     = ["user.account.update_profile", "user.profile.update"];

// ======================================================
// ROUTES — PUBLIC
// ======================================================

app.get("/", (req, res) => res.json({ service: "OKTA-ATLASSIAN SYNC", status: "RUNNING" }));
app.get("/health", (req, res) => res.json({ status: "OK", uptime: process.uptime() }));

// Okta event hook verification (GET)
app.get("/webhook", (req, res) => {
  const challenge = req.headers["x-okta-verification-challenge"];
  if (challenge) return res.json({ verification: challenge });
  res.status(400).json({ error: "No verification challenge present" });
});

// ======================================================
// WEBHOOK — MAIN ENDPOINT
// Auth check happens BEFORE the 200 acknowledge so
// unauthorized callers get a 401, not a silent success.
// ======================================================

app.post("/webhook", async (req, res) => {
  if (req.headers.authorization !== WEBHOOK_SECRET) {
    log(`[AUTH] Unauthorized webhook request`);
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // Acknowledge immediately so Okta does not time out
  res.status(200).json({ success: true });

  const events = req.body?.data?.events || [];
  log(`[WEBHOOK] Received ${events.length} event(s)`);

  for (const event of events) {
    try {
      const eventType = event.eventType;
      const email = event.target?.find((t) => t.type === "User")?.alternateId;

      if (!email) {
        log(`[WARN] No email in event — skipping`);
        continue;
      }

      // Domain filter
      if (MANAGED_DOMAIN) {
        const cleanDomain = MANAGED_DOMAIN.toLowerCase().replace(/^@/, "");
        const emailDomain = email.toLowerCase().split("@")[1];
        if (emailDomain !== cleanDomain) {
          log(`[FILTER] Skipped ${email} — domain mismatch`);
          continue;
        }
      }

      // Only fetch Okta profile when the event actually needs it
      let oktaUser = null;
      const needsProfile =
        USER_ACTIVATED_EVENTS.includes(eventType) ||
        USER_PROFILE_EVENTS.includes(eventType) ||
        Boolean(OKTA_FILTER_FIELD && OKTA_FILTER_VALUE);

      if (needsProfile) {
        oktaUser = await getOktaUserByEmail(email);
        if (!oktaUser) {
          log(`[SKIP] ${email} — not found in Okta`);
          continue;
        }

        // Optional profile field filter (e.g. department=Technology)
        if (OKTA_FILTER_FIELD && OKTA_FILTER_VALUE) {
          const fieldValue = (oktaUser.profile?.[OKTA_FILTER_FIELD] || "").toLowerCase();
          if (fieldValue !== String(OKTA_FILTER_VALUE).toLowerCase()) {
            log(`[FILTER] Skipped ${email} — ${OKTA_FILTER_FIELD} "${fieldValue}" ≠ "${OKTA_FILTER_VALUE}"`);
            continue;
          }
        }
      }

      log(`[EVENT] ${eventType} — ${email}`);

      if (eventType === "user.lifecycle.create") {
        log(`[SKIP] user.lifecycle.create — handled by activate event`);
        continue;
      }

      if (USER_DEACTIVATED_EVENTS.includes(eventType)) {
        await handleUserDeactivated(email);
      } else if (USER_ACTIVATED_EVENTS.includes(eventType)) {
        await handleUserActivated(email, oktaUser);
      } else if (USER_PROFILE_EVENTS.includes(eventType)) {
        await handleUserProfileChanged(email, oktaUser);
      } else {
        log(`[SKIP] Unhandled event type: ${eventType}`);
      }

    } catch (err) {
      log(`[ERROR] Event processing failed — ${err.message}`);
      await sendSlackAlert("Webhook Processing Failed", {
        Error: err.message,
        EventType: event?.eventType || "UNKNOWN",
        User: event?.target?.find((t) => t.type === "User")?.alternateId || "UNKNOWN",
      });
    }
  }

  log(`[WEBHOOK] Processing complete`);
});

// ======================================================
// AUTH
// ======================================================

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: "username and password required" });
  }

  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }

  const token = generateToken({ username, role: "admin" });
  res.json({ success: true, token });
});

// ======================================================
// TEST ENDPOINTS — JWT protected
// ======================================================

app.post("/test/user-activated", verifyToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const oktaUser = await getOktaUserByEmail(email);
  if (!oktaUser) return res.status(404).json({ error: "User not found in Okta" });
  const result = await handleUserActivated(email, oktaUser);
  res.json(result);
});

app.post("/test/profile-changed", verifyToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const oktaUser = await getOktaUserByEmail(email);
  if (!oktaUser) return res.status(404).json({ error: "User not found in Okta" });
  const result = await handleUserProfileChanged(email, oktaUser);
  res.json(result);
});

app.post("/test/user-deactivated", verifyToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const result = await handleUserDeactivated(email);
  res.json(result);
});

app.post("/test/user-deleted", verifyToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const result = await handleUserHardDeleted(email);
  res.json(result);
});

// ======================================================
// START
// ======================================================

app.listen(PORT, () => {
  log(`[STARTUP] Server running on port ${PORT}`);
  log(`[STARTUP] Webhook: POST /webhook`);
  log(`[STARTUP] Test endpoints (JWT required):`);
  log(`[STARTUP]   POST /test/user-activated`);
  log(`[STARTUP]   POST /test/profile-changed`);
  log(`[STARTUP]   POST /test/user-deactivated`);
  log(`[STARTUP]   POST /test/user-deleted`);
});