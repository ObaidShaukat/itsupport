// Desktop notifications (Web Push) with the web-push package and the VAPID keys in .env
// (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT). Each browser a user turns them
// on in is a push_subscriptions row; the service worker (public/sw.js) shows the
// notification and opens the ticket when it is clicked, even with the portal tab in the
// background or closed (as long as the browser is running). Only users with "desktop"
// in notify_channels get them. Subscriptions the push service reports as gone (404 /
// 410) are deleted. Sending never throws.
const webpush = require('web-push');
const { pool } = require('../db');

let setup = null; // true, or the reason it failed

function pushStatus() {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = process.env;
  if (!publicKey || !privateKey || !subject) {
    return {
      enabled: false,
      message: 'Desktop notifications are off: add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT to .env (generate the keys with: npx web-push generate-vapid-keys).',
    };
  }
  if (setup === null) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      setup = true;
    } catch (err) {
      setup = err.message;
    }
  }
  if (setup !== true) return { enabled: false, message: `Desktop notifications are off: ${setup} (check the VAPID settings in .env).` };
  return { enabled: true, publicKey };
}

const trim = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Sends { title, body, url, tag } to every browser of the user (if they chose desktop).
// Returns how many were delivered.
async function pushToUser(userId, { title, body, url, tag }, db = pool) {
  if (!pushStatus().enabled) return 0;
  let subs;
  try {
    [subs] = await db.query(`
      SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
      JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? AND FIND_IN_SET('desktop', u.notify_channels)
    `, [userId]);
  } catch (err) {
    console.error('Desktop notifications: could not read subscriptions:', err.message);
    return 0;
  }
  const payload = JSON.stringify({
    title: trim(title, 120) || 'Cleartwo IT Support', body: trim(body, 240), url: url || '/', tag: tag || undefined,
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 60 * 60, urgency: 'high' });
      sent += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id = ?', [s.id]).catch(() => {});
      } else {
        console.error('Desktop notification failed:', err.statusCode || '', err.message);
      }
    }
  }
  return sent;
}

// The same message to several users; errors are logged, never thrown.
async function pushToUsers(userIds, message) {
  for (const id of [...new Set(userIds)]) {
    try {
      await pushToUser(id, message);
    } catch (err) {
      console.error('Desktop notification failed:', err.message);
    }
  }
}

module.exports = { pushStatus, pushToUser, pushToUsers };
