function authenticate(req, res, next) {
  const session = req.sessions.get(req.headers['x-session']);
  if (!session) return res.status(401).end();
  req.user = session;
  next();
}
function requireAdministrator(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).end();
  next();
}
function requireOwner(req, res, next) {
  if (req.params.owner !== req.user.id) return res.status(403).end();
  next();
}
module.exports = { authenticate, requireAdministrator, requireOwner };
