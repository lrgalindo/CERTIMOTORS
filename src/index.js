import express from 'express';
import { initDB } from './db.js';
import { apiLimiter, healthEndpoint, requestLogger } from './middleware.js';
import logger from './logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(requestLogger);
app.use(apiLimiter);

// Health check (sin rate limit)
app.get('/health', healthEndpoint);

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: '✅ VIVO',
    api: 'CERTIMOTORS',
    database: 'Supabase PostgreSQL',
    claude: 'claude-opus-4-20250514',
    timestamp: new Date().toISOString(),
  });
});

// WhatsApp webhook (placeholder)
app.post('/webhook/whatsapp', (req, res) => {
  logger.info('WhatsApp webhook received', { body: req.body });
  res.json({ ok: true });
});

// Telegram webhook (placeholder)
app.post('/webhook/telegram', (req, res) => {
  logger.info('Telegram webhook received', { body: req.body });
  res.json({ ok: true });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function start() {
  try {
    await initDB();
    logger.info('✅ Base de datos inicializada (Supabase PostgreSQL)');
    logger.info(`✅ Claude API: claude-opus-4-20250514`);
    logger.info(`✅ Node.js: ${process.version}`);
    logger.info(`✅ Environment: ${process.env.NODE_ENV || 'production'}`);

    app.listen(PORT, () => {
      logger.info(`🚀 Backend listening on port ${PORT}`, {
        url: `http://localhost:${PORT}`,
        health: `http://localhost:${PORT}/health`,
        status: `http://localhost:${PORT}/status`,
      });
      logger.info('✅ CERTIMOTORS activated');
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();
