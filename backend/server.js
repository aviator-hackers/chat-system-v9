const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios'); // Added for Expo APK support

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// --- API ENDPOINTS ---

// Modified to save the Expo Token to the DB
app.post('/api/save-token', async (req, res) => {
    const { sessionId, token } = req.body;
    try {
        await pool.query(
            'UPDATE messages SET expo_push_token = $1 WHERE session_id = $2',
            [token, sessionId]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  res.json({ success: password === ADMIN_PASSWORD });
});

app.get('/api/admin/sessions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (session_id) 
        session_id, display_name, expo_push_token,
        MAX(created_at) OVER (PARTITION BY session_id) as last_message 
       FROM messages ORDER BY session_id, created_at DESC`
    );
    res.json({ sessions: result.rows });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const result = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [sessionId]);
    res.json({ messages: result.rows });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

// --- SOCKET.IO (Your Exact Flow) ---

io.on('connection', (socket) => {
  socket.on('join', async (data) => {
    const sessionId = typeof data === 'object' ? data.sessionId : data;
    const displayName = typeof data === 'object' ? data.displayName : null;
    socket.join(sessionId);
    socket.sessionId = sessionId;
    
    try {
      const result = await pool.query('SELECT COUNT(*) FROM messages WHERE session_id = $1', [sessionId]);
      if (parseInt(result.rows[0].count) === 0) {
        const greetingText = `Greetings. 👋\n\nYou are connected to the verified V9.0 administration desk. \nI am available to help you secure your legit activation code. \n\nHow may I serve you today?`;
        await pool.query(
          'INSERT INTO messages (session_id, sender_role, text, image_url, display_name) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, 'admin', greetingText, null, displayName]
        );
        socket.emit('message', { sender_role: 'admin', text: greetingText, image_url: null, display_name: displayName, created_at: new Date().toISOString() });
      }
    } catch (err) { console.error(err); }
  });

  socket.on('admin-join', () => { socket.isAdmin = true; socket.join('admin-room'); });

  socket.on('admin-typing', (data) => {
    socket.to(data.targetSessionId).emit('admin-typing', data.isTyping);
  });

  socket.on('user-typing', (data) => {
    io.to('admin-room').emit('user-typing', { sessionId: data.sessionId, isTyping: data.isTyping });
  });

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
        io.to('admin-room').emit('new-user-message', { sessionId, message: savedMessage });
      }

      // --- WAKE UP USER PHONE (Expo Version) ---
      if (senderRole === 'admin') {
        const tokenRes = await pool.query('SELECT expo_push_token FROM messages WHERE session_id = $1 AND expo_push_token IS NOT NULL LIMIT 1', [sessionId]);
        if (tokenRes.rows.length > 0) {
          axios.post('https://exp.host/--/api/v2/push/send', {
            to: tokenRes.rows[0].expo_push_token,
            title: 'Aviator Support',
            body: text || 'Sent an image',
            sound: 'default'
          }).catch(e => console.error("Push Error"));
        }
      }
    } catch (err) { console.error(err); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
