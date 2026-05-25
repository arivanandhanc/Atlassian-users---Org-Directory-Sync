import dotenv from "dotenv";
import axios from "axios";
import XLSX from "xlsx";

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
} = process.env;

// ======================================================
// TIMESTAMP
// ======================================================

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-");

// ======================================================
// API CLIENTS
// ======================================================

const oktaAPI = axios.create({
  baseURL: OKTA_DOMAIN,
  headers: {
    Authorization: `SSWS ${OKTA_TOKEN}`,
    Accept: "application/json",
  },
});

const basicAuth = Buffer.from(
  `${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`
).toString("base64");

const jiraAPI = axios.create({
  baseURL: `https://${ATLASSIAN_DOMAIN}`,
  headers: {
    Authorization: `Basic ${basicAuth}`,
    Accept: "application/json",
  },
});

const adminAPI = axios.create({
  baseURL: "https://api.atlassian.com",
  headers: {
    Authorization: `Bearer ${ATLASSIAN_ADMIN_TOKEN}`,
    Accept: "application/json",
  },
});

// ======================================================
// GET ORG ID
// ======================================================

async function getOrgId() {

  const res = await adminAPI.get(
    "/admin/v1/orgs"
  );

  return res.data?.data?.[0]?.id;
}

// ======================================================
// GET OKTA USERS
// ======================================================

async function getOktaUsers() {

  console.log("");
  console.log("Fetching Okta users...");

  const res = await oktaAPI.get(
    "/api/v1/users"
  );

  return res.data.map((u) => ({

    email:
      u.profile.email?.toLowerCase() || "",

    job_title:
      u.profile.title || "",

    department:
      u.profile.department || "",

    location:
      [
        u.profile.city || "",
        u.profile.countryCode || "",
      ]
        .filter(Boolean)
        .join(", "),

  }));
}

// ======================================================
// GET ATLASSIAN USERS
// ======================================================

async function getAtlassianUsers() {

  console.log("");
  console.log("Fetching Atlassian users...");

  const orgId = await getOrgId();

  const res = await adminAPI.get(
    `/admin/v1/orgs/${orgId}/users`
  );

  const users = [];

  for (const u of res.data.data) {

    try {

      const profileRes =
        await axios.get(
          `https://api.atlassian.com/users/${u.account_id}/manage/profile`,
          {
            headers: {
              Authorization:
                `Bearer ${ATLASSIAN_ADMIN_TOKEN}`,
              Accept: "application/json",
            },
          }
        );

      // ==================================================
      // IMPORTANT FIX
      // ==================================================

      const p =
        profileRes.data.account;

      users.push({

        email:
          p.email?.toLowerCase() || "",

        job_title:
          p.extended_profile?.job_title || "",

        department:
          p.extended_profile?.department || "",

        location:
          p.extended_profile?.location || "",

      });

      console.log(
        `Fetched profile: ${p.email}`
      );

    } catch (err) {

      console.log(
        `Profile fetch failed: ${u.email}`
      );

      users.push({

        email:
          u.email?.toLowerCase() || "",

        job_title: "",

        department: "",

        location: "",

      });
    }
  }

  return users;
}

// ======================================================
// EXPORT EXCEL
// ======================================================

function exportExcel(
  data,
  fileName
) {

  const worksheet =
    XLSX.utils.json_to_sheet(data);

  const workbook =
    XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    "Data"
  );

  XLSX.writeFile(
    workbook,
    fileName
  );

  console.log(
    `Exported: ${fileName}`
  );
}

// ======================================================
// COMPARE
// ======================================================

function compareUsers(
  oktaUsers,
  atlUsers
) {

  const differences = [];

  for (const okta of oktaUsers) {

    const atl = atlUsers.find(
      (a) => a.email === okta.email
    );

    // ================================================
    // USER MISSING
    // ================================================

    if (!atl) {

      differences.push({

        email:
          okta.email,

        field:
          "USER",

        okta:
          "EXISTS",

        atlassian:
          "MISSING",

      });

      continue;
    }

    // ================================================
    // JOB TITLE
    // ================================================

    if (
      okta.job_title !==
      atl.job_title
    ) {

      differences.push({

        email:
          okta.email,

        field:
          "job_title",

        okta:
          okta.job_title,

        atlassian:
          atl.job_title,

      });
    }

    // ================================================
    // DEPARTMENT
    // ================================================

    if (
      okta.department !==
      atl.department
    ) {

      differences.push({

        email:
          okta.email,

        field:
          "department",

        okta:
          okta.department,

        atlassian:
          atl.department,

      });
    }

    // ================================================
    // LOCATION
    // ================================================

    if (
      okta.location !==
      atl.location
    ) {

      differences.push({

        email:
          okta.email,

        field:
          "location",

        okta:
          okta.location,

        atlassian:
          atl.location,

      });
    }
  }

  return differences;
}

// ======================================================
// RUN
// ======================================================

async function run() {

  try {

    console.log("");
    console.log("=================================");
    console.log("START");
    console.log("=================================");

    // ================================================
    // FETCH USERS
    // ================================================

    const oktaUsers =
      await getOktaUsers();

    const atlUsers =
      await getAtlassianUsers();

    // ================================================
    // EXPORT RAW FILES
    // ================================================

    exportExcel(
      oktaUsers,
      `okta-users-${timestamp}.xlsx`
    );

    exportExcel(
      atlUsers,
      `atlassian-users-${timestamp}.xlsx`
    );

    // ================================================
    // COMPARE
    // ================================================

    const differences =
      compareUsers(
        oktaUsers,
        atlUsers
      );

    exportExcel(
      differences,
      `differences-${timestamp}.xlsx`
    );

    // ================================================
    // SUMMARY
    // ================================================

    console.log("");
    console.log("=================================");
    console.log("DONE");
    console.log("=================================");
    console.log("");

    console.log(
      `Okta Users: ${oktaUsers.length}`
    );

    console.log(
      `Atlassian Users: ${atlUsers.length}`
    );

    console.log(
      `Differences: ${differences.length}`
    );

    console.log("");

  } catch (err) {

    console.log("");
    console.log("=================================");
    console.log("FAILED");
    console.log("=================================");
    console.log("");

    console.log(
      err.response?.data || err.message
    );
  }
}

run();