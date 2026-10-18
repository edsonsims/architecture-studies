const nonblank = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
export const headers = {
  type: 'object', required: ['x-tenant-id'],
  properties: { 'x-tenant-id': nonblank(128) },
};
export const submissionHeaders = {
  type: 'object', required: ['x-tenant-id', 'idempotency-key'],
  properties: { 'x-tenant-id': nonblank(128), 'idempotency-key': nonblank(128) },
};
export const noQuery = { type: 'object', additionalProperties: false, properties: {} };
export const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: nonblank(128) } };
export const emptyBody = { type: 'object', additionalProperties: false, properties: {} };
export const submissionBody = {
  type: 'object', additionalProperties: false, required: ['documentName'], properties: { documentName: nonblank(255) },
};
export const completeBody = {
  type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } },
};
export const failBody = {
  type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: nonblank(1024) },
};
export const job = {
  type: 'object', additionalProperties: false,
  required: ['id', 'tenantId', 'documentName', 'state', 'attemptCount', 'text', 'failure', 'version'],
  properties: {
    id: { type: 'string' }, tenantId: { type: 'string' }, documentName: { type: 'string' },
    state: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] },
    attemptCount: { type: 'integer', minimum: 0 }, version: { type: 'integer', minimum: 1 },
    text: { type: ['string', 'null'] }, failure: { type: ['string', 'null'] },
  },
};
