import 'dotenv/config.js';
import express from 'express';
import { initDB } from './db.js';
import { logger } from './logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: '✅ VIVO',
    service: 'certimotors-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', (req, res) => {
  res.json({
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

(async () => {
  try {
    await initDB();
    logger.info('✅ Base de datos inicializada');
    logger.info('✅ Claude API: claude-opus-4-20250514');
    logger.info('✅ Node.js: ' + process.version);
  } catch (err) {
    logger.error('Database init error', err);
    process.exit(1);
  }
})();

app.listen(PORT, () => {
  logger.info('🚀 Backend listening on port ' + PORT);
  logger.info('✅ CERTIMOTORS activated');
});

export default app;
