const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

let users = {};

io.on('connection', (socket) => {
  
  socket.on('set username', (username) => {
    socket.username = username;
    users[socket.id] = username;
    io.emit('user list', Object.values(users));
    console.log(username + " se unió");
  });

  // NUEVO: Ahora recibimos un "objeto" que dice si es texto o imagen
  socket.on('chat message', (data) => {
    io.emit('chat message', {
      user: socket.username || 'Anónimo',
      text: data.text,
      type: data.type, // Puede ser 'text' o 'image'
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // NUEVO: Escuchar cuando alguien está escribiendo y avisar a los demás
  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('typing', {
      user: socket.username,
      isTyping: isTyping
    });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.id];
      io.emit('user list', Object.values(users));
    }
  });
});

// La nube elegirá el puerto, o usará el 3000 si estás en tu PC local
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(Servidor Pro corriendo en puerto ${PORT});
});
