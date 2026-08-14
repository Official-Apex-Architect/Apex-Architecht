const express = require('express');
const path = require('path');
const adminRouter = require('./routes/admin');

const app = express();
app.use('/admin', adminRouter);
app.use(express.static(path.join(__dirname, 'Apex Arcitecht')));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Apex Architect server running on http://localhost:${port}`);
    console.log(`Admin portal running on http://localhost:${port}/admin`);
  });
}

module.exports = app;
