const https = require('https');
require('dotenv').config();

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || 'https://api.atlassian.com';
const JIRA_CLOUD_ID = process.env.JIRA_CLOUD_ID;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'FO';
const JIRA_ISSUE_TYPE_ID = process.env.JIRA_ISSUE_TYPE_ID || '10168';

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

function jiraRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${JIRA_BASE_URL}/ex/jira/${JIRA_CLOUD_ID}${path}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            reject({ status: res.statusCode, ...parsed });
          } else {
            resolve({ status: res.statusCode, data: parsed });
          }
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Search JIRA users by email to get their accountId
async function findUserByEmail(email) {
  const res = await jiraRequest('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  if (res.data && res.data.length > 0) {
    return res.data[0];
  }
  return null;
}

// Create a JIRA ticket for a vehicle reservation task
async function createTaskTicket({ driverName, vehicleRegNo, vehicleType, startDate, startTime, endDate, endTime, source, destination, purpose, assigneeAccountId }) {
  const summary = `[Fleet Task] ${vehicleRegNo} - ${driverName} | ${startDate}`;

  const descriptionLines = [
    `*Vehicle:* ${vehicleRegNo} (${vehicleType})`,
    `*Driver/Engineer:* ${driverName}`,
    `*Date:* ${startDate} to ${endDate}`,
    `*Time:* ${startTime} to ${endTime}`,
    `*Route:* ${source} → ${destination}`,
    purpose ? `*Purpose:* ${purpose}` : '',
    '',
    '---',
    '*Instructions:*',
    '1. Log start mileage before driving',
    '2. Perform V&V drive as per route',
    '3. Log end mileage after drive',
    '4. Add any notes or observations',
    '',
    '_This task was auto-created by the Fleet Management System_',
  ].filter(Boolean);

  const body = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: descriptionLines.map((line) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: line }],
        })),
      },
      issuetype: { id: JIRA_ISSUE_TYPE_ID },
    },
  };

  if (assigneeAccountId) {
    body.fields.assignee = { accountId: assigneeAccountId };
  }

  const res = await jiraRequest('POST', '/rest/api/3/issue', body);
  return res.data;
}

// Update a JIRA ticket with trip completion data
async function updateTicketWithTripData(issueKey, { startMileage, endMileage, actualStartTime, actualEndTime, notes, status }) {
  const commentLines = [
    `*Trip ${status || 'Completed'}*`,
    '',
    `*Start Mileage:* ${startMileage || 'N/A'} km`,
    `*End Mileage:* ${endMileage || 'N/A'} km`,
    `*Total Distance:* ${startMileage && endMileage ? (endMileage - startMileage).toFixed(1) : 'N/A'} km`,
    '',
    `*Actual Start:* ${actualStartTime || 'N/A'}`,
    `*Actual End:* ${actualEndTime || 'N/A'}`,
    notes ? `*Notes:* ${notes}` : '',
    '',
    '_Auto-updated by Fleet Management System_',
  ].filter(Boolean);

  await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: commentLines.map((line) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: line }],
      })),
    },
  });

  return { success: true };
}

// Transition a JIRA issue (e.g., move to Done)
async function transitionIssue(issueKey, transitionName) {
  const transitionsRes = await jiraRequest('GET', `/rest/api/3/issue/${issueKey}/transitions`);
  const transition = transitionsRes.data.transitions?.find(
    (t) => t.name.toLowerCase() === transitionName.toLowerCase()
  );

  if (transition) {
    await jiraRequest('POST', `/rest/api/3/issue/${issueKey}/transitions`, {
      transition: { id: transition.id },
    });
    return { success: true, transitionId: transition.id };
  }

  return { success: false, message: `Transition "${transitionName}" not found` };
}

// Get issue details
async function getIssue(issueKey) {
  const res = await jiraRequest('GET', `/rest/api/3/issue/${issueKey}`);
  return res.data;
}

// Fetch all members/users assigned to the project
async function fetchProjectMembers() {
  const members = [];
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const res = await jiraRequest(
      'GET',
      `/rest/api/3/user/assignable/search?project=${JIRA_PROJECT_KEY}&startAt=${startAt}&maxResults=${maxResults}`
    );

    if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
      break;
    }

    for (const user of res.data) {
      // Skip bot/app accounts and inactive users
      if (user.accountType !== 'atlassian' || !user.active) continue;

      members.push({
        accountId: user.accountId,
        displayName: user.displayName,
        emailAddress: user.emailAddress || null,
        avatarUrl: user.avatarUrls?.['48x48'] || null,
        active: user.active,
      });
    }

    if (res.data.length < maxResults) break;
    startAt += maxResults;
  }

  return members;
}

// Auto-detect issue type ID for the current project
async function getIssueTypeForProject(preferredType = 'Task') {
  const res = await jiraRequest('GET', `/rest/api/3/project/${JIRA_PROJECT_KEY}`);
  const issueTypes = res.data?.issueTypes || [];

  // Try to find the preferred type (Task), fallback to first non-subtask
  const match = issueTypes.find(
    (t) => t.name.toLowerCase() === preferredType.toLowerCase() && !t.subtask
  );

  if (match) return match.id;

  const fallback = issueTypes.find((t) => !t.subtask);
  return fallback ? fallback.id : JIRA_ISSUE_TYPE_ID;
}

module.exports = {
  findUserByEmail,
  createTaskTicket,
  updateTicketWithTripData,
  transitionIssue,
  getIssue,
  jiraRequest,
  fetchProjectMembers,
  getIssueTypeForProject,
};
