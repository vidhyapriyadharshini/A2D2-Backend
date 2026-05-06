const nodemailer = require('nodemailer');
require('dotenv').config();

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter = null;

if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  transporter.verify()
    .then(() => console.log('Email service ready'))
    .catch((err) => console.error('Email service not available:', err.message));
} else {
  console.log('Email service not configured - set SMTP_USER and SMTP_PASS in .env');
}

async function sendTaskAssignmentEmail({ to, driverName, vehicleRegNo, vehicleType, startDate, startTime, endDate, endTime, source, destination, purpose, jiraKey }) {
  if (!transporter) {
    console.log('Email skipped (not configured) - would send to:', to);
    return { skipped: true, reason: 'Email service not configured' };
  }

  const subject = `Fleet Task Assigned: ${vehicleRegNo} | ${startDate}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1a73e8; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">Fleet Task Assignment</h2>
        <p style="margin: 5px 0 0; opacity: 0.9;">You have been assigned a new vehicle task</p>
      </div>

      <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e0e0e0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555; width: 140px;">Vehicle</td>
            <td style="padding: 8px 12px;">${vehicleRegNo} (${vehicleType})</td>
          </tr>
          <tr style="background: white;">
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Driver / Engineer</td>
            <td style="padding: 8px 12px;">${driverName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Start</td>
            <td style="padding: 8px 12px;">${startDate} at ${startTime}</td>
          </tr>
          <tr style="background: white;">
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">End</td>
            <td style="padding: 8px 12px;">${endDate} at ${endTime}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Route</td>
            <td style="padding: 8px 12px;">${source} &rarr; ${destination}</td>
          </tr>
          ${purpose ? `
          <tr style="background: white;">
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Purpose</td>
            <td style="padding: 8px 12px;">${purpose}</td>
          </tr>` : ''}
          ${jiraKey ? `
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">JIRA Ticket</td>
            <td style="padding: 8px 12px;">
              <a href="${process.env.JIRA_SITE_URL}/browse/${jiraKey}" style="color: #1a73e8; text-decoration: none; font-weight: bold;">${jiraKey}</a>
              <span style="color: #888; font-size: 12px;"> — Click to open in JIRA</span>
            </td>
          </tr>` : ''}
        </table>
      </div>

      <div style="background: #fff3cd; padding: 15px 20px; border: 1px solid #e0e0e0; border-top: none;">
        <strong>Instructions:</strong>
        <ol style="margin: 8px 0 0; padding-left: 20px; color: #555;">
          <li>Log start mileage before driving</li>
          <li>Perform V&V drive as per route</li>
          <li>Log end mileage after drive</li>
          <li>Add any notes or observations</li>
        </ol>
      </div>

      <div style="padding: 15px 20px; color: #888; font-size: 12px; text-align: center; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
        This is an automated email from the Fleet Management System
      </div>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Fleet Management - AIBOND" <${SMTP_FROM}>`,
    to,
    subject,
    html,
  });

  console.log('Email sent to', to, '- Message ID:', info.messageId);
  return { success: true, messageId: info.messageId };
}

async function sendTripCompletionEmail({ to, driverName, vehicleRegNo, source, destination, startMileage, endMileage, jiraKey }) {
  if (!transporter) {
    console.log('Email skipped (not configured) - would send to:', to);
    return { skipped: true, reason: 'Email service not configured' };
  }

  const distance = startMileage && endMileage ? (endMileage - startMileage).toFixed(1) : 'N/A';

  const subject = `Trip Completed: ${vehicleRegNo} | ${source} to ${destination}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #28a745; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">Trip Completed</h2>
        <p style="margin: 5px 0 0; opacity: 0.9;">The following trip has been marked as completed</p>
      </div>

      <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e0e0e0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555; width: 140px;">Vehicle</td>
            <td style="padding: 8px 12px;">${vehicleRegNo}</td>
          </tr>
          <tr style="background: white;">
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Driver / Engineer</td>
            <td style="padding: 8px 12px;">${driverName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Route</td>
            <td style="padding: 8px 12px;">${source} &rarr; ${destination}</td>
          </tr>
          <tr style="background: white;">
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">Distance</td>
            <td style="padding: 8px 12px;">${distance} km</td>
          </tr>
          ${jiraKey ? `
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #555;">JIRA Ticket</td>
            <td style="padding: 8px 12px;">${jiraKey} (moved to Done)</td>
          </tr>` : ''}
        </table>
      </div>

      <div style="padding: 15px 20px; color: #888; font-size: 12px; text-align: center; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
        This is an automated email from the Fleet Management System
      </div>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Fleet Management - AIBOND" <${SMTP_FROM}>`,
    to,
    subject,
    html,
  });

  console.log('Completion email sent to', to, '- Message ID:', info.messageId);
  return { success: true, messageId: info.messageId };
}

module.exports = {
  sendTaskAssignmentEmail,
  sendTripCompletionEmail,
};
