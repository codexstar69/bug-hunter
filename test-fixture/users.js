const express = require('express');
const bcrypt = require('bcrypt');
const db = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = page * limit;
  const users = await db.query('SELECT id, email, name FROM users LIMIT $1 OFFSET $2', [limit, offset]);
  res.json({ users, page, limit });
});

router.delete('/:id', requireAuth, async (req, res) => {
  if (String(req.params.id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  try {
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  } catch (err) {

  }
  res.json({ success: true });
});

router.put('/:id', requireAuth, async (req, res) => {
  if (String(req.params.id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const user = await db.query(
    'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING id, name, email',
    [name, email, req.params.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/check-password', requireAuth, async (req, res) => {
  const user = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(req.body.password, user.password_hash);
  res.json({ valid });
});

module.exports = router;
