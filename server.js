const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const SPAWN_POINTS = {
    labirent: { x: 730, y: 530 },
    bahce: { x: 730, y: 530 },
    laboratuvar: { x: 400, y: 550 }
};

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function spawnPowerUp(room) {
    if (room.powerUps.length >= 3) return;
    const type = Math.random() < 0.5 ? "speed" : "phantom";
    room.powerUps.push({
        id: Math.random().toString(36).substr(2, 9),
        type: type,
        x: Math.floor(Math.random() * 660) + 70,
        y: Math.floor(Math.random() * 460) + 70
    });
}

function startRoomGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "WAITING") return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) return;

    // Arayan ve Saklanan rollerini dağıt
    const shuffled = [...playerIds].sort(() => 0.5 - Math.random());
    const seekers = shuffled.slice(0, room.seekerCount);

    const spawn = SPAWN_POINTS[room.map] || { x: 730, y: 530 };

    playerIds.forEach(id => {
        room.players[id].isSeeker = seekers.includes(id);
        room.players[id].isAlive = true;
        room.players[id].x = spawn.x;
        room.players[id].y = spawn.y;
        room.players[id].isPhantom = false;
    });

    room.state = "HIDING";
    room.timer = 15;
    room.powerUps = [];

    io.to(roomId).emit("gameStarted", {
        state: room.state,
        timer: room.timer,
        players: room.players,
        map: room.map,
        powerUps: room.powerUps
    });

    if (room.interval) clearInterval(room.interval);

    room.interval = setInterval(() => {
        room.timer--;

        // Nadiren Power-Up Doğur (Her 15 saniyede bir şans)
        if (Math.random() < 0.25) {
            spawnPowerUp(room);
            io.to(roomId).emit("powerUpSync", room.powerUps);
        }

        if (room.state === "HIDING" && room.timer <= 0) {
            room.state = "SEEKING";
            room.timer = 90;
        } else if (room.state === "SEEKING" && room.timer <= 0) {
            room.state = "GAME_OVER";
            io.to(roomId).emit("gameOver", { winner: "Saklananlar Kazandı! 🏆" });
            clearInterval(room.interval);
            return;
        }

        const aliveHiders = Object.values(room.players).filter(p => !p.isSeeker && p.isAlive);
        if (room.state === "SEEKING" && aliveHiders.length === 0) {
            room.state = "GAME_OVER";
            io.to(roomId).emit("gameOver", { winner: "Arayanlar Kazandı! 😈" });
            clearInterval(room.interval);
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
    room.powerUps = [];
    Object.keys(room.players).forEach(id => {
        room.players[id].isSeeker = false;
        room.players[id].isAlive = true;
        room.players[id].isPhantom = false;
    });
    io.to(roomId).emit("roomReset", { state: room.state, players: room.players });
}

io.on('connection', (socket) => {
    let currentRoom = null;

    // Ping Hesaplama
    socket.on("pingCheck", (clientTime) => {
        socket.emit("pongCheck", clientTime);
    });

    // Açık lobileri listele
    socket.on("getPublicLobbies", () => {
        const list = [];
        for (let id in rooms) {
            if (!rooms[id].isPrivate && rooms[id].state === "WAITING") {
                list.push({
                    id,
                    map: rooms[id].map,
                    playersCount: Object.keys(rooms[id].players).length,
                    maxPlayers: rooms[id].maxPlayers,
                    seekerCount: rooms[id].seekerCount,
                    hiderCount: rooms[id].hiderCount
                });
            }
        }
        socket.emit("publicLobbiesList", list);
    });

    // Lobi Oluştur veya Katıl
    socket.on("joinOrCreate", ({ action, name, map, maxPlayers, seekerCount, hiderCount, isPrivate, customCode, roomId }) => {
        let targetId = null;

        if (action === "create") {
            targetId = (customCode && customCode.trim() !== "") ? customCode.toUpperCase().trim() : generateRoomCode();
            const total = parseInt(maxPlayers) || 5;
            const seekers = Math.min(total - 1, Math.max(1, parseInt(seekerCount) || 1));
            const hiders = total - seekers;

            rooms[targetId] = {
                map: map || "labirent",
                maxPlayers: total,
                seekerCount: seekers,
                hiderCount: hiders,
                isPrivate: !!isPrivate,
                state: "WAITING",
                timer: 0,
                players: {},
                powerUps: []
            };
        } else if (action === "join") {
            const code = (roomId || "").toUpperCase().trim();
            if (rooms[code] && Object.keys(rooms[code].players).length < rooms[code].maxPlayers && rooms[code].state === "WAITING") {
                targetId = code;
            } else {
                return socket.emit("errorMsg", "Lobi bulunamadı veya oyun başlamış!");
            }
        }

        currentRoom = targetId;
        socket.join(targetId);

        const room = rooms[targetId];
        const spawn = SPAWN_POINTS[room.map] || { x: 730, y: 530 };

        room.players[socket.id] = {
            id: socket.id,
            name: (name && name.trim() !== "") ? name.trim().substring(0, 10) : "Oyuncu",
            x: spawn.x,
            y: spawn.y,
            isSeeker: false,
            isAlive: true,
            isPhantom: false
        };

        socket.emit("joinedSuccess", {
            roomId: targetId,
            myId: socket.id,
            map: room.map,
            maxPlayers: room.maxPlayers,
            state: room.state,
            players: room.players
        });

        io.to(targetId).emit("playerListUpdate", { players: room.players, maxPlayers: room.maxPlayers });

        if (Object.keys(room.players).length >= room.maxPlayers) {
            startRoomGame(targetId);
        }
    });

    socket.on("playerMove", (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].x = data.x;
            rooms[currentRoom].players[socket.id].y = data.y;
            socket.to(currentRoom).emit("playerMoved", { id: socket.id, x: data.x, y: data.y });
        }
    });

    // Power-Up Toplama
    socket.on("collectPowerUp", (pId) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const idx = room.powerUps.findIndex(p => p.id === pId);
        if (idx !== -1) {
            const p = room.powerUps[idx];
            room.powerUps.splice(idx, 1);
            io.to(currentRoom).emit("powerUpApplied", { powerUpId: pId, collectorId: socket.id, type: p.type });
        }
    });

    // Görünmezlik Senkronizasyonu
    socket.on("setPhantom", (isPhantom) => {
        if (currentRoom && rooms[currentRoom]?.players[socket.id]) {
            rooms[currentRoom].players[socket.id].isPhantom = isPhantom;
            socket.to(currentRoom).emit("playerPhantomUpdate", { id: socket.id, isPhantom });
        }
    });

    // Yakalama
    socket.on("catchPlayer", (targetId) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        if (room.players[socket.id]?.isSeeker && room.players[targetId]?.isAlive) {
            room.players[targetId].isAlive = false;
            io.to(currentRoom).emit("playerCaught", { targetId });
        }
    });

    // Lobiden Ayrılma
    socket.on("leaveRoom", () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit("playerLeft", socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                if (rooms[currentRoom].interval) clearInterval(rooms[currentRoom].interval);
                delete rooms[currentRoom];
            }
            currentRoom = null;
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
server.listen(PORT, () => console.log(`🚀 ahmo.io port ${PORT}'de hazır!`));