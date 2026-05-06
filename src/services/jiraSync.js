const pool = require('../db/connection');
const bcrypt = require('bcryptjs');
const { fetchProjectMembers } = require('./jiraService');

// Email mapping for Jira members who don't expose email via API
const EMAIL_MAP = {
  'sarathi': 'sarathi@aibond.ai',
  'sreevidya a': 'sreevidya@aibond.ai',
  'n tamil amirtham': 'tamil@aibond.ai',
  'gurukarthikeyan': 'guru@memstech.com',
  'team lead': 'teamlead@aibond.ai',
};

/**
 * Resolves email for a Jira member — uses Jira email if available,
 * otherwise falls back to the manual EMAIL_MAP.
 */
function resolveEmail(displayName, jiraEmail) {
  if (jiraEmail) return jiraEmail;
  return EMAIL_MAP[displayName.toLowerCase()] || null;
}

/**
 * Syncs engineers from Jira project into local drivers + users tables.
 * Called automatically on server startup.
 * Non-blocking: server continues even if Jira sync fails.
 */
async function syncEngineersFromJira() {
  try {
    console.log('[Jira Sync] Starting engineer sync from Jira...');

    const members = await fetchProjectMembers();

    if (!members || members.length === 0) {
      console.log('[Jira Sync] No members found in Jira project. Skipping sync.');
      return { success: false, message: 'No members found' };
    }

    const defaultPassword = await bcrypt.hash('engineer123', 10);
    const results = { added: 0, updated: 0, skipped: 0 };

    for (const member of members) {
      const { accountId, displayName, emailAddress } = member;
      const email = resolveEmail(displayName, emailAddress);

      // Skip members without a resolved email (can't create login)
      if (!email) {
        console.log(`[Jira Sync] Skipping ${displayName} — no email mapped`);
        results.skipped++;
        continue;
      }

      try {
        // Check if driver already exists by jira_account_id
        const existingDriver = await pool.query(
          'SELECT id FROM drivers WHERE jira_account_id = $1',
          [accountId]
        );

        if (existingDriver.rows.length > 0) {
          // Update existing driver with latest Jira info
          await pool.query(
            'UPDATE drivers SET name = $1, email = $2 WHERE jira_account_id = $3',
            [displayName, email, accountId]
          );
          results.updated++;
        } else {
          // Check if driver exists by name (in case of manual entry)
          const existingByName = await pool.query(
            'SELECT id FROM drivers WHERE LOWER(name) = LOWER($1)',
            [displayName]
          );

          if (existingByName.rows.length > 0) {
            // Link existing driver to Jira account
            await pool.query(
              'UPDATE drivers SET jira_account_id = $1, email = $2 WHERE id = $3',
              [accountId, email, existingByName.rows[0].id]
            );
            results.updated++;
          } else {
            // Insert new driver from Jira
            await pool.query(
              "INSERT INTO drivers (name, email, jira_account_id, status) VALUES ($1, $2, $3, 'Available')",
              [displayName, email, accountId]
            );
            results.added++;
          }
        }

        // Upsert into users table (for login)
        const existingUser = await pool.query(
          'SELECT id FROM users WHERE email = $1',
          [email]
        );

        if (existingUser.rows.length === 0) {
          await pool.query(
            "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'engineer')",
            [displayName, email, defaultPassword]
          );
        } else {
          await pool.query(
            'UPDATE users SET name = $1 WHERE email = $2',
            [displayName, email]
          );
        }

        console.log(`[Jira Sync] Synced: ${displayName} (${email})`);
      } catch (memberErr) {
        console.error(`[Jira Sync] Error syncing member ${displayName}:`, memberErr.message);
        results.skipped++;
      }
    }

    console.log(`[Jira Sync] Complete. Added: ${results.added}, Updated: ${results.updated}, Skipped: ${results.skipped} (Total from Jira: ${members.length})`);
    return { success: true, ...results, totalFromJira: members.length };
  } catch (err) {
    console.error('[Jira Sync] Failed to sync engineers from Jira:', err.message);
    console.log('[Jira Sync] Server will continue without Jira engineer data.');
    return { success: false, error: err.message };
  }
}

module.exports = { syncEngineersFromJira };
