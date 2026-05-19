export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.timestamp = new Date().toISOString();
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message) {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ClaudeAPIError extends AppError {
  constructor(message, originalError) {
    super(message, 503);
    this.name = 'ClaudeAPIError';
    this.originalError = originalError;
  }
}

export function handleError(error, res) {
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: {
      name: error.name || 'Error',
      message,
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
    },
  });
}
