const express = require('express');
const Task = require('../models/task');

const router = express.Router();
const MAX_DESCRIPTION_LENGTH = 1000;

router.post('/', (req, res) => {
  const { description } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
  }
  const task = Task.create(description);
  res.status(201).json(task);
});

router.get('/', (req, res) => {
  res.json(Task.findAll());
});

router.get('/:id', (req, res) => {
  const task = Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.put('/:id', (req, res) => {
  const task = Task.update(req.params.id, req.body);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.delete('/:id', (req, res) => {
  const deleted = Task.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  res.status(204).send();
});

module.exports = router;
