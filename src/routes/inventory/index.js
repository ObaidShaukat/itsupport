// Inventory: Cleartwo's own staff, equipment and accounts (not linked to clients).
const express = require('express');

const router = express.Router();

// Which Inventory sub-tab is active.
const TABS = [
  ['people', '/inventory/people', 'People'],
  ['former', '/inventory/former', 'Former Employees'],
  ['assets', '/inventory/assets', 'Assets'],
  ['stock', '/inventory/stock', 'Stock'],
  ['access', '/inventory/access', 'Access'],
  ['reports', '/inventory/reports', 'Reports'],
  ['import', '/inventory/import', 'Import'],
  ['settings', '/inventory/settings', 'Lists & fields'],
];
router.use((req, res, next) => {
  const segment = req.path.split('/')[1] || 'people';
  res.locals.invTabs = TABS.map(([key, href, label]) => ({ key, href, label }));
  res.locals.invTab = segment === 'offboarding' ? 'former' : segment;
  next();
});

router.get('/', (req, res) => res.redirect('/inventory/people'));
router.use(require('./people'));
router.use(require('./assets'));
router.use(require('./stock'));
router.use(require('./access'));
router.use(require('./reports'));
router.use(require('./settings'));
router.use(require('./import'));

module.exports = router;
