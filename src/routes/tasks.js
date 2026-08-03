const express = require('express');
const Task = require('../models/task');

const router = express.Router();
const MAX_DESCRIPTION_LENGTH = 1000;

router.post('/', async (req, res, next) => {
  try {
    const { description } = req.body;
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'description is required' });
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
    }
    const task = await Task.create(description);
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await Task.findAll());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const task = await Task.update(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await Task.remove(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Task not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
