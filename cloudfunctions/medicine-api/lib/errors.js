"use strict";

class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new AppError(code, message, details);
}

function isAppError(error) {
  return error instanceof AppError;
}

module.exports = { AppError, fail, isAppError };
