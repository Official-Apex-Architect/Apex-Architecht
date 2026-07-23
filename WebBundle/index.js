const express = require('express');
const adminRouter = require('./routes/admin');

const app = express();
app.use('/admin', adminRouter);

app.get('/', (req, res) => {
  res.send('Apex Architect admin workspace is running.');
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Admin workspace running on http://localhost:${port}/admin`);
  });
}

module.exports = app;
