const { authenticate, requireAdministrator, requireOwner } = require('./auth');
const { createService } = require('./service');

function routes(router, database, sessions) {
  const service = createService(database);
  router.use((req, res, next) => {
    req.sessions = sessions;
    next();
  });
  router.get('/profile', authenticate, async (req, res) => {
    res.json(await service.profile(req.user.id));
  });
  router.put('/accounts/:owner', authenticate, requireOwner, async (req, res) => {
    if (typeof req.body.name !== 'string') return res.status(400).end();
    res.json(await service.rename(req.params.owner, req.body.name));
  });
  router.get('/admin/audit', authenticate, requireAdministrator, async (req, res) => {
    res.json(await database.query('SELECT * FROM audit_events'));
  });

  router.get('/admin/export', authenticate, async (req, res) => {
    const accounts = await service.exportAccounts();
    res.json(accounts);
  });
  return router;
}
module.exports = routes;
