import { createDeviceGrantService, routeWithDeviceGrant } from './deviceGrants.mjs';
import { createSyncV6Service } from './syncV6.mjs';
import { createTaskKeyRecoveryService } from './taskKeyRecovery.mjs';
import { createS3ObjectStore } from './objectStore.mjs';
import { createFileObjectService } from './fileObjects.mjs';
import { databaseContractFromQuery } from '../../../../src/shared/databaseEvolutionContract.js';

export { createDeviceGrantService, routeWithDeviceGrant } from './deviceGrants.mjs';

export function registerSyncRoutes({ app, pool, auth, route, apiError, env = process.env, objectStore = null }) {
  const grants = createDeviceGrantService({
    pool,
    apiError,
    approvalMode: String(env.JANUS_DEVICE_APPROVAL_MODE || 'automatic').trim().toLowerCase(),
  });
  const sync = createSyncV6Service({ pool, apiError, env });
  const taskKeys = createTaskKeyRecoveryService({ pool, apiError, env });
  const files = createFileObjectService({ pool, objectStore: objectStore || createS3ObjectStore({ env }), apiError, env });

  app.post('/api/device-grants/register', auth, route(async (req, res) => {
    const device = await grants.register({ userId: req.auth.user.id, input: req.body || {} });
    res.status(device.status === 'approved' ? 201 : 202).json(device);
  }));

  app.get('/api/device-grants', auth, route(async (req, res) => {
    res.json({ items: await grants.list({ userId: req.auth.user.id }) });
  }));

  app.post('/api/device-grants/:deviceId/approve', routeWithDeviceGrant(pool, apiError, 'devices:approve', async (req, res) => {
    res.json(await grants.approve({ userId: req.deviceGrant.userId, actorDeviceId: req.deviceGrant.deviceId, targetDeviceId: req.params.deviceId }));
  }));

  app.delete('/api/device-grants/:deviceId', routeWithDeviceGrant(pool, apiError, 'devices:approve', async (req, res) => {
    res.json(await grants.revoke({ userId: req.deviceGrant.userId, actorDeviceId: req.deviceGrant.deviceId, targetDeviceId: req.params.deviceId }));
  }));

  app.post('/api/device-grants/:deviceId/token', auth, route(async (req, res) => {
    const result = await grants.issueToken({
      userId: req.auth.user.id, deviceId: req.params.deviceId, requestedScopes: req.body?.scopes, ttlDays: req.body?.ttlDays,
      proof: req.body?.proof,
    });
    res.status(201).json(result);
  }));

  app.get('/v1/sync/v6/capabilities', routeWithDeviceGrant(pool, apiError, 'sync:read', async (req, res) => {
    res.json({ ...sync.capabilities(databaseContractFromQuery(req.query || {})), files: files.capabilities() });
  }));

  app.post('/v1/sync/v6/batches', routeWithDeviceGrant(pool, apiError, 'sync:write', async (req, res) => {
    const result = await sync.submitBatch(req.deviceGrant, req.body || {});
    res.status(result.conflictCount ? 207 : 202).json(result);
  }));

  app.get('/v1/sync/v6/changes', routeWithDeviceGrant(pool, apiError, 'sync:read', async (req, res) => {
    res.json(await sync.changes(req.deviceGrant, {
      cursor: req.query.cursor,
      limit: req.query.limit,
      accountId: req.query.accountId || req.query.account_id,
      clientContract: databaseContractFromQuery(req.query || {}),
    }));
  }));

  app.get('/v1/sync/v6/metrics', routeWithDeviceGrant(pool, apiError, 'sync:read', async (req, res) => {
    res.json(await sync.metrics(req.deviceGrant, { accountId: req.query.accountId || req.query.account_id }));
  }));

  app.post('/v1/sync/v6/task-keys/rewrap', routeWithDeviceGrant(pool, apiError, 'sync:keys', async (req, res) => {
    res.json(await taskKeys.rewrap(req.deviceGrant, req.body || {}));
  }));

  app.post('/v1/sync/v6/files/initiate', routeWithDeviceGrant(pool, apiError, 'sync:files', async (req, res) => {
    res.status(201).json(await files.initiate(req.deviceGrant, req.body || {}));
  }));
  app.post('/v1/sync/v6/files/complete', routeWithDeviceGrant(pool, apiError, 'sync:files', async (req, res) => {
    res.json(await files.complete(req.deviceGrant, req.body || {}));
  }));
  app.get('/v1/sync/v6/files/:sha256/download', routeWithDeviceGrant(pool, apiError, 'sync:files', async (req, res) => {
    res.json(await files.download(req.deviceGrant, req.params.sha256));
  }));

  return grants;
}
