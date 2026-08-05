require('dotenv').config();
const express = require('express');
const cors = require('cors');
const taskRoutes = require('./routes/tasks');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.use('/api/tasks', taskRoutes);

app.use(errorHandler);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`app listening on http://localhost:${port}`));
}

module.exports = app;
// trivial change for verification
// ci-verify: missing-secret check
// ci-verify: misspelled DEPLOY_USER must fail cleanly
