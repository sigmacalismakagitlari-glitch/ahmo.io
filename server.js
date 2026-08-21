const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Odalar ve Lobi Sistemi
const rooms = {};
const SPAWN_POINT = { x: 730, y: 530 };

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function startRoomGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "WAITING") return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) return;

    // Arayan sayısını belirle (5'ten fazlaysa 2 arayan, yoksa 1)
    const seekerCount = playerIds.length > 5 ? 2 : 1;
    
    // Rastgele arayanları seç
    const shuffled = [...playerIds].sort(() => 0.5 - Math.random());
    const seekers = shuffled.slice(0, seekerCount);

    playerIds.forEach(id => {
        const isSeeker = seekers.includes(id);
        room.players[id].isSeeker = isSeeker;
        room.players[id].isAlive = true;
        room.players[id].x = SPAWN_POINT.x;
        room.players[id].y = SPAWN_POINT.y;
    });

    room.state = "HIDING";
    room.timer = 15; // 15 saniye saklanma

    io.to(roomId).emit("gameStarted", {
        state: room.state,
        timer: room.timer,
        players: room.players
    });

    if (room.interval) clearInterval(room.interval);

    room.interval = setInterval(() => {
        room.timer--;

        if (room.state === "HIDING" && room.timer <= 0) {
            room.state = "SEEKING";
            room.timer = 90; // 90 saniye av
        } else if (room.state === "SEEKING" && room.timer <= 0) {
            room.state = "GAME_OVER";
            io.to(roomId).emit("gameOver", { winner: "HIDERS" });
            clearInterval(room.interval);
            setTimeout(() => resetRoom(roomId), 4000);
            return;
        }

        // Saklananların hepsi elendi mi?
        const aliveHiders = Object.values(room.players).filter(p => !p.isSeeker && p.isAlive);
        if (room.state === "SEEKING" && aliveHiders.length === 0) {
            room.state = "GAME_OVER";
            io.to(roomId).emit("gameOver", { winner: "SEEKERS" });
            clearInterval(room.interval);
            setTimeout(() => resetRoom(roomId), 4000);
            return;
        }

        io.to(roomId).emit("timerUpdate", { state: room.state, timer: room.timer });
    }, 1000);
}

function resetRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = "WAITING";
    room.timer = 0;
    Object.keys(room.players).forEach(id => {
        room.players[id].isSeeker = false;
        room.players[id].isAlive = true;
    });
    io.to(roomId).emit("roomReset", { state: room.state, players: room.players });
}

io.on('connection', (socket) => {
    let currentRoom = null;

    // Hızlı Bağlan veya Lobi Oluştur
    socket.on("joinGame", ({ type, roomCode, maxPlayers }) => {
        let targetRoomId = null;

        if (type === "quick") {
            // Uygun bekleme odası bul
            for (let rId in rooms) {
                if (rooms[rId].state === "WAITING" && Object.keys(rooms[rId].players).length < rooms[rId].maxPlayers) {
                    targetRoomId = rId;
                    break;
                }
            }
            if (!targetRoomId) {
                targetRoomId = generateRoomCode();
                rooms[targetRoomId] = { maxPlayers: 5, state: "WAITING", timer: 0, players: {} };
            }
        } else if (type === "create") {
            targetRoomId = generateRoomCode();
            const limit = Math.max(2, Math.min(10, parseInt(maxPlayers) || 5));
            rooms[targetRoomId] = { maxPlayers: limit, state: "WAITING", timer: 0, players: {} };
        } else if (type === "join") {
            const code = (roomCode || "").toUpperCase().trim();
            if (rooms[code] && Object.keys(rooms[code].players).length < rooms[code].maxPlayers && rooms[code].state === "WAITING") {
                targetRoomId = code;
            } else {
                return socket.emit("joinError", "Oda bulunamadı veya dolu!");
            }
        }

        currentRoom = targetRoomId;
        socket.join(targetRoomId);

        rooms[targetRoomId].players[socket.id] = {
            id: socket.id,
            x: SPAWN_POINT.x,
            y: SPAWN_POINT.y,
            isSeeker: false,
            isAlive: true
        };

        const room = rooms[targetRoomId];
        socket.emit("joinedSuccess", {
            roomId: targetRoomId,
            myId: socket.id,
            maxPlayers: room.maxPlayers,
            state: room.state,
            players: room.players
        });

        io.to(targetRoomId).emit("playerListUpdate", { players: room.players, maxPlayers: room.maxPlayers });

        // Lobi dolduysa veya en az 2 kişi varsa başlat
        if (Object.keys(room.players).length >= room.maxPlayers) {
            startRoomGame(targetRoomId);
        }
    });

    socket.on("playerMove", (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].x = data.x;
            rooms[currentRoom].players[socket.id].y = data.y;
            socket.to(currentRoom).emit("playerMoved", { id: socket.id, x: data.x, y: data.y });
        }
    });

    socket.on("catchPlayer", (targetId) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.players[socket.id]?.isSeeker && room.players[targetId]?.isAlive) {
            room.players[targetId].isAlive = false;
            io.to(currentRoom).emit("playerCaught", { targetId });
        }
    });

    socket.on("disconnect", () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit("playerLeft", socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                if (rooms[currentRoom].interval) clearInterval(rooms[currentRoom].interval);
                delete rooms[currentRoom];
            } else if (Object.keys(rooms[currentRoom].players).length < 2) {
                resetRoom(currentRoom);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ahmo.io sunucusu port ${PORT}'de aktif!`));