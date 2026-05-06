require('dotenv').config();
const { syncFleetPage, isConfigured } = require('../src/services/confluenceService');

(async () => {
  if (!isConfigured()) {
    console.error('Confluence is not configured. Set CONFLUENCE_BASE_URL, CONFLUENCE_PARENT_PAGE_ID, and credentials (CONFLUENCE_EMAIL/CONFLUENCE_API_TOKEN, falling back to JIRA_EMAIL/JIRA_API_TOKEN) in .env.');
    process.exit(1);
  }
  console.log('Starting Confluence backfill...');
  const result = await syncFleetPage();
  if (result?.ok) {
    console.log('Backfill complete.');
    process.exit(0);
  } else if (result?.skipped) {
    console.warn('Backfill skipped — not configured.');
    process.exit(1);
  } else {
    console.error('Backfill failed:', result?.error || 'unknown error');
    process.exit(1);
  }
})();
