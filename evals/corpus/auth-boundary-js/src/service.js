function createService(database) {
  return {
    async exportAccounts() {
      return database.query('SELECT id, email FROM accounts');
    },
    async profile(id) {
      return database.query('SELECT id, email FROM accounts WHERE id = $1', [id]);
    },
    async rename(id, name) {
      return database.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, id]);
    }
  };
}
module.exports = { createService };
