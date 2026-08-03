const { randomUUID } = require('crypto');

let tasks = [];

function create(description) {
  const task = {
    id: randomUUID(),
    description,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  tasks.push(task);
  return task;
}

function findAll() {
  return tasks;
}

function findById(id) {
  return tasks.find((t) => t.id === id);
}

function update(id, data) {
  const task = findById(id);
  if (!task) return null;
  if (data.description !== undefined) task.description = data.description;
  if (data.status !== undefined) task.status = data.status;
  task.updatedAt = new Date();
  return task;
}

function remove(id) {
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return false;
  tasks.splice(index, 1);
  return true;
}

module.exports = { create, findAll, findById, update, remove };
