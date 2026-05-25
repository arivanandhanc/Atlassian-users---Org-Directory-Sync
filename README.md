# Atlassian Users — Org Directory Sync

A production-grade identity sync system that keeps **Okta and Atlassian Cloud in perfect alignment** — handling real-time webhook events, scheduled drift correction, and bulk profile propagation with full Slack observability.

---

## Overview

Enterprise teams managing users across Okta and Atlassian face constant drift — accounts active in one system but suspended in another, missing JSM portal access, and stale profile data. This system eliminates that drift automatically.

---

## Three-Mode Architecture

| Mode | File | Trigger |
|------|------|---------|
| Real-time webhook server | `server.js` | Okta event hook (instant) |
| Scheduled drift correction | `regularaccessysnce.js` | Cron / pipeline (every 12h) |
| Bulk profile propagation | `regularprofilesynce.js` | On demand / weekly |

---

## How It Works

### 1. Webhook Server (`server.js`)
- Registers as an Okta event hook endpoint
- Handles Okta's GET verification challenge automatically
- Processes `user.lifecycle.activate`, `deactivate`, `suspend`, `unsuspend`, and `user.account.update_profile` events in real time
- Upserts users in Atlassian — create, enable, suspend, add to JSM group and service desk
- JWT-protected test endpoints for safe manual testing
- Sends Slack alerts on failures

### 2. Scheduled Sync (`regularaccessysnce.js`)
- Pulls Okta audit logs for a configurable time window (default: 12h)
- Deduplicates to the **final state per user** — only the last event matters
- Fetches live Atlassian state (account status, group membership, JSM customer)
- Builds a three-table diff: Okta state → Atlassian state → delta
- Applies **only what's out of sync** — fully idempotent
- Prints full diff to logs before applying any changes
- Every run tagged with a unique **Run ID** across logs and Slack

### 3. Profile Sync (`regularprofilesynce.js`)
- Fetches all Okta users matching a configurable profile field filter
- Propagates name, job title, department, and location to Atlassian
- Uses Admin API for direct profile updates
- Safe to run repeatedly — skips users not found in Atlassian

---

## What Gets Synced

| Okta State | Atlassian Result |
|------------|-----------------|
| Active | Account enabled + JSM group + service desk customer |
| Inactive / Suspended | Account suspended + removed from JSM group |
| Profile updated | Display name, job title, department, location synced |

---

## Tech Stack

- **Node.js** — runtime
- **Okta API** — event hooks + audit logs + user profile
- **Atlassian Admin API** — account lifecycle (enable / disable)
- **Jira REST API** — user search + group membership
- **JSM Service Desk API** — customer provisioning
- **Express.js** — webhook server
- **JWT** — protected test endpoints
- **Slack Webhooks** — Block Kit alerts with Run ID tracing
- **dotenv** — environment-driven configuration
- **axios** — HTTP client

---

## Setup

### 1. Clone

```bash
git clone https://github.com/arivanandhanc/Atlassian-users---Org-Directory-Sync.git
cd Atlassian-users---Org-Directory-Sync
```

### 2. Install

```bash
npm install
```

### 3. Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
# Okta
OKTA_DOMAIN=https://your-org.okta.com
OKTA_TOKEN=your-okta-ssws-token

# Atlassian
ATLASSIAN_DOMAIN=your-org.atlassian.net
ATLASSIAN_EMAIL=admin@your-org.com
ATLASSIAN_API_TOKEN=your-api-token
ATLASSIAN_ADMIN_TOKEN=your-admin-token

# JSM
JSM_SERVICE_DESK_ID=1
JSM_GROUP_ID=your-group-id

# Webhook server
WEBHOOK_SECRET=your-webhook-secret
MANAGED_DOMAIN=your-org.com
JWT_SECRET=your-jwt-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password

# Scheduled sync
SYNC_API_KEY=your-32-char-minimum-key
SYNC_HOURS=12

# Profile sync filter
OKTA_FILTER_FIELD=department
OKTA_FILTER_VALUE=Technology

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

---

## Usage

### Run the webhook server
```bash
node server.js
```
Register `POST /webhook` as an Okta event hook in the Okta Admin console. The server handles the GET verification challenge automatically.

### Run the scheduled sync
```bash
node regularaccessysnce.js
```
Set `SYNC_HOURS` to control the lookback window. Schedule via cron or CI/CD for periodic drift correction.

### Run the profile sync
```bash
node regularprofilesynce.js
```
Syncs profile attributes for all users matching `OKTA_FILTER_FIELD` / `OKTA_FILTER_VALUE`.

---

## Test Endpoints

All test endpoints require a JWT token.

```bash
# 1. Get token
POST /auth/login
{ "username": "admin", "password": "your-password" }

# 2. Trigger test events
POST /test/user-activated    { "email": "user@your-org.com" }
POST /test/profile-changed   { "email": "user@your-org.com" }
POST /test/user-deactivated  { "email": "user@your-org.com" }
POST /test/user-deleted      { "email": "user@your-org.com" }
```

---

## Why Not Use Okta's Native Atlassian Connector?

Okta offers a first-party SCIM connector for Atlassian. It's the right choice for large enterprises already on a premium Okta tier. For mid-size teams it often isn't:

| | Native Okta Connector | This Build |
|--|----------------------|-----------|
| Cost | Requires Okta Identity Governance tier (~$6–12/user/month) | Server hosting only (~$5–20/month) |
| JSM control | No service desk or group targeting | Full JSM group + customer provisioning |
| Profile filtering | Not supported | Filter by any Okta profile field |
| Observability | Limited | Slack alerts + Run ID per execution |
| Best for | 500+ users, enterprise Okta | 50–500 users, mid-size companies |

---

## Security Notes

- Never commit `.env` — it is gitignored
- `SYNC_API_KEY` must be at least 32 characters (validated at startup)
- API key comparison uses `crypto.timingSafeEqual` to prevent timing attacks
- Test endpoints are protected by JWT with 1h expiry
- Rotate your Slack webhook URL if it is ever exposed

---

## License

MIT

---

## Sample Sync Output
