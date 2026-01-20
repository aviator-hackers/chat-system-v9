const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


app.use(cors());
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
  }
});

// REST endpoint to verify admin password
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// Get all session IDs
app.get('/api/admin/sessions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT session_id, MAX(created_at) as last_message FROM messages GROUP BY session_id ORDER BY last_message DESC'
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Error fetching sessions:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get messages for a specific session
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // User joins with their session ID
  socket.on('join', async (sessionId) => {
    socket.join(sessionId);
    socket.sessionId = sessionId;
    console.log(`User joined session: ${sessionId}`);

    // Check if this is a new session
    try {
      const result = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE session_id = $1',
        [sessionId]
      );
      
      const messageCount = parseInt(result.rows[0].count);
      
      // If new session, send auto-greeting
      if (messageCount === 0) {
        const greetingText = 'Hello, how can I help you?';
        await pool.query(
          'INSERT INTO messages (session_id, sender_role, text) VALUES ($1, $2, $3)',
          [sessionId, 'admin', greetingText]
        );
        
        // Emit greeting to user
        socket.emit('message', {
          sender_role: 'admin',
          text: greetingText,
          created_at: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error('Error checking/creating session:', err);
    }
  });

  // Admin joins
  socket.on('admin-join', () => {
    socket.isAdmin = true;
    socket.join('admin-room');
    console.log('Admin connected');
  });

  // Admin selects a session to monitor
  socket.on('admin-select-session', (sessionId) => {
    if (socket.isAdmin) {
      socket.currentSession = sessionId;
      socket.join(sessionId);
      console.log(`Admin joined session: ${sessionId}`);
    }
  });

  // Handle new messages
  socket.on('send-message', async (data) => {
    const { sessionId, text, senderRole } = data;
    
    try {
      // Save to database
      const result = await pool.query(
        'INSERT INTO messages (session_id, sender_role, text) VALUES ($1, $2, $3) RETURNING *',
        [sessionId, senderRole, text]
      );
      
      const savedMessage = result.rows[0];
      
      // Broadcast to all clients in the session (user and admin)
      io.to(sessionId).emit('message', savedMessage);
      
      // Notify admin room about new user message
      if (senderRole === 'user') {
        io.to('admin-room').emit('new-user-message', {
          sessionId,
          message: savedMessage
        });
      }
      
    } catch (err) {
      console.error('Error saving message:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});