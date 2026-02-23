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
  mongoose.connect(mongoURI).then(() => console.log('✅ Base de datos conectada')).catch(e => console.log(e));
}

// --- 1. NUEVO ESQUEMA: USUARIOS ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String // (Nota: En apps reales esto se encripta, aquí lo hacemos simple para aprender)
});
const User = mongoose.model('User', userSchema);

// --- 2. ESQUEMA ACTUALIZADO: MENSAJES ---
const messageSchema = new mongoose.Schema({
  sender: String,
  receiver: String, // 'Global' o el nombre del usuario receptor
  text: String,
  type: String,
  time: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// Diccionario para saber exactamente qué computadora tiene cada usuario
let connectedUsers = {};

io.on('connection', (socket) => {
  
  // --- SISTEMA DE REGISTRO ---
  socket.on('register', async (data) => {
    if (!mongoURI) return socket.emit('auth_error', 'Base de datos no conectada');
    try {
      const existing = await User.findOne({ username: data.username });
      if (existing) return socket.emit('auth_error', 'El usuario ya existe. Elige otro.');
      
      const newUser = new User({ username: data.username, password: data.password });
      await newUser.save();
      socket.emit('register_success', 'Cuenta creada. ¡Ahora inicia sesión!');
    } catch(e) { socket.emit('auth_error', 'Error al registrar.'); }
  });

  // --- SISTEMA DE LOGIN ---
  socket.on('login', async (data) => {
    if (!mongoURI) return socket.emit('auth_error', 'Base de datos no conectada');
    const user = await User.findOne({ username: data.username, password: data.password });
    
    if (user) {
      socket.username = user.username;
      connectedUsers[user.username] = socket.id; // Vinculamos su nombre a su computadora actual
      
      socket.emit('login_success', user.username);
      io.emit('user list', Object.keys(connectedUsers)); // Actualizar lista a todos
      console.log(user.username + " ha iniciado sesión");

      // Cargar historial: Solo los mensajes Globales y los Privados donde este usuario participa
      const msgs = await Message.find({
        $or: [
          { receiver: 'Global' },
          { sender: user.username },
          { receiver: user.username }
        ]
      }).sort({ timestamp: 1 }).limit(100);
      
      socket.emit('load_history', msgs);
    } else {
      socket.emit('auth_error', 'Usuario o contraseña incorrectos.');
    }
  });

  // --- SISTEMA DE MENSAJERÍA ---
  socket.on('chat message', (data) => {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgData = {
      sender: socket.username,
      receiver: data.receiver, // A quién va dirigido
      text: data.text,
      type: data.type,
      time: timeNow
    };

    if (mongoURI) new Message(msgData).save();

    if (data.receiver === 'Global') {
      // Si es global, enviarlo a todos
      io.emit('chat message', msgData);
    } else {
      // Si es privado, enviarlo SOLO al receptor y al remitente
      const receiverSocketId = connectedUsers[data.receiver];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('chat message', msgData); // Entregar al amigo
      }
      socket.emit('chat message', msgData); // Mostrármelo a mí mismo
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete connectedUsers[socket.username];
      io.emit('user list', Object.keys(connectedUsers));
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Servidor Pro corriendo en puerto " + PORT));


