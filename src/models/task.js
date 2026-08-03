const { pool } = require('../db');

async function create(description) {
  const { rows } = await pool.query(
    'INSERT INTO tasks (description) VALUES ($1) RETURNING *',
    [description]
  );
  return rows[0];
}

async function findAll() {
  const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at');
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0];
}

async function update(id, data) {
  const task = await findById(id);
  if (!task) return null;
  const description = data.description !== undefined ? data.description : task.description;
  const status = data.status !== undefined ? data.status : task.status;
  const { rows } = await pool.query(
    'UPDATE tasks SET description = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *',
    [description, status, id]
  );
  return rows[0];
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { create, findAll, findById, update, remove };
