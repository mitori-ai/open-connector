const defaultRecordMaxResponseBytes = 20 * 1024 * 1024;
let recordMaxResponseBytes = defaultRecordMaxResponseBytes;

/** Configure the deployment-wide limit without eagerly loading SmartSuite executors. */
export function configureSmartsuiteRecordResponseLimit(value: string | undefined): void {
  const parsed = value === undefined ? defaultRecordMaxResponseBytes : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("OOMOL_CONNECT_SMARTSUITE_RECORD_MAX_RESPONSE_BYTES must be a positive safe integer");
  }
  recordMaxResponseBytes = parsed;
}

/** Maximum bytes accepted from a SmartSuite record-list response. */
export function getSmartsuiteRecordMaxResponseBytes(): number {
  return recordMaxResponseBytes;
}
