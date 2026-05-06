const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { fetchProjectMembers, getIssueTypeForProject } = require('../services/jiraService');
const bcrypt = require('bcryptjs');

// POST /api/sync/jira-engineers — Sync engineers from Jira PFD project into local DB
router.post('/jira-engineers', async (req, res) => {
  try {
    const members = await fetchProjectMembers();

    if (!members || members.length === 0) {
      return res.status(404).json({
        message: 'No members found in Jira project. Make sure engineers are added to the project in Jira.',
      });
    }

    const results = { added: 0, updated: 0, skipped: 0, details: [] };
    const defaultPassword = await bcrypt.hash('engineer123', 10);

    for (const member of members) {
      const { accountId, displayName, emailAddress } = member;

      try {
        // Check if driver already exists by jira_account_id
        const existingDriver = await pool.query(
          'SELECT id FROM drivers WHERE jira_account_id = $1',
          [accountId]
        );

        if (existingDriver.rows.length > 0) {
          // Update existing driver
          await pool.query(
            `UPDATE drivers SET name = $1, email = $2 WHERE jira_account_id = $3`,
            [displayName, emailAddress, accountId]
          );
          results.updated++;
          results.details.push({ name: displayName, action: 'updated' });
        } else {
          // Check if driver exists by name (from seed data)
          const existingByName = await pool.query(
            'SELECT id FROM drivers WHERE LOWER(name) = LOWER($1)',
            [displayName]
          );

          if (existingByName.rows.length > 0) {
            // Link existing driver to Jira account
            await pool.query(
              `UPDATE drivers SET jira_account_id = $1, email = $2 WHERE id = $3`,
              [accountId, emailAddress, existingByName.rows[0].id]
            );
            results.updated++;
            results.details.push({ name: displayName, action: 'linked' });
          } else {
            // Insert new driver
            await pool.query(
              `INSERT INTO drivers (name, email, jira_account_id, status) VALUES ($1, $2, $3, 'Available')`,
              [displayName, emailAddress, accountId]
            );
            results.added++;
            results.details.push({ name: displayName, action: 'added' });
          }
        }

        // Upsert into users table (for login)
        if (emailAddress) {
          const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [emailAddress]
          );

          if (existingUser.rows.length === 0) {
            await pool.query(
              `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'engineer')`,
              [displayName, emailAddress, defaultPassword]
            );
          } else {
            await pool.query(
              `UPDATE users SET name = $1 WHERE email = $2`,
              [displayName, emailAddress]
            );
          }
        }
      } catch (memberErr) {
        console.error(`Error syncing member ${displayName}:`, memberErr);
        results.skipped++;
        results.details.push({ name: displayName, action: 'error', error: memberErr.message });
      }
    }

    res.json({
      message: `Sync complete. Added: ${results.added}, Updated: ${results.updated}, Skipped: ${results.skipped}`,
      totalFromJira: members.length,
      ...results,
    });
  } catch (err) {
    console.error('Jira sync error:', err);
    res.status(500).json({ error: 'Failed to sync from Jira', details: err.message });
  }
});

// GET /api/sync/jira-engineers — Preview what would be synced (dry run)
router.get('/jira-engineers', async (req, res) => {
  try {
    const members = await fetchProjectMembers();
    res.json({
      message: `Found ${members.length} members in Jira project`,
      members,
    });
  } catch (err) {
    console.error('Jira fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch Jira members', details: err.message });
  }
});

// GET /api/sync/jira-issue-type — Auto-detect issue type for the project
router.get('/jira-issue-type', async (req, res) => {
  try {
    const issueTypeId = await getIssueTypeForProject();
    res.json({ issueTypeId });
  } catch (err) {
    console.error('Issue type detection error:', err);
    res.status(500).json({ error: 'Failed to detect issue type', details: err.message });
  }
});

module.exports = router;
