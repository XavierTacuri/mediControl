'use strict';

function notFoundHandler(req, res) {
  res.status(404).json({ status: 'error', message: 'Resource not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = Number.isInteger(err.status)
    ? err.status
    : Number.isInteger(err.statusCode)
      ? err.statusCode
      : 500;

  const message = statusCode < 500 ? err.message : 'Internal server error';

  if (statusCode >= 500) {
    console.error(err);
  }

  const body = { status: 'error', message };
  if (statusCode < 500 && Array.isArray(err.details)) {
    body.details = err.details;
  }

  res.status(statusCode).json(body);
}

module.exports = { notFoundHandler, errorHandler };
