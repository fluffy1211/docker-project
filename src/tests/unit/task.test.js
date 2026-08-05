jest.mock('../../db', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../../db');
const Task = require('../../models/task');

beforeEach(() => {
  pool.query.mockReset();
});

describe('Task.create', () => {
  test('inserts description and returns created row', async () => {
    const row = { id: '1', description: 'buy milk', status: 'pending' };
    pool.query.mockResolvedValue({ rows: [row] });

    const result = await Task.create('buy milk');

    expect(pool.query).toHaveBeenCalledWith(
      'INSERT INTO tasks (description) VALUES ($1) RETURNING *',
      ['buy milk']
    );
    expect(result).toEqual(row);
  });
});

describe('Task.findAll', () => {
  test('returns all rows ordered by created_at', async () => {
    const rows = [{ id: '1' }, { id: '2' }];
    pool.query.mockResolvedValue({ rows });

    const result = await Task.findAll();

    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM tasks ORDER BY created_at');
    expect(result).toEqual(rows);
  });
});

describe('Task.findById', () => {
  test('returns matching row', async () => {
    const row = { id: '1', description: 'buy milk' };
    pool.query.mockResolvedValue({ rows: [row] });

    const result = await Task.findById('1');

    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM tasks WHERE id = $1', ['1']);
    expect(result).toEqual(row);
  });

  test('returns undefined when no row matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await Task.findById('missing');

    expect(result).toBeUndefined();
  });
});

describe('Task.update', () => {
  test('returns null when task does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await Task.update('missing', { description: 'new' });

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('merges provided fields with existing task and updates', async () => {
    const existing = { id: '1', description: 'old', status: 'pending' };
    const updated = { id: '1', description: 'new', status: 'pending' };
    pool.query
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [updated] });

    const result = await Task.update('1', { description: 'new' });

    expect(pool.query).toHaveBeenNthCalledWith(2,
      'UPDATE tasks SET description = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *',
      ['new', 'pending', '1']
    );
    expect(result).toEqual(updated);
  });

  test('keeps existing values when field not provided', async () => {
    const existing = { id: '1', description: 'old', status: 'pending' };
    pool.query
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [existing] });

    await Task.update('1', {});

    expect(pool.query).toHaveBeenNthCalledWith(2,
      'UPDATE tasks SET description = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *',
      ['old', 'pending', '1']
    );
  });
});

describe('Task.remove', () => {
  test('returns true when a row was deleted', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });

    const result = await Task.remove('1');

    expect(pool.query).toHaveBeenCalledWith('DELETE FROM tasks WHERE id = $1', ['1']);
    expect(result).toBe(true);
  });

  test('returns false when no row was deleted', async () => {
    pool.query.mockResolvedValue({ rowCount: 0 });

    const result = await Task.remove('missing');

    expect(result).toBe(false);
  });
});
