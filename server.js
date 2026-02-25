const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 20 * 1024 * 1024 });
const mongoose = require('mongoose');
const webpush = require('web-push');

const publicVapidKey = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuB22-xO3U-2XMDn-R_cewgKMc';
const privateVapidKey = 'HqX-TndhI0Pnt6O-4R1R_xM7rD2X1wE90-hK8-21TGE';
webpush.setVapidDetails('mailto:soporte@sendguz.com', publicVapidKey, privateVapidKey);

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🐺</text></svg>');
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: "SendGuz", short_name: "SendGuz", start_url: "/", display: "standalone",
    background_color: "#09090b", theme_color: "#4f46e5",
    icons: [{ src: "/icon.svg", sizes: "192x192 512x512", type: "image/svg+xml", purpose: "any maskable" }]
  });
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); 
  res.send(`
    self.addEventListener('push', function(e) {
      let data = { title: 'Nuevo mensaje', body: 'Tienes un mensaje en SendGuz' };
      if (e.data) { data = e.data.json(); }
      e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon.svg', badge: '/icon.svg', vibrate: [300, 100, 400], tag: 'sendguz-msg', renotify: true, data: { url: '/' } }));
    });
    self.addEventListener('notificationclick', function(e) {
      e.notification.close();
      e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
          if (windowClients.length > 0) {
            let client = windowClients[0];
            for (let i = 0; i < windowClients.length; i++) { if (windowClients[i].focused) client = windowClients[i]; }
            return client.focus();
          }
          return clients.openWindow('/');
      }));
    });
  `);
});

const mongoURI = process.env.MONGO_URI;
if (mongoURI) mongoose.connect(mongoURI).then(() => console.log('✅ BD Conectada')).catch(e => console.log(e));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true }, phone: { type: String, unique: true },
  password: String, profilePic: { type: String, default: '' },
  pushSubscription: { type: Object, default: null } 
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  sender: String, receiver: String, text: String, type: String,
  time: String, timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'sent' }, deleted: { type: Boolean, default: false },
  viewOnce: { type: Boolean, default: false }, viewed: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', messageSchema);

let connectedUsers = {};
let userStatus = {}; 

