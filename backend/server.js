const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- WEB PUSH CONFIG (Your Keys) ---
const publicVapidKey = 'BERK0hZzO0EBXeTe3hxyuhn_GMgx-uwPb7tUNVfmuKE_CWhDWRoQl0cVjEjRU2BEw7fQvGnkUfXRYHqQg57gx60';
const privateVapidKey = 'CBuWQAX2wE_uaBHOTCufnndpZYtoBFYbGYYB9ZClpOU';

webpush.setVapidDetails(
  'mailto:admin@aviator-predictor.com',
  publicVapidKey,
  privateVapidKey
);

let userSubscriptions = {}; // Stores phone addresses for Push

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(cors());
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
  }
});

// --- API ENDPOINTS (Your Logic + Subscribe) ---

app.post('/api/subscribe', (req, res) => {
    const { sessionId, subscription } = req.body;
    userSubscriptions[sessionId] = subscription;
    res.status(201).json({ success: true });
});

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/api/admin/sessions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (session_id) 
        session_id, 
        display_name, 
        MAX(created_at) OVER (PARTITION BY session_id) as last_message 
       FROM messages 
       ORDER BY session_id, created_at DESC`
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Error fetching sessions:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    await pool.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
    delete userSubscriptions[sessionId];
    res.json({ success: true, message: 'Session deleted successfully' });
  } catch (err) {
    console.error('Error deleting session:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

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

// --- SOCKET.IO (Your Original Flow + Notifications) ---

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join', async (data) => {
    const sessionId = typeof data === 'object' ? data.sessionId : data;
    const displayName = typeof data === 'object' ? data.displayName : null;

    socket.join(sessionId);
    socket.sessionId = sessionId;
    
    try {
      const result = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE session_id = $1',
        [sessionId]
      );
      
      const messageCount = parseInt(result.rows[0].count);
      
      if (messageCount === 0) {
        const greetingText = `Greetings. 👋\n\nYou are connected to the verified V9.0 administration desk. \nI am available to help you secure your legit activation code. \n\nHow may I serve you today?`;
        
        await pool.query(
          'INSERT INTO messages (session_id, sender_role, text, image_url, display_name) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, 'admin', greetingText, null, displayName]
        );
        
        socket.emit('message', {
          sender_role: 'admin',
          text: greetingText,
          image_url: null,
          display_name: displayName,
          created_at: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error('Error checking session:', err);
    }
  });

  socket.on('admin-join', () => {
    socket.isAdmin = true;
    socket.join('admin-room');
    console.log('Admin connected');
  });

  socket.on('admin-select-session', (sessionId) => {
    if (socket.isAdmin) {
      socket.currentSession = sessionId;
      socket.join(sessionId);
    }
  });

  // Relay typing indicators
  socket.on('admin-typing', (data) => {
    socket.to(data.targetSessionId).emit('admin-typing', data.isTyping);
  });

  socket.on('user-typing', (data) => {
    io.to('admin-room').emit('user-typing', { sessionId: data.sessionId, isTyping: data.isTyping });
  });

  // Handle messages (Your Logic + Web Push)
  socket.on('send-message', async (data) => {
    const { sessionId, text, senderRole, imageData, displayName, replyToText } = data;
    
    try {
      const result = await pool.query(
        'INSERT INTO messages (session_id, sender_role, text, image_url, display_name, reply_to_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [sessionId, senderRole, text || '', imageData || null, displayName || null, replyToText || null]
      );
      
      const savedMessage = result.rows[0];
      io.to(sessionId).emit('message', savedMessage);
      
      if (senderRole === 'user') {
        io.to('admin-room').emit('new-user-message', {
          sessionId,
          message: savedMessage
        });
      }

      // --- WAKE UP USER PHONE ---
      if (senderRole === 'admin') {
        const pushSubscription = userSubscriptions[sessionId];
        if (pushSubscription) {
            const payload = JSON.stringify({
                title: 'Aviator Support',
                body: text || 'Sent an image'
            });
            webpush.sendNotification(pushSubscription, payload).catch(e => console.error("Push Error", e));
        }
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
