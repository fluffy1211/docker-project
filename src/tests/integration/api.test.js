jest.mock('../../models/task');
jest.mock('../../db', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

const request = require('supertest');
const app = require('../../app');
const Task = require('../../models/task');

beforeEach(() => {
  jest.resetAllMocks();
});

describe('GET /health', () => {
  test('returns ok status', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('POST /api/tasks', () => {
  test('creates task with valid description', async () => {
    const created = { id: '1', description: 'buy milk', status: 'pending' };
    Task.create.mockResolvedValue(created);

    const res = await request(app).post('/api/tasks').send({ description: 'buy milk' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(Task.create).toHaveBeenCalledWith('buy milk');
  });

  test('rejects missing description', async () => {
    const res = await request(app).post('/api/tasks').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('description is required');
    expect(Task.create).not.toHaveBeenCalled();
  });

  test('rejects non-string description', async () => {
    const res = await request(app).post('/api/tasks').send({ description: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('description is required');
  });

  test('rejects description over max length', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'a'.repeat(1001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 1000 characters/);
    expect(Task.create).not.toHaveBeenCalled();
  });

  test('passes through errors to error handler', async () => {
    Task.create.mockRejectedValue(new Error('db down'));

    const res = await request(app).post('/api/tasks').send({ description: 'buy milk' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });
});

describe('GET /api/tasks', () => {
  test('returns all tasks', async () => {
    const tasks = [{ id: '1' }, { id: '2' }];
    Task.findAll.mockResolvedValue(tasks);

    const res = await request(app).get('/api/tasks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(tasks);
  });
});

describe('GET /api/tasks/:id', () => {
  test('returns task when found', async () => {
    const task = { id: '1', description: 'buy milk' };
    Task.findById.mockResolvedValue(task);

    const res = await request(app).get('/api/tasks/1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(task);
    expect(Task.findById).toHaveBeenCalledWith('1');
  });

  test('returns 404 when not found', async () => {
    Task.findById.mockResolvedValue(undefined);

    const res = await request(app).get('/api/tasks/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });
});

describe('PUT /api/tasks/:id', () => {
  test('updates task when found', async () => {
    const updated = { id: '1', description: 'new', status: 'done' };
    Task.update.mockResolvedValue(updated);

    const res = await request(app)
      .put('/api/tasks/1')
      .send({ description: 'new', status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(Task.update).toHaveBeenCalledWith('1', { description: 'new', status: 'done' });
  });

  test('returns 404 when not found', async () => {
    Task.update.mockResolvedValue(null);

    const res = await request(app).put('/api/tasks/missing').send({ status: 'done' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });
});

describe('DELETE /api/tasks/:id', () => {
  test('deletes task when found', async () => {
    Task.remove.mockResolvedValue(true);

    const res = await request(app).delete('/api/tasks/1');

    expect(res.status).toBe(204);
    expect(Task.remove).toHaveBeenCalledWith('1');
  });

  test('returns 404 when not found', async () => {
    Task.remove.mockResolvedValue(false);

    const res = await request(app).delete('/api/tasks/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });
});

describe('malformed JSON body', () => {
  test('returns 400 with parse error message', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{invalid json');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Malformed JSON body');
  });
});
