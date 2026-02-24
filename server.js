const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 20 * 1024 * 1024 });
const mongoose = require('mongoose');

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const mongoURI = process.env.MONGO_URI;
if (mongoURI) mongoose.connect(mongoURI).then(() => console.log('✅ BD Conectada')).catch(e => console.log(e));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  phone: { type: String, unique: true },
  password: String,
  profilePic: { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  sender: String, receiver: String, text: String, type: String,
  time: String, timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'sent' }, deleted: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', messageSchema);

let connectedUsers = {};

io.on('connection', (socket) => {
  
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

  socket.on('login', async (data) => {
    const user = await User.findOne({ username: data.username, password: data.password });
    if (!user) return socket.emit('auth_error', 'Datos incorrectos.');
    
    socket.username = user.username;
    connectedUsers[user.username] = socket.id;
    
    const myMsgs = await Message.find({ $or: [{ sender: user.username }, { receiver: user.username }] }).sort({ timestamp: 1 });
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

  socket.on('search_contact', async (query) => {
    if (query === socket.username) return socket.emit('search_error', 'No puedes agregarte a ti mismo.');
    const user = await User.findOne({ $or: [{ username: query }, { phone: query }] }, 'username profilePic phone');
    if (user) socket.emit('contact_found', user);
    else socket.emit('search_error', 'Usuario o teléfono no encontrado.');
  });

  socket.on('update_profile_pic', async (base64) => {
    await User.updateOne({ username: socket.username }, { profilePic: base64 });
    socket.emit('profile_pic_updated', base64);
    io.emit('contact_pic_updated', { username: socket.username, profilePic: base64 });
  });

  socket.on('chat message', async (data) => {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newMsg = new Message({ sender: socket.username, receiver: data.receiver, text: data.text, type: data.type, time: timeNow });
    const savedMsg = await newMsg.save(); 
    const receiverSocket = connectedUsers[data.receiver];
    if (receiverSocket) io.to(receiverSocket).emit('chat message', savedMsg); 
    socket.emit('chat message', savedMsg); 
  });

  socket.on('mark_read', async (senderName) => {
    await Message.updateMany({ sender: senderName, receiver: socket.username, status: 'sent' }, { status: 'read' });
    const senderSocket = connectedUsers[senderName];
    if (senderSocket) io.to(senderSocket).emit('messages_read', socket.username);
  });

  socket.on('delete_message', async (msgId) => {
    const msg = await Message.findById(msgId);
    if (msg && msg.sender === socket.username) {
        msg.deleted = true; await msg.save();
        io.emit('message_deleted', msgId);
    }
  });

  // --- NUEVO: BORRAR CHAT COMPLETO ---
  socket.on('delete_chat', async (targetUser) => {
    if (!socket.username) return;
    await Message.deleteMany({
        $or: [
            { sender: socket.username, receiver: targetUser },
            { sender: targetUser, receiver: socket.username }
        ]
    });
    const targetSocket = connectedUsers[targetUser];
    if (targetSocket) io.to(targetSocket).emit('chat_deleted', socket.username);
    socket.emit('chat_deleted', targetUser);
  });

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
http.listen(PORT, () => console.log("Servidor V5.1 corriendo en puerto " + PORT));
