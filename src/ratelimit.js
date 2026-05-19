const requestCounts = new Map();
const MAX_REQUESTS_PER_MINUTE = 60;
const WINDOW_MS = 60 * 1000; // 1 minuto

export function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }

  const timestamps = requestCounts.get(ip).filter((t) => now - t < WINDOW_MS);

  if (timestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
    });
  }

  timestamps.push(now);
  requestCounts.set(ip, timestamps);

  next();
}

// Limpiar requests viejas cada 5 minutos
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, timestamps] of requestCounts.entries()) {
      const filtered = timestamps.filter((t) => now - t < WINDOW_MS);
      if (filtered.length === 0) {
        requestCounts.delete(ip);
      } else {
        requestCounts.set(ip, filtered);
      }
    }
  },
  5 * 60 * 1000
);

export default rateLimit;
