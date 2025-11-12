// src/utils/logger.js
module.exports = {
  log: (message, data = null) => {
    console.log(`[${new Date().toISOString()}] ${message}`, data || '');
  },
  error: (message, err) => {
    const errorMsg =
      err instanceof Error
        ? err.stack || err.message
        : typeof err === "string"
        ? err
        : JSON.stringify(err, null, 2);
    console.error(`[${new Date().toISOString()}] ${message}`, errorMsg);
  },
};
