const express = require('express');
const bcrypt = require('bcrypt');
const db = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

// BUG 4 (Medium/Logic): Off-by-one in pagination — skips the first result
router.get('/', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = page * limit; // Should be (page - 1) * limit
  const users = await db.query('SELECT id, email, name FROM users LIMIT $1 OFFSET $2', [limit, offset]);
  res.json({ users, page, limit });
});

// BUG 5 (Low/Error-handling): deleteUser doesn't check if user exists before deleting,
// and swallows the error silently — caller gets 200 even if delete failed
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  } catch (err) {
    // silently swallowed
  }
  res.json({ success: true });
});

router.put('/:id', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const user = await db.query(
    'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING id, name, email',
    [name, email, req.params.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// BUG 6 (Medium/Security): bcrypt.compare with non-string input
// If password is a number or object from JSON body, bcrypt.compare may behave unexpectedly
router.post('/check-password', requireAuth, async (req, res) => {
  const user = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // req.body.password could be a number, boolean, or object from JSON parsing
  // Does bcrypt.compare handle non-string inputs safely or throw?
  const valid = await bcrypt.compare(req.body.password, user.password_hash);
  res.json({ valid });
});

module.exports = router;
