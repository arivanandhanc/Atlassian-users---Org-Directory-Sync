import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ======================================================
// ENV
// ======================================================

const {
  OKTA_DOMAIN,
  OKTA_TOKEN,
  ATLASSIAN_ADMIN_TOKEN,
} = process.env;

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

const adminAPI = axios.create({
  baseURL: "https://api.atlassian.com",
  headers: {
    Authorization: `Bearer ${ATLASSIAN_ADMIN_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

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
// GET ATLASSIAN USER
// ======================================================

async function getAtlassianUserByEmail(email) {

  try {

    const searchRes =
      await adminAPI.get(
        "/admin/v1/orgs"
      );

    const orgId =
      searchRes.data?.data?.[0]?.id;

    const usersRes =
      await adminAPI.get(
        `/admin/v1/orgs/${orgId}/users`
      );

    const user =
      usersRes.data.data.find(
        (u) =>
          u.email?.toLowerCase() ===
          email.toLowerCase()
      );

    return user || null;

  } catch (err) {

    console.log(
      `Failed finding Atlassian user: ${email}`
    );

    return null;
  }
}

// ======================================================
// UPDATE PROFILE
// ======================================================

async function updateProfile(
  accountId,
  profile
) {

  try {

    await adminAPI.patch(
      `/users/${accountId}/manage/profile`,
      {
        locale: "en-US",

        extended_profile: {

          job_title:
            profile.job_title || "",

          department:
            profile.department || "",

          location:
            profile.location || "",
        },
      }
    );

    return true;

  } catch (err) {

    console.log("");
    console.log(
      `PROFILE UPDATE FAILED: ${profile.email}`
    );

    console.log(
      err.response?.status
    );

    console.log(
      JSON.stringify(
        err.response?.data,
        null,
        2
      )
    );

    return false;
  }
}

// ======================================================
// RUN
// ======================================================

async function run() {

  try {

    console.log("");
    console.log("=================================");
    console.log("START SYNC");
    console.log("=================================");

    const oktaUsers =
      await getOktaUsers();

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const oktaUser of oktaUsers) {

      console.log("");
      console.log(
        `Processing: ${oktaUser.email}`
      );

      const atlUser =
        await getAtlassianUserByEmail(
          oktaUser.email
        );

      if (!atlUser) {

        console.log(
          "User not found in Atlassian"
        );

        skipped++;

        continue;
      }

      const updated =
        await updateProfile(
          atlUser.account_id,
          oktaUser
        );

      if (updated) {

        success++;

        console.log("SYNCED");

        console.log(
          `job_title: ${oktaUser.job_title}`
        );

        console.log(
          `department: ${oktaUser.department}`
        );

        console.log(
          `location: ${oktaUser.location}`
        );

      } else {

        failed++;
      }
    }

    console.log("");
    console.log("=================================");
    console.log("SYNC COMPLETE");
    console.log("=================================");
    console.log("");

    console.log(
      `SUCCESS : ${success}`
    );

    console.log(
      `FAILED : ${failed}`
    );

    console.log(
      `SKIPPED : ${skipped}`
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