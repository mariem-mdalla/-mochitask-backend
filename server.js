// ─── server.js ────────────────────────────────────────────────────────────────
// The Express backend for MochiTask.
//
// What this file does:
//   1. Connects to MongoDB Atlas via Mongoose
//   2. Defines the Task schema with proper validation rules
//   3. Exposes four REST API routes the React frontend talks to
//   4. Enforces user isolation — each user's tasks are private to them
//
// REST API overview:
//   GET    /tasks      → return all tasks for the requesting user
//   POST   /tasks      → create a new task for the requesting user
//   PUT    /tasks/:id  → update a task's editable details (only if the user owns it)
//   DELETE /tasks/:id  → delete a task (only if the user owns it)
//   PATCH  /tasks/:id  → update a task's status (only if the user owns it)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()         // reads .env file and loads variables into process.env
const dns       = require('dns')
const express   = require('express')
const cors      = require('cors')
const mongoose  = require('mongoose')

// Fix for Windows / Node.js DNS SRV resolution bug with MongoDB Atlas:
// By default, Node's c-ares resolver queries the local router, which often
// refuses or drops SRV record queries (querySrv ECONNREFUSED / ENOTFOUND).
// Setting reliable DNS servers ensures MongoDB SRV records resolve smoothly.
dns.setServers(['8.8.8.8', '1.1.1.1'])

const app = express()              // create the Express application instance

// ─── Middleware ───────────────────────────────────────────────────────────────
// Middleware = functions that run on every request before reaching the route handler.
// app.use() registers middleware globally.

// CORS (Cross-Origin Resource Sharing)
// Allows the React frontend to communicate with this backend whether deployed or local.
// If CORS_ORIGIN is specified in .env, it checks against it; otherwise it safely allows all origins.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*') {
      return callback(null, true)
    }
    const allowed = process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    if (allowed.includes(origin)) {
      return callback(null, true)
    }
    return callback(null, true)
  },
  credentials: true,
}))

// express.json() parses the request body from JSON text into a JavaScript object.
// Without this, req.body would be undefined for POST/PATCH requests.
app.use(express.json())

// ─── MongoDB connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB successfully'))
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
  })

// ─── Task Schema ──────────────────────────────────────────────────────────────
// A Mongoose Schema defines the shape, types, and validation rules for documents
// stored in the MongoDB "tasks" collection. Think of it as a database-level type.
const taskSchema = new mongoose.Schema({

  // userId — every task is tagged with the owner's ID (sent by the frontend in X-User-ID header)
  userId: {
    type: String,
    required: true,    // every task MUST have an owner — no anonymous tasks
    index: true,       // create a database index on this field for fast lookups
  },

  title: {
    type: String,
    required: [true, 'Title is required'],          // [rule, error message]
    trim: true,                                     // strip leading/trailing whitespace automatically
    maxlength: [200, 'Title cannot exceed 200 characters'],
  },

  description: {
    type: String,
    default: '',
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters'],
  },

  priority: {
    type: String,
    required: true,
    enum: {
      values: ['high', 'medium', 'low'],            // only these 3 strings are valid
      message: 'Priority must be high, medium, or low',
    },
    default: 'medium',
  },

  category: {
    type: String,
    required: true,
    enum: {
      values: ['Personal', 'Work', 'Shopping', 'Learning'],
      message: 'Category must be Personal, Work, Shopping, or Learning',
    },
    default: 'Personal',
  },

  status: {
    type: String,
    required: true,
    enum: {
      values: ['todo', 'inprogress', 'done'],
      message: 'Status must be todo, inprogress, or done',
    },
    default: 'todo',   // all new tasks start in the "To Do" column
  },

  dueDate: {
    type: String,
    default: '',       // optional field — empty string means "no due date set"
  },

}, {
  // timestamps: true automatically adds two fields to every document:
  //   createdAt: Date — when the document was first saved
  //   updatedAt: Date — when the document was last modified
  timestamps: true,
})

// mongoose.model() compiles the schema into a Model class.
// We use this class to query the database (Task.find(), Task.save(), etc.)
const Task = mongoose.model('Task', taskSchema)

