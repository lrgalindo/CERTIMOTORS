export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class ClaudeAPIError extends AppError {
  constructor(message, cause) {
    super(message, 502);
    this.cause = cause;
  }
}

export function handleError(err, res) {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.message,
    status: 'error',
  });
}
