require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 5009;

app.get('/', (req, res) => {
  res.send('testing');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
