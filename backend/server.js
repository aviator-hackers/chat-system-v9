const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios'); // For Expo Push

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

// --- 1. NEW TOKEN ROUTE (Doesn't touch existing logic) ---
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

// --- 2. YOUR ORIGINAL ROUTES ---
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

app.delete('/api/admin/sessions/:sessionId', async (req, res) => {
  try {
    await pool.query('DELETE FROM messages WHERE session_id = $1', [req.params.sessionId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [req.params.sessionId]);
    res.json({ messages: result.rows });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

// --- 3. YOUR ORIGINAL SOCKET LOGIC (GREETINGS + TYPING) ---
io.on('connection', (socket) => {
  socket.on('join', async (data) => {
    const sessionId = typeof data === 'object' ? data.sessionId : data;
    const displayName = typeof data === 'object' ? data.displayName : null;
    socket.join(sessionId);
    socket.sessionId = sessionId;

    try {
      const result = await pool.query('SELECT COUNT(*) FROM messages WHERE session_id = $1', [sessionId]);
      if (parseInt(result.rows[0].count) === 0) {
        const greetingText = `Greetings. 👋\n\nYou are connected to the verified V9.0 administration desk...`;
        await pool.query(
          'INSERT INTO messages (session_id, sender_role, text, display_name) VALUES ($1, $2, $3, $4)',
          [sessionId, 'admin', greetingText, displayName]
        );
        socket.emit('message', { sender_role: 'admin', text: greetingText, created_at: new Date().toISOString() });
      }
    } catch (err) { console.error(err); }
  });

  socket.on('admin-join', () => { socket.isAdmin = true; socket.join('admin-room'); });

  socket.on('admin-typing', (data) => { socket.to(data.targetSessionId).emit('admin-typing', data.isTyping); });

  socket.on('user-typing', (data) => { io.to('admin-room').emit('user-typing', data); });

  // --- 4. YOUR ORIGINAL SEND-MESSAGE LOGIC + EXPO TRIGGER ---
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

      // ONLY TRIGGER PUSH IF ADMIN REPLIES
      if (senderRole === 'admin') {
          const tokenRes = await pool.query('SELECT expo_push_token FROM messages WHERE session_id = $1 AND expo_push_token IS NOT NULL LIMIT 1', [sessionId]);
          if (tokenRes.rows.length > 0) {
              axios.post('https://exp.host/--/api/v2/push/send', {
                  to: tokenRes.rows[0].expo_push_token,
                  title: 'Support Team 💬',
                  body: text || 'Sent an image',
                  sound: 'default'
              }).catch(e => console.log("Push Failed"));
          }
      }
    } catch (err) { console.error(err); }
  });
});

server.listen(process.env.PORT || 3000);
