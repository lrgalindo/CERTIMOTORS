export const logger = {
  info: (msg, data) => console.log(`[info] ${msg}`, data || ''),
  error: (msg, err) => console.error(`[error] ${msg}`, err || ''),
  warn: (msg, data) => console.warn(`[warn] ${msg}`, data || ''),
  success: (msg, data) => console.log(`[success] ${msg}`, data || ''),
  debug: (msg, data) => console.log(`[debug] ${msg}`, data || ''),
};
