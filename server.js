
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 10 * 1024 * 1024 });
const mongoose = require('mongoose');

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// --- CONEXIÓN A LA BASE DE DATOS ---
const mongoURI = process.env.MONGO_URI;
if (mongoURI) {
  mongoose.connect(mongoURI)
    .then(() => console.log('✅ Base de datos conectada'))
    .catch(err => console.log('❌ Error en base de datos:', err));
}

// --- ESQUEMA DE MENSAJE (Cómo se guardan los datos) ---
const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  type: String,
  time: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

let users = {};

io.on('connection', (socket) => {
  
  socket.on('set username', (username) => {
    socket.username = username;
    users[socket.id] = username;
    io.emit('user list', Object.values(users));
    console.log(username + " se unió");

    // Cargar los últimos 50 mensajes y enviárselos SOLO al que acaba de entrar
    if (mongoURI) {
      Message.find().sort({ timestamp: 1 }).limit(50).then(messages => {
        messages.forEach(msg => {
          socket.emit('chat message', { user: msg.user, text: msg.text, type: msg.type, time: msg.time });
        });
      });
    }
  });

  socket.on('chat message', (data) => {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const msgData = {
      user: socket.username || 'Anónimo',
      text: data.text,
      type: data.type,
      time: timeNow
    };

    // Guardar en la base de datos permanente
    if (mongoURI) {
      const newMsg = new Message(msgData);
      newMsg.save();
    }

    // Enviar a todos
    io.emit('chat message', msgData);
  });

  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('typing', { user: socket.username, isTyping: isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.id];
      io.emit('user list', Object.values(users));
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(Servidor Pro corriendo en puerto ${PORT});
});