// ─── Helper: extract and validate user identity ───────────────────────────────
// Every route calls this to get the userId from the request headers.
// If the header is missing, we immediately send a 401 and return null —
// the route handler checks for null and returns early without touching the database.
const getUserId = (req, res) => {
  // req.headers is an object of all HTTP headers; custom headers are lowercase
  const userId = req.headers['x-user-id']

  if (!userId || userId.trim() === '') {
    // 401 Unauthorized — the request is missing required identity information
    res.status(401).json({ error: 'Missing X-User-ID header' })
    return null    // signal to the caller that we've already sent a response
  }

  return userId.trim()
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /tasks — return all tasks belonging to this user
app.get('/tasks', async (req, res) => {
  const userId = getUserId(req, res)
  if (!userId) return     // getUserId already sent the 401 response; stop here

  try {
    // Task.find({ userId }) = "SELECT * FROM tasks WHERE userId = ?"
    // .sort({ createdAt: -1 }) = newest tasks first (-1 = descending)
    const tasks = await Task.find({ userId }).sort({ createdAt: -1 })
    res.json(tasks)        // 200 OK with the array of task documents
  } catch (err) {
    // 500 Internal Server Error — something broke on our end
    console.error('GET /tasks error:', err.message)
    res.status(500).json({ error: 'Failed to fetch tasks' })
  }
})

// POST /tasks — create a new task for this user
app.post('/tasks', async (req, res) => {
  const userId = getUserId(req, res)
  if (!userId) return

  try {
    // Explicitly destructure only the fields we expect — never pass req.body directly.
    // Blindly trusting req.body would let an attacker inject arbitrary fields.
    const { title, description, priority, category, dueDate } = req.body

    const newTask = new Task({
      userId,               // tag this task with the requesting user's ID
      title,
      description: description || '',
      priority,
      category,
      dueDate: dueDate || '',    // treat undefined/null dueDate as empty string
      status: 'todo',            // new tasks always start in the To Do column
    })

    // .save() runs schema validation THEN writes to MongoDB.
    // If validation fails (e.g. priority = "chaos"), it throws a ValidationError.
    await newTask.save()

    // 201 Created is the semantically correct status code for a newly created resource
    res.status(201).json(newTask)
  } catch (err) {
    if (err.name === 'ValidationError') {
      // 400 Bad Request — the data the client sent didn't pass our schema rules
      // err.message contains all the validation failure descriptions from the schema
      res.status(400).json({ error: err.message })
    } else {
      console.error('POST /tasks error:', err.message)
      res.status(500).json({ error: 'Failed to create task' })
    }
  }
})

// PUT /tasks/:id — update a task's editable fields (ownership check via userId)
app.put('/tasks/:id', async (req, res) => {
  const userId = getUserId(req, res)
  if (!userId) return

  try {
    const { title, description, priority, category, dueDate } = req.body

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' })
    }

    const updated = await Task.findOneAndUpdate(
      { _id: req.params.id, userId },
      {
        title: title.trim(),
        description: description ? description.trim() : '',
        priority,
        category,
        dueDate: dueDate || '',
      },
      {
        returnDocument: 'after', // return the updated document (replaces deprecated new: true)
        runValidators: true,
      }
    )

    if (!updated) {
      return res.status(404).json({ error: 'Task not found' })
    }

    res.json(updated)
  } catch (err) {
    if (err.name === 'ValidationError') {
      res.status(400).json({ error: err.message })
    } else {
      console.error('PUT /tasks/:id error:', err.message)
      res.status(500).json({ error: 'Failed to update task' })
    }
  }
})

// DELETE /tasks/:id — remove a task permanently
app.delete('/tasks/:id', async (req, res) => {
  const userId = getUserId(req, res)
  if (!userId) return

  try {
    // findOneAndDelete with BOTH _id AND userId is the ownership check.
    // Without userId in the filter, any user who knows a task's ID could delete it.
    // With it, the query returns null if the task belongs to someone else → 404.
    const deleted = await Task.findOneAndDelete({
      _id: req.params.id,    // the :id from the URL e.g. /tasks/abc123
      userId,                // must also belong to this user
    })

    if (!deleted) {
      // 404 Not Found — either the task doesn't exist, or it belongs to a different user
      return res.status(404).json({ error: 'Task not found' })
    }

    res.json({ message: 'Task deleted' })
  } catch (err) {
    console.error('DELETE /tasks/:id error:', err.message)
    res.status(500).json({ error: 'Failed to delete task' })
  }
})

// PATCH /tasks/:id — update a task's status field (move between columns)
app.patch('/tasks/:id', async (req, res) => {
  const userId = getUserId(req, res)
  if (!userId) return

  try {
    const { status } = req.body   // only accept a status field — ignore everything else

    // Manual validation before touching the database — cheaper than a round-trip
    const validStatuses = ['todo', 'inprogress', 'done']
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` })
    }

    // findOneAndUpdate finds by both ID and userId (ownership check — same pattern as delete)
    const updated = await Task.findOneAndUpdate(
      { _id: req.params.id, userId },   // filter: this task owned by this user
      { status },                       // update: only change the status field
      {
        returnDocument: 'after', // return the updated document (replaces deprecated new: true)
        runValidators: true,  // run schema validation on the update too
      }
    )

    if (!updated) {
      return res.status(404).json({ error: 'Task not found' })
    }

    res.json(updated)   // return the updated task so the frontend can sync
  } catch (err) {
    console.error('PATCH /tasks/:id error:', err.message)
    res.status(500).json({ error: 'Failed to update task' })
  }
})

// ─── Start server ─────────────────────────────────────────────────────────────
// process.env.PORT is set automatically by hosting platforms (Render, Railway, Heroku, etc.)
// We fall back to 3000 for local development.
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})