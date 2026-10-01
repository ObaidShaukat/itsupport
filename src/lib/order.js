// Service steps keep the order they were added in (the process order matters).
async function nextStepPosition(conn, serviceId) {
  const [[row]] = await conn.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM service_steps WHERE service_id = ?',
    [serviceId]
  );
  return Number(row.pos);
}

module.exports = { nextStepPosition };
