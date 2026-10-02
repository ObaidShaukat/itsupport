const TICKET_STATUSES = {
  open: 'Open',
  customer_waiting: 'Customer Waiting',
  closed: 'Closed',
};

// Most to least urgent is urgent, high, normal, low; normal is the default.
const TICKET_PRIORITIES = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

const isTicketStatus = (value) => typeof value === 'string' && Object.hasOwn(TICKET_STATUSES, value);
const isTicketPriority = (value) => typeof value === 'string' && Object.hasOwn(TICKET_PRIORITIES, value);

module.exports = { TICKET_STATUSES, TICKET_PRIORITIES, PRIORITY_ORDER, isTicketStatus, isTicketPriority };
