// Minimal database wrapper — simulates a pg pool
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/app',
});

module.exports = {
  query: (text, params) => pool.query(text, params).then(r => r.rows[0]),
  queryAll: (text, params) => pool.query(text, params).then(r => r.rows),
};
