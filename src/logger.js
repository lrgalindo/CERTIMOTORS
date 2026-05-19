const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'];

function formatLog(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const levelPad = level.padEnd(7);
  const dataStr = Object.keys(data).length ? JSON.stringify(data) : '';
  return `[${ts}] ${levelPad}: ${msg} ${dataStr}`;
}

export const logger = {
  error(msg, data) {
    if (currentLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLog('ERROR', `❌ ${msg}`, data));
    }
  },
  warn(msg, data) {
    if (currentLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLog('WARN', `⚠️  ${msg}`, data));
    }
  },
  info(msg, data) {
    if (currentLevel >= LOG_LEVELS.INFO) {
      console.log(formatLog('INFO', `ℹ️  ${msg}`, data));
    }
  },
  debug(msg, data) {
    if (currentLevel >= LOG_LEVELS.DEBUG) {
      console.log(formatLog('DEBUG', `🐛 ${msg}`, data));
    }
  },
  success(msg, data) {
    if (currentLevel >= LOG_LEVELS.INFO) {
      console.log(formatLog('INFO', `✅ ${msg}`, data));
    }
  },
};

export default logger;
