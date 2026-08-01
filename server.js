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

// Создаем папку uploads, если её нет
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// Настройка Multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage });

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let onlineUsers = {}; // { socketId: { username, status } }
let messageHistory = [];

// Эндпоинт для загрузки файлов в облако
app.post('/upload', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Файлы не загружены' });
    }
    const filesData = req.files.map(file => ({
        fileName: file.originalname,
        fileUrl: `/uploads/${file.filename}`,
        fileType: file.mimetype
    }));
    res.json({ files: filesData });
});

io.on('connection', (socket) => {
    console.log('Новое подключение:', socket.id);

    // Вход пользователя в сеть
    socket.on('user_join', ({ username, isGhost }) => {
        const cleanName = username.trim();
        onlineUsers[socket.id] = { 
            username: cleanName, 
            status: isGhost ? 'offline' : 'online' 
        };

        // Рассылаем список юзеров
        io.emit('user_list', Object.values(onlineUsers));
        // Отправляем историю сообщений
        socket.emit('message_history', messageHistory);
    });

    // Переключение Ghost Mode
    socket.on('toggle_ghost', (isGhost) => {
        if (onlineUsers[socket.id]) {
            onlineUsers[socket.id].status = isGhost ? 'offline' : 'online';
            io.emit('user_list', Object.values(onlineUsers));
        }
    });

    // Отправка нового сообщения
    socket.on('send_message', (data) => {
        const senderInfo = onlineUsers[socket.id];
        const senderName = senderInfo ? senderInfo.username : 'Аноним';

        const newMsg = {
            id: 'msg-' + Date.now() + '-' + Math.round(Math.random() * 1000),
            sender: senderName,
            text: data.text || '',
            isEncrypted: data.isEncrypted || false,
            replyTo: data.replyTo || null,
            files: data.files || [],
            timestamp: data.timestamp,
            reactions: {},
            status: 'sent'
        };

        messageHistory.push(newMsg);
        if (messageHistory.length > 200) messageHistory.shift(); // Храним последние 200 сообщений

        io.emit('new_message', newMsg);
    });

    // ================= WebRTC & Звонки & Молоточек =================
    // Сервер пересылает сигналы звонков, WebRTC офферы и удары молоточком
    socket.on('webrtc_signal', (data) => {
        io.emit('webrtc_signal', data);
    });

    // Подтверждение доставки/прочтения
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

    // Реакции (смайлики)
    socket.on('add_reaction', ({ msgId, emoji }) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        const msg = messageHistory.find(m => m.id === msgId);
        if (msg) {
            if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
            
            const idx = msg.reactions[emoji].indexOf(user.username);
            if (idx > -1) {
                msg.reactions[emoji].splice(idx, 1); // Повторный клик — убираем реакцию
            } else {
                msg.reactions[emoji].push(user.username); // Добавляем реакцию
            }

            io.emit('reaction_updated', { msgId, reactions: msg.reactions });
        }
    });

    // Статус "Печатает..."
    socket.on('typing', (isTyping) => {
        const user = onlineUsers[socket.id];
        if (user) {
            socket.broadcast.emit('user_typing', { username: user.username, isTyping });
        }
    });

    // Редактирование сообщения
    socket.on('edit_message', ({ msgId, newText }) => {
        const msg = messageHistory.find(m => m.id === msgId);
        if (msg) {
            msg.text = newText;
            io.emit('message_edited', { msgId, newText });
        }
    });

    // Удаление сообщения
    socket.on('delete_message', ({ msgId }) => {
        messageHistory = messageHistory.filter(m => m.id !== msgId);
        io.emit('message_deleted', { msgId });
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        delete onlineUsers[socket.id];
        io.emit('user_list', Object.values(onlineUsers));
        console.log('Отключился:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
