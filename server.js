const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

function startServer(userDataPath) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: 1e8 });

    app.use(require('cors')());
    app.use(express.json());
    app.use(express.static(__dirname));

    // Вычисляем путь к папке загрузок
    const UPLOAD_DIR = userDataPath 
        ? path.join(userDataPath, 'EliteMessengerUploads')
        : path.join(__dirname, 'uploads');

    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    app.use('/uploads', express.static(UPLOAD_DIR));

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    });
    const upload = multer({ storage });

    app.post('/upload', upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).send('Файл не загружен');
        res.json({
            fileUrl: `/uploads/${req.file.filename}`,
            fileName: req.file.originalname,
            fileSize: req.file.size
        });
    });

    let messages = [];
    let users = {};

    io.on('connection', (socket) => {
        console.log(`[+] Подключение: ${socket.id}`);

        socket.on('user_join', (username) => {
            users[socket.id] = username;
            io.emit('user_list', Object.values(users));
            socket.emit('message_history', messages);
        });

        socket.on('send_message', (data) => {
            const msg = {
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                sender: users[socket.id] || 'Аноним',
                senderId: socket.id,
                text: data.text || '',
                file: data.file || null,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                status: 'sent',
                reactions: {}
            };
            messages.push(msg);
            io.emit('new_message', msg);
        });

        socket.on('add_reaction', ({ msgId, emoji }) => {
            const msg = messages.find(m => m.id === msgId);
            const username = users[socket.id];
            if (msg && username) {
                if (!msg.reactions) msg.reactions = {};
                if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
                
                const userIdx = msg.reactions[emoji].indexOf(username);
                if (userIdx !== -1) {
                    msg.reactions[emoji].splice(userIdx, 1);
                    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
                } else {
                    msg.reactions[emoji].push(username);
                }

                io.emit('reaction_updated', { msgId, reactions: msg.reactions });
            }
        });

        socket.on('ack_delivery', ({ msgId }) => {
            const msg = messages.find(m => m.id === msgId);
            if (msg) {
                msg.status = 'delivered';
                io.emit('message_status_update', { msgId, status: 'delivered' });
            }
        });

        socket.on('ack_read', ({ msgId }) => {
            const msg = messages.find(m => m.id === msgId);
            if (msg) {
                msg.status = 'read';
                io.emit('message_status_update', { msgId, status: 'read' });
            }
        });

        socket.on('typing', (isTyping) => {
            socket.broadcast.emit('user_typing', { username: users[socket.id], isTyping });
        });

        socket.on('edit_message', ({ msgId, newText }) => {
            const msg = messages.find(m => m.id === msgId);
            if (msg && msg.senderId === socket.id) {
                msg.text = newText;
                msg.isEdited = true;
                io.emit('message_edited', { msgId, newText, isEdited: true });
            }
        });

        socket.on('delete_message', ({ msgId, forEveryone }) => {
            const msgIndex = messages.findIndex(m => m.id === msgId);
            if (msgIndex !== -1 && forEveryone) {
                messages.splice(msgIndex, 1);
                io.emit('message_deleted', { msgId });
            }
        });

        socket.on('disconnect', () => {
            delete users[socket.id];
            io.emit('user_list', Object.values(users));
        });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`>>> Сервер запущен на порту ${PORT}`);
    });

    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = startServer;
