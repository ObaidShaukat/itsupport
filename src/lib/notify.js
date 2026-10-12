// How reminders, @mentions and "added to a reminder" reach a user: any combination of
// popup (in the portal), email and desktop (Web Push), stored in users.notify_channels
// as e.g. "popup,email,desktop". SQL filters use FIND_IN_SET('email', u.notify_channels).
const NOTIFY_CHANNELS = {
  popup: 'Popup in the portal',
  email: 'Email',
  desktop: 'Desktop notification',
};
const DEFAULT_CHANNELS = 'popup,email,desktop';

// Set of the user's channels (from a users row with notify_channels).
function channelsOf(user) {
  const raw = user && typeof user.notify_channels === 'string' ? user.notify_channels : DEFAULT_CHANNELS;
  return new Set(raw.split(',').map((c) => c.trim()).filter((c) => Object.hasOwn(NOTIFY_CHANNELS, c)));
}

// Channels ticked in a form (notify_channels, one value or several), in a fixed order.
function readChannels(value) {
  const ticked = new Set([].concat(value || []).map(String));
  return Object.keys(NOTIFY_CHANNELS).filter((c) => ticked.has(c));
}

const channelLabel = (list) => (list.length ? list.map((c) => NOTIFY_CHANNELS[c]).join(', ') : 'none');

module.exports = { NOTIFY_CHANNELS, DEFAULT_CHANNELS, channelsOf, readChannels, channelLabel };
