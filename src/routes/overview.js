// Section overview pages: /microsoft, /cloudflare, /inventory and /call-switch-one, one card per
// sub-section with live numbers (src/lib/overview.js, views/overview.ejs). Mounted in index.js
// before the section routers, so these exact addresses land here.
const express = require('express');
const { overview, SECTIONS } = require('../lib/overview');

const router = express.Router();

for (const [key, s] of Object.entries(SECTIONS)) {
  router.get(s.path, async (req, res) => {
    const data = await overview(key);
    res.render('overview', { title: data.title, nav: s.nav, section: data });
  });
}

module.exports = router;
