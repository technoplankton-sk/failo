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

    const UPLOAD_DIR = userDataPath 
        ? path.join(userDataPath, 'EliteMessengerUploads')
        : path.join(__dirname, 'uploads');

    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    app.use('/uploads', express.static(UPLOAD_DIR));

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const correctName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, Date.now() + '-' + correctName);
        }
    });
    const upload = multer({ storage });

    app.post('/upload', upload.array('files', 10), (req, res) => {
        if (!req.files || req.files.length === 0) return res.status(400).send('Файлы не загружены');
        
        const fileData = req.files.map(file => {
            const correctOriginalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            return {
                fileUrl: `/uploads/${file.filename}`,
                fileName: correctOriginalName,
                fileSize: file.size,
                fileType: file.mimetype
            };
        });

        res.json({ files: fileData });
    });

    let messages = [];
    let users = {}; 

    function broadcastUserList() {
        // Если у юзера включен Ghost Mode, он виден как offline для остальных
        const publicUsers = Object.values(users).map(u => ({
            username: u.username,
            status: u.isGhost ? 'offline' : u.status
        }));
        io.emit('user_list', publicUsers);
    }

    io.on('connection', (socket) => {
        console.log(`[+] Подключение: ${socket.id}`);

        socket.on('user_join', ({ username, isGhost }) => {
            users[socket.id] = { username, status: 'online', isGhost: !!isGhost };
            broadcastUserList();
            socket.emit('message_history', messages);
        });

        socket.on('toggle_ghost', (isGhost) => {
            if (users[socket.id]) {
                users[socket.id].isGhost = isGhost;
                broadcastUserList();
            }
        });

        socket.on('send_message', (data) => {
            const userObj = users[socket.id];
            const senderName = userObj ? userObj.username : 'Аноним';

            const msg = {
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                sender: senderName,
                senderId: socket.id,
                text: data.text || '',
                isEncrypted: !!data.isEncrypted,
                replyTo: data.replyTo || null,
                files: data.files || [],
                timestamp: data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                status: 'sent',
                reactions: {}
            };
            messages.push(msg);
            io.emit('new_message', msg);
        });

        socket.on('add_reaction', ({ msgId, emoji }) => {
            const msg = messages.find(m => m.id === msgId);
            const userObj = users[socket.id];
            if (!msg || !userObj) return;

            const username = userObj.username;
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
        });

        socket.on('ack_delivery', ({ msgId }) => {
            const msg = messages.find(m => m.id === msgId);
            if (msg && msg.status === 'sent') {
                msg.status = 'delivered';
                io.emit('message_status_update', { msgId, status: 'delivered' });
            }
        });

        socket.on('ack_read', ({ msgId }) => {
            const userObj = users[socket.id];
            // В Ghost Mode синие галочки чтения не отправляются!
            if (userObj && userObj.isGhost) return;

            const msg = messages.find(m => m.id === msgId);
            if (msg) {
                msg.status = 'read';
                io.emit('message_status_update', { msgId, status: 'read' });
            }
        });

        socket.on('typing', (isTyping) => {
            const userObj = users[socket.id];
            if (userObj && !userObj.isGhost) {
                socket.broadcast.emit('user_typing', { username: userObj.username, isTyping });
            }
        });

        socket.on('edit_message', ({ msgId, newText }) => {
            const msg = messages.find(m => m.id === msgId);
            const userObj = users[socket.id];
            if (msg && userObj && msg.sender === userObj.username) {
                msg.text = newText;
                msg.isEdited = true;
                io.emit('message_edited', { msgId, newText, isEdited: true });
            }
        });

        socket.on('delete_message', ({ msgId, forEveryone }) => {
            const msgIndex = messages.findIndex(m => m.id === msgId);
            const userObj = users[socket.id];
            if (msgIndex !== -1 && userObj && messages[msgIndex].sender === userObj.username && forEveryone) {
                messages.splice(msgIndex, 1);
                io.emit('message_deleted', { msgId });
            }
        });

        socket.on('disconnect', () => {
            if (users[socket.id]) {
                users[socket.id].status = 'offline';
                broadcastUserList();
                setTimeout(() => {
                    delete users[socket.id];
                    broadcastUserList();
                }, 10000);
            }
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
