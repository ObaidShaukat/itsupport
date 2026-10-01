const TICKET_STATUSES = {
  open: 'Open',
  customer_waiting: 'Customer Waiting',
  closed: 'Closed',
};

const isTicketStatus = (value) => typeof value === 'string' && Object.hasOwn(TICKET_STATUSES, value);

module.exports = { TICKET_STATUSES, isTicketStatus };
