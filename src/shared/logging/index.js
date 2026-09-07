export {
  applicationLoggingStatus,
  clearRotatedApplicationLogs,
  closeApplicationLogging,
  emitApplicationLog,
  exportApplicationLogs,
  flushApplicationLogs,
  getApplicationLogger,
  initializeApplicationLogging,
  resolveApplicationLogDirectory,
} from './applicationLogger.js';

export {
  diagnosticError,
  isSensitiveDiagnosticKey,
  newDiagnosticId,
  redactDiagnosticText,
  redactDiagnosticValue,
  sanitizeLogMetadata,
} from './redaction.js';
