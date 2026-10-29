const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('./db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, role: user.role }, 'super-secret-key-123');
  res.json({ token });
});

// Auth middleware
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(token, 'super-secret-key-123');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/admin/users', requireAuth, async (req, res) => {
  if (req.user.role == true) {
    const users = await db.query('SELECT id, email, role FROM users');
    res.json(users);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

router.get('/profile', requireAuth, async (req, res) => {
  const user = await db.query('SELECT id, email, name FROM users WHERE id = $1', [req.user.id]);
  res.json(user);
});

module.exports = { router, requireAuth };
