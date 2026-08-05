const request = require('supertest');
const app = require('../../app');
const { pool, ready } = require('../../db');

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await pool.query('TRUNCATE tasks');
});

afterAll(async () => {
  await pool.end();
});

describe('Task lifecycle against a real database', () => {
  test('create then read by id returns exactly what was sent', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ description: 'buy milk' });

    expect(createRes.status).toBe(201);

    const readRes = await request(app).get(`/api/tasks/${createRes.body.id}`);

    expect(readRes.status).toBe(200);
    expect(readRes.body.id).toBe(createRes.body.id);
    expect(readRes.body.description).toBe('buy milk');
    expect(readRes.body.status).toBe('pending');
  });

  test('reading a task that does not exist returns a clean 404', async () => {
    const res = await request(app).get('/api/tasks/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });

  describe('invalid request bodies', () => {
    test('missing description is rejected with 400, nothing written', async () => {
      const res = await request(app).post('/api/tasks').send({});

      expect(res.status).toBe(400);

      const list = await request(app).get('/api/tasks');
      expect(list.body).toHaveLength(0);
    });

    test('description over max length is rejected with 400, nothing written', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ description: 'a'.repeat(1001) });

      expect(res.status).toBe(400);

      const list = await request(app).get('/api/tasks');
      expect(list.body).toHaveLength(0);
    });
  });

  test('delete removes the task from the list', async () => {
    const created = await request(app).post('/api/tasks').send({ description: 'trash me' });

    const deleteRes = await request(app).delete(`/api/tasks/${created.body.id}`);
    expect(deleteRes.status).toBe(204);

    const list = await request(app).get('/api/tasks');
    expect(list.body.find((t) => t.id === created.body.id)).toBeUndefined();
  });
});
