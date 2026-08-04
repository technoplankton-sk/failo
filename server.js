const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// Хранилище зарегистрированных пользователей в файле users.json
const usersFile = path.join(__dirname, 'users.json');
let registeredUsers = {};
if (fs.existsSync(usersFile)) {
    try { registeredUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}
}

function saveUsers() {
    try {
        fs.writeFileSync(usersFile, JSON.stringify(registeredUsers, null, 2), 'utf8');
    } catch(e) {}
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + originalName);
    }
});
const upload = multer({ storage });

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let onlineUsers = {}; // { socketId: { username, status } }
let messageHistory = [];

app.post('/upload', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Файлы не загружены' });
    }
    const filesData = req.files.map(file => {
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        return {
            fileName: decodedName,
            fileUrl: `/uploads/${file.filename}`,
            fileType: file.mimetype
        };
    });
    res.json({ files: filesData });
});

io.on('connection', (socket) => {
    // Регистрация нового пользователя
    socket.on('register_user', ({ username, password }) => {
        const cleanName = username.trim();
        const userKey = cleanName.toLowerCase();
        
        if (registeredUsers[userKey]) {
            socket.emit('register_response', { success: false, message: 'Это имя уже занято!' });
        } else {
            registeredUsers[userKey] = { username: cleanName, password: password };
            saveUsers();
            socket.emit('register_response', { success: true });
        }
    });

    // Авторизация с автовосстановлением аккаунта после сброса контейнера Render
    socket.on('user_login', ({ username, password, isGhost }) => {
        const cleanName = username.trim();
        const userKey = cleanName.toLowerCase();
        let userInDb = registeredUsers[userKey];

        // Если файл был стерт при сбросе контейнера Render, восстанавливаем учетную запись по переданным данным
        if (!userInDb) {
            registeredUsers[userKey] = { username: cleanName, password: password };
            saveUsers();
            userInDb = registeredUsers[userKey];
        }

        if (userInDb.password !== password) {
            socket.emit('login_response', { success: false, message: 'Неверный пароль!' });
            return;
        }

        onlineUsers[socket.id] = { username: cleanName, status: isGhost ? 'offline' : 'online' };
        socket.emit('login_response', { success: true });

        // Отправляем список зарегистрированных пользователей
        const allUsersList = Object.values(registeredUsers).map(u => {
            const isOnline = Object.values(onlineUsers).some(o => o.username.toLowerCase() === u.username.toLowerCase() && o.status === 'online');
            return { username: u.username, status: isOnline ? 'online' : 'offline' };
        });

        io.emit('user_list', allUsersList);
        socket.emit('message_history', messageHistory);
    });

    socket.on('toggle_ghost', (isGhost) => {
        if (onlineUsers[socket.id]) {
            onlineUsers[socket.id].status = isGhost ? 'offline' : 'online';
            const allUsersList = Object.values(registeredUsers).map(u => {
                const isOnline = Object.values(onlineUsers).some(o => o.username.toLowerCase() === u.username.toLowerCase() && o.status === 'online');
                return { username: u.username, status: isOnline ? 'online' : 'offline' };
            });
            io.emit('user_list', allUsersList);
        }
    });

    socket.on('send_message', (data) => {
        const senderInfo = onlineUsers[socket.id];
        const senderName = senderInfo ? senderInfo.username : 'Аноним';

        const newMsg = {
            id: 'msg-' + Date.now() + '-' + Math.round(Math.random() * 1000),
            sender: senderName,
            text: data.text || '',
            isEncrypted: data.isEncrypted || false,
            targetPrivate: data.targetPrivate || null,
            replyTo: data.replyTo || null,
            files: data.files || [],
            timestamp: data.timestamp,
            reactions: {},
            status: 'sent'
        };

        messageHistory.push(newMsg);
        if (messageHistory.length > 300) messageHistory.shift();

        io.emit('new_message', newMsg);
    });

    socket.on('webrtc_signal', (data) => {
        io.emit('webrtc_signal', data);
    });

    socket.on('ack_delivery', ({ msgId }) => {
        const msg = messageHistory.find(m => m.id === msgId);
        if (msg && msg.status !== 'read') {
            msg.status = 'delivered';
            io.emit('message_status_update', { msgId, status: 'delivered' });
        }
    });

    socket.on('ack_read', ({ msgId }) => {
        const msg = messageHistory.find(m => m.id === msgId);
        if (msg) {
            msg.status = 'read';
            io.emit('message_status_update', { msgId, status: 'read' });
        }
    });

    socket.on('add_reaction', ({ msgId, emoji }) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        const msg = messageHistory.find(m => m.id === msgId);
        if (msg) {
            if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
            const idx = msg.reactions[emoji].indexOf(user.username);
            if (idx > -1) {
                msg.reactions[emoji].splice(idx, 1);
            } else {
                msg.reactions[emoji].push(user.username);
            }
            io.emit('reaction_updated', { msgId, reactions: msg.reactions });
        }
    });

    socket.on('typing', (isTyping) => {
        const user = onlineUsers[socket.id];
        if (user) {
            socket.broadcast.emit('user_typing', { username: user.username, isTyping });
        }
    });

    socket.on('edit_message', ({ msgId, newText, editTime }) => {
        const msg = messageHistory.find(m => m.id === msgId);
        if (msg) {
            msg.text = newText;
            msg.editTime = editTime;
            io.emit('message_edited', { msgId, newText, editTime });
        }
    });

    socket.on('delete_message', ({ msgId }) => {
        messageHistory = messageHistory.filter(m => m.id !== msgId);
        io.emit('message_deleted', { msgId });
    });

    socket.on('delete_user_account', ({ username }) => {
        delete registeredUsers[username.toLowerCase()];
        saveUsers();
        delete onlineUsers[socket.id];
        const allUsersList = Object.values(registeredUsers).map(u => {
            const isOnline = Object.values(onlineUsers).some(o => o.username.toLowerCase() === u.username.toLowerCase() && o.status === 'online');
            return { username: u.username, status: isOnline ? 'online' : 'offline' };
        });
        io.emit('user_list', allUsersList);
    });

    socket.on('disconnect', () => {
        delete onlineUsers[socket.id];
        const allUsersList = Object.values(registeredUsers).map(u => {
            const isOnline = Object.values(onlineUsers).some(o => o.username.toLowerCase() === u.username.toLowerCase() && o.status === 'online');
            return { username: u.username, status: isOnline ? 'online' : 'offline' };
        });
        io.emit('user_list', allUsersList);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
