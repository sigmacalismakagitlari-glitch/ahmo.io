const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

// Harita Doğma Noktaları
const SPAWN_POINTS = {
    labirent: { x: 730, y: 530 },
    bahce: { x: 730, y: 530 },
    laboratuvar: { x: 400, y: 550 }
};

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function spawnCoin(room) {
    if (room.coins.length >= 8) return;
    room.coins.push({
        id: Math.random().toString(36).substr(2, 9),
        x: Math.floor(Math.random() * 680) + 60,
        y: Math.floor(Math.random() * 480) + 60
    });
}

function startRoomGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "WAITING") return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) return;

    const seekerCount = playerIds.length > 5 ? 2 : 1;
    const shuffled = [...playerIds].sort(() => 0.5 - Math.random());
    const seekers = shuffled.slice(0, seekerCount);

    const spawn = SPAWN_POINTS[room.map] || { x: 730, y: 530 };

    playerIds.forEach(id => {
        room.players[id].isSeeker = seekers.includes(id);
        room.players[id].isAlive = true;
        room.players[id].isFrozen = false;
        room.players[id].x = spawn.x;
        room.players[id].y = spawn.y;
    });

    room.state = "HIDING";
    room.timer = 15;
    room.traps = [];
    room.coins = [];

    for (let i = 0; i < 5; i++) spawnCoin(room);

    io.to(roomId).emit("gameStarted", {
        state: room.state,
        timer: room.timer,
        players: room.players,
        map: room.map,
        coins: room.coins
    });

    if (room.interval) clearInterval(room.interval);

    room.interval = setInterval(() => {
        room.timer--;

        // Coin doğurma
        if (Math.random() < 0.3) spawnCoin(room);

        if (room.state === "HIDING" && room.timer <= 0) {
            room.state = "SEEKING";
            room.timer = 90;
        } else if (room.state === "SEEKING" && room.timer <= 0) {
            room.state = "GAME_OVER";
            io.to(roomId).emit("gameOver", { winner: "HIDERS" });
            clearInterval(room.interval);
            setTimeout(() => resetRoom(roomId), 4000);
            return;
        }

        const aliveHiders = Object.values(room.players).filter(p => !p.isSeeker && p.isAlive);
        if (room.state === "SEEKING" && aliveHiders.length === 0) {
            room.state = "GAME_OVER";
            io.to(roomId).emit("gameOver", { winner: "SEEKERS" });
            clearInterval(room.interval);
            setTimeout(() => resetRoom(roomId), 4000);
            return;
        }

        io.to(roomId).emit("timerUpdate", { state: room.state, timer: room.timer, coins: room.coins });
    }, 1000);
}

function resetRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = "WAITING";
    room.timer = 0;
    room.traps = [];
    room.coins = [];
    Object.keys(room.players).forEach(id => {
        room.players[id].isSeeker = false;
        room.players[id].isAlive = true;
        room.players[id].isFrozen = false;
    });
    io.to(roomId).emit("roomReset", { state: room.state, players: room.players });
}

io.on('connection', (socket) => {
    let currentRoom = null;

    // Açık lobileri listele
    socket.on("getPublicLobbies", () => {
        const list = [];
        for (let id in rooms) {
            if (!rooms[id].isPrivate && rooms[id].state === "WAITING") {
                list.push({
                    id, map: rooms[id].map,
                    playersCount: Object.keys(rooms[id].players).length,
                    maxPlayers: rooms[id].maxPlayers
                });
            }
        }
        socket.emit("publicLobbiesList", list);
    });

    // Lobi Oluştur veya Katıl
    socket.on("joinOrCreate", ({ action, map, maxPlayers, isPrivate, customCode, roomId }) => {
        let targetId = null;

        if (action === "create") {
            targetId = (customCode && customCode.trim() !== "") ? customCode.toUpperCase().trim() : generateRoomCode();
            rooms[targetId] = {
                map: map || "labirent",
                maxPlayers: Math.max(2, Math.min(10, parseInt(maxPlayers) || 5)),
                isPrivate: !!isPrivate,
                state: "WAITING",
                timer: 0,
                players: {},
                coins: [],
                traps: []
            };
        } else if (action === "join") {
            const code = (roomId || "").toUpperCase().trim();
            if (rooms[code] && Object.keys(rooms[code].players).length < rooms[code].maxPlayers && rooms[code].state === "WAITING") {
                targetId = code;
            } else {
                return socket.emit("errorMsg", "Lobi bulunamadı veya dolu!");
            }
        }

        currentRoom = targetId;
        socket.join(targetId);

        const room = rooms[targetId];
        const spawn = SPAWN_POINTS[room.map] || { x: 730, y: 530 };

        room.players[socket.id] = {
            id: socket.id,
            x: spawn.x,
            y: spawn.y,
            isSeeker: false,
            isAlive: true,
            isFrozen: false
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

    // Hareket
    socket.on("playerMove", (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            if (rooms[currentRoom].players[socket.id].isFrozen) return;
            rooms[currentRoom].players[socket.id].x = data.x;
            rooms[currentRoom].players[socket.id].y = data.y;
            socket.to(currentRoom).emit("playerMoved", { id: socket.id, x: data.x, y: data.y });
        }
    });

    // Coin Toplama
    socket.on("collectCoin", (coinId) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const index = room.coins.findIndex(c => c.id === coinId);
        if (index !== -1) {
            room.coins.splice(index, 1);
            io.to(currentRoom).emit("coinCollected", { coinId, collectorId: socket.id });
        }
    });

    // Tuzak Kurma
    socket.on("placeTrap", ({ type, x, y }) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const trap = { id: Math.random().toString(36).substr(2, 9), type, x, y, ownerId: socket.id };
        rooms[currentRoom].traps.push(trap);
        io.to(currentRoom).emit("trapPlaced", trap);
    });

    // Tuzağa Basma
    socket.on("triggerTrap", (trapId) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const trapIndex = room.traps.findIndex(t => t.id === trapId);
        if (trapIndex === -1) return;

        const trap = room.traps[trapIndex];
        const victim = room.players[socket.id];
        if (!victim || !victim.isAlive) return;

        // Yapışkan tuzak (Hider kurar, Seeker'ı 3s dondurur)
        if (trap.type === "sticky" && victim.isSeeker) {
            room.traps.splice(trapIndex, 1);
            victim.isFrozen = true;
            io.to(currentRoom).emit("trapTriggered", { trapId, victimId: socket.id, duration: 3 });
            setTimeout(() => {
                if (victim) victim.isFrozen = false;
                io.to(currentRoom).emit("playerUnfrozen", socket.id);
            }, 3000);
        }
        // Jail tuzak (Seeker kurar, Hider'ı 5s dondurur ve yerini gösterir)
        else if (trap.type === "jail" && !victim.isSeeker) {
            room.traps.splice(trapIndex, 1);
            victim.isFrozen = true;
            io.to(currentRoom).emit("trapTriggered", { trapId, victimId: socket.id, duration: 5, alertSeeker: true, x: victim.x, y: victim.y });
            setTimeout(() => {
                if (victim) victim.isFrozen = false;
                io.to(currentRoom).emit("playerUnfrozen", socket.id);
            }, 5000);
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