io.on('connection', (socket) => {
  socket.on('save_subscription', async (sub) => { if(socket.username) await User.updateOne({ username: socket.username }, { pushSubscription: sub }); });
  socket.on('status', (state) => { if(socket.username) userStatus[socket.username] = state; });

  socket.on('register', async (data) => {
    if (!mongoURI) return socket.emit('auth_error', 'BD no conectada');
    try {
      const existU = await User.findOne({ username: data.username }); const existP = await User.findOne({ phone: data.phone });
      if (existU || existP) return socket.emit('auth_error', 'Usuario o Teléfono ya existe.');
      const newUser = new User({ username: data.username, phone: data.phone, password: data.password });
      await newUser.save(); socket.emit('register_success', '¡Cuenta creada con éxito!');
    } catch(e) { socket.emit('auth_error', 'Error en registro.'); }
  });

  socket.on('login', async (data) => {
    const user = await User.findOne({ username: data.username, password: data.password });
    if (!user) return socket.emit('auth_error', 'Datos incorrectos.');
    socket.username = user.username; connectedUsers[user.username] = socket.id; userStatus[user.username] = 'active'; 
    const myMsgs = await Message.find({ $or: [{ sender: user.username }, { receiver: user.username }] }).sort({ timestamp: 1 });
    const contactsSet = new Set();
    myMsgs.forEach(m => { if (m.sender !== user.username) contactsSet.add(m.sender); if (m.receiver !== user.username) contactsSet.add(m.receiver); });
    const contactsInfo = await User.find({ username: { $in: Array.from(contactsSet) } }, 'username profilePic phone');
    socket.emit('login_success', { username: user.username, profilePic: user.profilePic, phone: user.phone });
    socket.emit('load_initial_data', { messages: myMsgs, contacts: contactsInfo });
    io.emit('online_status', Object.keys(connectedUsers));
  });

  socket.on('search_contact', async (query) => {
    if (query === socket.username) return socket.emit('search_error', 'No puedes agregarte a ti mismo.');
    const user = await User.findOne({ $or: [{ username: query }, { phone: query }] }, 'username profilePic phone');
    if (user) socket.emit('contact_found', user); else socket.emit('search_error', 'No encontrado.');
  });

  socket.on('update_profile_pic', async (base64) => {
    await User.updateOne({ username: socket.username }, { profilePic: base64 });
    socket.emit('profile_pic_updated', base64); io.emit('contact_pic_updated', { username: socket.username, profilePic: base64 });
  });

  socket.on('chat message', async (data) => {
    const timeNow = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
    const newMsg = new Message({ sender: socket.username, receiver: data.receiver, text: data.text, type: data.type, time: timeNow, viewOnce: data.viewOnce || false });
    const savedMsg = await newMsg.save(); 
    socket.emit('chat message', savedMsg); 

    const receiverSocket = connectedUsers[data.receiver];
    
    // CORRECCIÓN: SIEMPRE enviar al socket, sin importar si está minimizado
    if (receiverSocket) {
        io.to(receiverSocket).emit('chat message', savedMsg); 
    } 
    
    // Si está minimizado o desconectado, enviar la alerta Push a los servidores de Apple/Google
    if (!receiverSocket || userStatus[data.receiver] === 'background') {
        const receiverUser = await User.findOne({username: data.receiver});
        if(receiverUser && receiverUser.pushSubscription) {
            let notifText = data.type === 'image' ? '📷 Imagen' : (data.type === 'audio' ? '🎤 Nota de voz' : data.text);
            if (data.viewOnce) notifText = '🖼️ Foto efímera';
            const payload = JSON.stringify({ title: 'SendGuz: ' + socket.username, body: notifText });
            webpush.sendNotification(receiverUser.pushSubscription, payload).catch(e => console.log('Error PUSH:', e));
        }
    }
  });

  socket.on('mark_read', async (senderName) => {
    await Message.updateMany({ sender: senderName, receiver: socket.username, status: 'sent' }, { status: 'read' });
    const senderSocket = connectedUsers[senderName]; if (senderSocket) io.to(senderSocket).emit('messages_read', socket.username);
  });

  socket.on('delete_message', async (msgId) => {
    const msg = await Message.findById(msgId);
    if (msg && msg.sender === socket.username) { msg.deleted = true; await msg.save(); io.emit('message_deleted', msgId); }
  });

  socket.on('mark_viewed', async (msgId) => {
    const msg = await Message.findById(msgId);
    if (msg && !msg.viewed && msg.viewOnce) { msg.viewed = true; msg.text = "destruido"; await msg.save(); io.emit('message_viewed', msgId); }
  });

  socket.on('delete_chat', async (targetUser) => {
    if (!socket.username) return;
    await Message.deleteMany({ $or: [ { sender: socket.username, receiver: targetUser }, { sender: targetUser, receiver: socket.username } ] });
    const targetSocket = connectedUsers[targetUser]; if (targetSocket) io.to(targetSocket).emit('chat_deleted', socket.username);
    socket.emit('chat_deleted', targetUser);
  });

  socket.on('typing', (data) => {
    const receiverSocket = connectedUsers[data.receiver]; if (receiverSocket) io.to(receiverSocket).emit('typing', { user: socket.username, isTyping: data.isTyping });
  });

  socket.on('call_user', (data) => { const r = connectedUsers[data.userToCall]; if(r) io.to(r).emit('incoming_call', { from: socket.username, isVideo: data.isVideo }); });
  socket.on('accept_call', (data) => { const c = connectedUsers[data.to]; if(c) io.to(c).emit('call_accepted', { from: socket.username }); });
  socket.on('reject_call', (data) => { const c = connectedUsers[data.to]; if(c) io.to(c).emit('call_rejected', { from: socket.username }); });
  socket.on('end_call', (data) => { const o = connectedUsers[data.to]; if(o) io.to(o).emit('call_ended'); });
  socket.on('webrtc_offer', (data) => { const r = connectedUsers[data.to]; if(r) io.to(r).emit('webrtc_offer', { from: socket.username, sdp: data.sdp }); });
  socket.on('webrtc_answer', (data) => { const r = connectedUsers[data.to]; if(r) io.to(r).emit('webrtc_answer', { from: socket.username, sdp: data.sdp }); });
  socket.on('webrtc_ice_candidate', (data) => { const r = connectedUsers[data.to]; if(r) io.to(r).emit('webrtc_ice_candidate', { from: socket.username, candidate: data.candidate }); });

  socket.on('disconnect', () => {
    if (socket.username) { 
        delete connectedUsers[socket.username]; userStatus[socket.username] = 'background'; io.emit('online_status', Object.keys(connectedUsers)); 
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Servidor V16 corriendo en puerto " + PORT));
