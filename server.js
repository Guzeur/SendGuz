const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 20 * 1024 * 1024 }); // Subido a 20MB para audios
const mongoose = require('mongoose');

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- CONEXIÓN A BASE DE DATOS ---
const mongoURI = process.env.MONGO_URI;
if (mongoURI) mongoose.connect(mongoURI).then(() => console.log('✅ BD Conectada')).catch(e => console.log(e));

// --- 1. ESQUEMA DE USUARIOS (Ahora con Teléfono y Foto) ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  phone: { type: String, unique: true },
  password: String,
  profilePic: { type: String, default: '' } // Base64 de la imagen
});
const User = mongoose.model('User', userSchema);

// --- 2. ESQUEMA DE MENSAJES (Ahora con Estados y Borrado) ---
const messageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  text: String, // Texto, o Base64 de Imagen/Audio
  type: String, // 'text', 'image', 'audio'
  time: String,
  timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'sent' }, // 'sent' (✓✓ gris), 'read' (✓✓ azul)
  deleted: { type: Boolean, default: false } // Para borrar mensajes
});
const Message = mongoose.model('Message', messageSchema);

let connectedUsers = {}; // Para saber quién está online

io.on('connection', (socket) => {
  
  // --- REGISTRO CON TELÉFONO ---
  socket.on('register', async (data) => {
    if (!mongoURI) return socket.emit('auth_error', 'BD no conectada');
    try {
      const existU = await User.findOne({ username: data.username });
      const existP = await User.findOne({ phone: data.phone });
      if (existU || existP) return socket.emit('auth_error', 'Usuario o Teléfono ya existe.');
      
      const newUser = new User({ username: data.username, phone: data.phone, password: data.password });
      await newUser.save();
      socket.emit('register_success', '¡Cuenta creada con éxito!');
    } catch(e) { socket.emit('auth_error', 'Error en registro.'); }
  });

  // --- LOGIN Y CARGA DE CHATS PRIVADOS ---
  socket.on('login', async (data) => {
    const user = await User.findOne({ username: data.username, password: data.password });
    if (!user) return socket.emit('auth_error', 'Datos incorrectos.');
    
    socket.username = user.username;
    connectedUsers[user.username] = socket.id;
    
    // Buscar todos los mensajes donde participo
    const myMsgs = await Message.find({ $or: [{ sender: user.username }, { receiver: user.username }] }).sort({ timestamp: 1 });
    
    // Extraer con quién he hablado para armar la lista de contactos
    const contactsSet = new Set();
    myMsgs.forEach(m => {
        if (m.sender !== user.username) contactsSet.add(m.sender);
        if (m.receiver !== user.username) contactsSet.add(m.receiver);
    });
    
    const contactsInfo = await User.find({ username: { $in: Array.from(contactsSet) } }, 'username profilePic phone');
    
    socket.emit('login_success', { username: user.username, profilePic: user.profilePic, phone: user.phone });
    socket.emit('load_initial_data', { messages: myMsgs, contacts: contactsInfo });
    io.emit('online_status', Object.keys(connectedUsers));
  });

  // --- BUSCAR NUEVO CONTACTO ---
  socket.on('search_contact', async (query) => {
    if (query === socket.username) return socket.emit('search_error', 'No puedes agregarte a ti mismo.');
    const user = await User.findOne({ $or: [{ username: query }, { phone: query }] }, 'username profilePic phone');
    if (user) socket.emit('contact_found', user);
    else socket.emit('search_error', 'Usuario o teléfono no encontrado.');
  });

  // --- ACTUALIZAR FOTO DE PERFIL ---
  socket.on('update_profile_pic', async (base64) => {
    await User.updateOne({ username: socket.username }, { profilePic: base64 });
    socket.emit('profile_pic_updated', base64);
    io.emit('contact_pic_updated', { username: socket.username, profilePic: base64 }); // Avisar a los demás
  });

  // --- ENVIAR MENSAJES ---
  socket.on('chat message', async (data) => {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newMsg = new Message({ sender: socket.username, receiver: data.receiver, text: data.text, type: data.type, time: timeNow });
    const savedMsg = await newMsg.save(); // Guardar para obtener el ID real
    
    const receiverSocket = connectedUsers[data.receiver];
    if (receiverSocket) io.to(receiverSocket).emit('chat message', savedMsg); // Enviar al amigo
    socket.emit('chat message', savedMsg); // Mostrarme a mí
  });

  // --- RECIBOS DE LECTURA (PALOMITAS AZULES) ---
  socket.on('mark_read', async (senderName) => {
    // Actualizar en BD que ya leí los mensajes que me envió él
    await Message.updateMany({ sender: senderName, receiver: socket.username, status: 'sent' }, { status: 'read' });
    // Avisarle a su computadora en vivo
    const senderSocket = connectedUsers[senderName];
    if (senderSocket) io.to(senderSocket).emit('messages_read', socket.username);
  });

  // --- BORRAR MENSAJES ---
  socket.on('delete_message', async (msgId) => {
    const msg = await Message.findById(msgId);
    if (msg && msg.sender === socket.username) {
        msg.deleted = true;
        await msg.save();
        io.emit('message_deleted', msgId); // Avisar a ambos para que se borre de la pantalla
    }
  });

  // --- ESCRIBIENDO ---
  socket.on('typing', (data) => {
    const receiverSocket = connectedUsers[data.receiver];
    if (receiverSocket) io.to(receiverSocket).emit('typing', { user: socket.username, isTyping: data.isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete connectedUsers[socket.username];
      io.emit('online_status', Object.keys(connectedUsers));
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Servidor V5 corriendo en puerto " + PORT));
