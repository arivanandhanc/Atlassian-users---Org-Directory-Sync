import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ======================================================
// ENV
// ======================================================

const {
  ATLASSIAN_ADMIN_TOKEN,
  ATLASSIAN_DOMAIN,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
} = process.env;

// ======================================================
// CHANGE ONLY THIS
// ======================================================

const TEST_EMAIL = "test@arivanandhan.in";

// ======================================================
// BASIC AUTH
// ======================================================

const basicAuth = Buffer.from(
  `${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`
).toString("base64");

// ======================================================
// JIRA API
// ======================================================

const jiraAPI = axios.create({
  baseURL: `https://${ATLASSIAN_DOMAIN}`,
  timeout: 30000,
  headers: {
    Authorization: `Basic ${basicAuth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

// ======================================================
// ADMIN API
// ======================================================

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
// FIND USER
// ======================================================

async function getAtlassianUser(email) {

  try {

    const res = await jiraAPI.get(
      "/rest/api/3/user/search",
      {
        params: {
          query: email,
        },
      }
    );

    const user = res.data?.find(
      (u) => u.accountType === "atlassian"
    );

    if (!user) {

      console.log("");
      console.log("=================================");
      console.log("USER NOT FOUND");
      console.log("=================================");

      return null;
    }

    console.log("");
    console.log("=================================");
    console.log("USER FOUND");
    console.log("=================================");

    console.log("Account ID:", user.accountId);
    console.log("Display Name:", user.displayName);

    return user;

  } catch (err) {

    console.log("");
    console.log("=================================");
    console.log("SEARCH FAILED");
    console.log("=================================");

    console.log("STATUS:",
      err.response?.status
    );

    console.log("");

    console.log("DATA:");
    console.log(
      JSON.stringify(err.response?.data, null, 2)
    );

    console.log("");

    console.log("MESSAGE:");
    console.log(err.message);

    return null;
  }
}

// ======================================================
// PROFILE UPDATE TEST
// ======================================================

async function updateProfile(accountId) {

  try {

    const response = await adminAPI.patch(
      `/users/${accountId}/manage/profile`,
      {
        name: "PROFILE TEST USER",
        locale: "en-US",

        extended_profile: {
          job_title: "IAM Engineer",
          department: "Technology",
          location: "Dubai, UAE",
        },
      }
    );

    console.log("");
    console.log("=================================");
    console.log("PROFILE UPDATE SUCCESS");
    console.log("=================================");
    console.log("");

    console.log(response.data);

  } catch (err) {

    console.log("");
    console.log("=================================");
    console.log("PROFILE UPDATE FAILED");
    console.log("=================================");
    console.log("");

    console.log("STATUS:",
      err.response?.status
    );

    console.log("");

    console.log("ERROR DATA:");
    console.log(
      JSON.stringify(err.response?.data, null, 2)
    );

    console.log("");

    console.log("MESSAGE:");
    console.log(err.message);
  }
}

// ======================================================
// RUN
// ======================================================

async function run() {

  console.log("");
  console.log("=================================");
  console.log("ATLASSIAN PROFILE TEST");
  console.log("=================================");

  const user = await getAtlassianUser(TEST_EMAIL);

  if (!user) {
    return;
  }

  await updateProfile(user.accountId);
}

run();