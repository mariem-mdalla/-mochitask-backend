require('dotenv').config()
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')

const app = express()

app.use(cors())
app.use(express.json())

// Connect to MongoDB
// Replace this with your actual connection string from Atlas
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB! 🌸'))
  .catch((err) => console.log('MongoDB error:', err))

// Define what a Task looks like in the database
// This is called a Schema — like a TypeScript type but for the database
const taskSchema = new mongoose.Schema({
  title: String,       // task title
  priority: String,    // high, medium, low
  category: String,    // Work, Personal, etc
  status: String,      // todo, inprogress, done
  dueDate: String,
})

// Create a Task model from the schema
// This is what we use to talk to the database
const Task = mongoose.model('Task', taskSchema)

// GET - fetch all tasks from database
app.get('/tasks', async (req, res) => {
  const tasks = await Task.find() // get all tasks from MongoDB
  res.json(tasks)
})

// POST - add a new task to database
app.post('/tasks', async (req, res) => {
  const newTask = new Task({
    title: req.body.title,
    priority: req.body.priority,
    category: req.body.category,
    status: 'todo'
  })
  await newTask.save() // save to MongoDB
  res.json(newTask)
})

// DELETE - remove a task from database
app.delete('/tasks/:id', async (req, res) => {
  await Task.findByIdAndDelete(req.params.id) // find by MongoDB id and delete
  res.json({ message: 'Task deleted' })
})

// PATCH - update task status in database
app.patch('/tasks/:id', async (req, res) => {
  const task = await Task.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status }, // only update the status field
    { returnDocument: 'after' } // return the updated task
  )
  res.json(task)
})

app.listen(process.env.PORT || 3000, () => {
    console.log('Server running on port 3000 🚀')
})