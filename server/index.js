const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const THREE = require('three'); // Import THREE for server-side raycasting

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Game State Variables ---
const players = {}; // { socket.id: { username, score, status: 'WAITING'/'READY'/'PLAYING'/'SPECTATING' } }
let targets = [];
let gameState = 'WAITING'; // WAITING, COUNTDOWN, PLAYING, ENDED
let playerTurnOrder = []; // Array of socket.ids of players in the current game (status PLAYING)
let lobbyPlayers = []; // Array of socket.ids of players waiting or ready (status WAITING/READY)
let currentPlayerIndex = 0;
let remainingShots = 3;
const GAME_DURATION_MS = 90000; // Changed from 10000 to 90000 (90 seconds)
let gameTimerInterval = null;
let gameEndTime = 0;
const MAX_TARGETS = 5;
const SHOTS_PER_TURN = 3;
const COUNTDOWN_SECONDS = 5;
let countdownTimerInterval = null;
let countdownValue = COUNTDOWN_SECONDS;
const MIN_SPAWN_DISTANCE_SQ = 4.0; // Minimum distance squared (2*2) between targets
const MAX_SPAWN_ATTEMPTS = 10; // Max tries to find a free spot

// Raycaster for server-side hit detection
const serverRaycaster = new THREE.Raycaster();

// Function to spawn a new target
function spawnTarget() {
  if (gameState !== 'PLAYING' || targets.length >= MAX_TARGETS) return;

  let attempts = 0;
  let validPositionFound = false;
  let potentialPos = { x: 0, y: 0, z: 0 };

  while (attempts < MAX_SPAWN_ATTEMPTS && !validPositionFound) {
    attempts++;
    // Generate potential position
    potentialPos.x = -7 + Math.random() * 14;
    potentialPos.y = 5 + Math.random() * 5;  // Range 5 to 10
    potentialPos.z = -16 - Math.random() * 2; // Range -16 to -18 (Moved back by 15)

    // Check distance to existing targets
    let tooClose = false;
    for (const existingTarget of targets) {
      const dx = existingTarget.x - potentialPos.x;
      const dy = existingTarget.y - potentialPos.y;
      const dz = existingTarget.z - potentialPos.z;
      const distSq = dx * dx + dy * dy + dz * dz; // Check squared distance (faster)
      if (distSq < MIN_SPAWN_DISTANCE_SQ) {
        tooClose = true;
        break; // No need to check further
      }
    }

    if (!tooClose) {
      validPositionFound = true;
    }
  }

  if (!validPositionFound) {
    console.log("Could not find suitable spawn location after", MAX_SPAWN_ATTEMPTS, "attempts.");
    return; // Skip spawning this time
  }

  // Create target at the validated position
  const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
  const target = {
    id,
    x: potentialPos.x,
    y: potentialPos.y,
    z: potentialPos.z,
    dir: Math.random() < 0.5 ? 1 : -1,
    speed: 0.06 + Math.random() * 0.08 // Increased speed range
  };

  targets.push(target);
  console.log("Spawned target:", target.id, "at y:", target.y.toFixed(2), "z:", target.z.toFixed(2));
  io.emit('targetUpdate', targets);
}

// Function to get current game state data to send to clients
function getGameStateData() {
    const currentTurnPlayerId = (gameState === 'PLAYING' && playerTurnOrder.length > 0) ? playerTurnOrder[currentPlayerIndex] : null;
    // Include lobby players in the data sent to clients
    const lobbyPlayerDetails = lobbyPlayers.map(id => players[id] ? { id, ...players[id] } : null).filter(p => p);
    const playingPlayerDetails = playerTurnOrder.map(id => players[id] ? { id, ...players[id] } : null).filter(p => p);

    return {
        gameState,
        countdownValue: gameState === 'COUNTDOWN' ? countdownValue : null,
        currentTurnPlayerId,
        username: currentTurnPlayerId ? players[currentTurnPlayerId]?.username : null,
        remainingShots: gameState === 'PLAYING' ? remainingShots : null,
        gameEndTime: gameState === 'PLAYING' ? gameEndTime : null,
        // Send ALL player details (lobby, playing, spectators) separately?
        // Or combine them and let client filter?
        // Let's send combined for now.
        allPlayers: players,
        lobbyPlayers: lobbyPlayerDetails, // For lobby UI
        playingPlayers: playingPlayerDetails // For scoreboard during play
    };
}

// Function to check if all lobby players are ready
function checkAllReady() {
    if (lobbyPlayers.length === 0) return false; // Need at least one player
    return lobbyPlayers.every(id => players[id] && players[id].status === 'READY');
}

// Function to start the countdown
function startCountdown() {
    if (gameState !== 'WAITING' || !checkAllReady()) return;

    console.log("All players ready! Starting countdown...");
    gameState = 'COUNTDOWN';
    countdownValue = COUNTDOWN_SECONDS;
    io.emit('gameStateUpdate', getGameStateData()); // Notify about countdown start

    if (countdownTimerInterval) clearInterval(countdownTimerInterval);
    countdownTimerInterval = setInterval(() => {
        countdownValue--;
        console.log(`Countdown: ${countdownValue}`);
        io.emit('gameStateUpdate', getGameStateData()); // Send countdown value

        if (countdownValue <= 0) {
            clearInterval(countdownTimerInterval);
            countdownTimerInterval = null;
            startGame(); // Start the actual game
        }
    }, 1000);
}

// Function to start the actual game logic (called after countdown)
function startGame() {
    // Transition players from lobby to playing
    playerTurnOrder = [...lobbyPlayers]; // Players who were ready are now playing
    lobbyPlayers = []; // Clear lobby

    if (playerTurnOrder.length === 0) {
        console.log("No players to start game with after countdown? Resetting.");
        resetGame();
        return;
    }

    console.log("Countdown finished! Starting game!");
    gameState = 'PLAYING';
    currentPlayerIndex = 0;
    remainingShots = SHOTS_PER_TURN;
    gameEndTime = Date.now() + GAME_DURATION_MS;
    targets = []; // Clear existing targets

    // Set player statuses to PLAYING
    playerTurnOrder.forEach(id => {
        if (players[id]) players[id].status = 'PLAYING';
    });

    // Start game timer for duration
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = setInterval(() => {
        if (Date.now() >= gameEndTime) {
            endGame();
        } 
    }, 1000);

    // Spawn initial targets
    for(let i = 0; i < MAX_TARGETS; i++) spawnTarget();

    io.emit('gameStateUpdate', getGameStateData());
    console.log("Game started. Current turn:", players[playerTurnOrder[currentPlayerIndex]]?.username);
}

// Function to end the game
function endGame() {
    console.log("Game ending!");
    gameState = 'ENDED';
    if (gameTimerInterval) clearInterval(gameTimerInterval); gameTimerInterval = null;
    if (countdownTimerInterval) clearInterval(countdownTimerInterval); countdownTimerInterval = null; // Clear countdown too
    targets = [];
    io.emit('targetUpdate', targets);

     // Update status of playing players (maybe back to WAITING or keep as ENDED?)
     // Let's reset them to WAITING, ready for potential restart.
     playerTurnOrder.forEach(id => {
         if(players[id]) players[id].status = 'WAITING';
     });
     // Move ended players back to lobby list
     lobbyPlayers = [...playerTurnOrder, ...lobbyPlayers];
     playerTurnOrder = []; // Clear playing list
     currentPlayerIndex = 0;

    io.emit('gameStateUpdate', getGameStateData());
    console.log("Game ended. Final scores:", players);
}

// Function to switch to the next player's turn
function nextTurn() {
    if (playerTurnOrder.length === 0) {
         console.log("No players left, ending game.");
         endGame(); // Or handle differently if desired
         return;
    }
    currentPlayerIndex = (currentPlayerIndex + 1) % playerTurnOrder.length;
    remainingShots = SHOTS_PER_TURN;
    console.log("Next turn:", players[playerTurnOrder[currentPlayerIndex]]?.username);
    io.emit('gameStateUpdate', getGameStateData());
}

// Function to reset the game (called on restart request or auto-reset)
function resetGame() {
    console.log("[Server] Resetting game state requested.");
    gameState = 'WAITING';
    if (gameTimerInterval) clearInterval(gameTimerInterval); gameTimerInterval = null;
    if (countdownTimerInterval) clearInterval(countdownTimerInterval); countdownTimerInterval = null;
    targets = [];
    // Clear player scores and set status to WAITING for ALL players
    Object.keys(players).forEach(id => {
        if (players[id]) {
             players[id].score = 0;
             players[id].status = 'WAITING'; // Reset everyone to waiting
        }
    });
    // Reset lists based on current players
    lobbyPlayers = Object.keys(players); // Everyone starts in the lobby
    playerTurnOrder = [];
    currentPlayerIndex = 0;
    remainingShots = SHOTS_PER_TURN;
    gameEndTime = 0;

    io.emit('targetUpdate', targets);
    console.log("[Server] Game reset complete. Emitting gameStateUpdate.");
    io.emit('gameStateUpdate', getGameStateData());
}


// Serve static files from client folder
app.use(express.static(__dirname + '/../client'));

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send current state to newly connected player
  // They will determine if they are spectator/waiting based on this
  socket.emit('gameStateUpdate', getGameStateData());
  socket.emit('targetUpdate', targets); // Send current targets too

  socket.on('joinGame', (username) => {
    console.log(`Player joined: ${username} (${socket.id})`);
    players[socket.id] = { username, score: 0, status: 'WAITING' }; // Start as WAITING
    lobbyPlayers.push(socket.id); // Add to lobby list
    io.emit('gameStateUpdate', getGameStateData()); // Update all clients
  });

  socket.on('playerReady', () => {
    if (players[socket.id] && players[socket.id].status === 'WAITING') {
      players[socket.id].status = 'READY';
      console.log(`Player ready: ${players[socket.id].username}`);
      io.emit('gameStateUpdate', getGameStateData()); // Update statuses
      // Check if everyone is ready to start countdown
      if (checkAllReady()) {
          startCountdown();
      }
    }
  });

  socket.on('requestRestart', () => {
       console.log(`Restart requested by ${players[socket.id]?.username || socket.id}`);
       // Only allow restart if game has ended?
       // Or allow anytime for simplicity?
       // Let's allow anytime for now.
       resetGame();
   });

  socket.on('shoot', (data) => {
    // Check if it's the player's turn and game is playing
    if (gameState !== 'PLAYING' || socket.id !== playerTurnOrder[currentPlayerIndex]) {
        return socket.emit('feedback', { message: "Not your turn or game not active!" });
    }
    if (remainingShots <= 0) {
        return socket.emit('feedback', { message: "Out of shots!" });
    }

    const playerName = players[socket.id]?.username || socket.id;
    const hitTargetId = data ? data.targetId : null;
    const pointsFromClient = (data && typeof data.points === 'number') ? data.points : 0; // Get points from client, default to 0
    console.log(`[Server] Received shoot from ${playerName}. Target ID: ${hitTargetId}, Points Sent: ${pointsFromClient}`); // Log received data

    remainingShots--;
    let scoreGained = 0;

    if (hitTargetId && pointsFromClient > 0) { // Only process if a target ID was hit and points were potentially scored
        const targetIndex = targets.findIndex(t => t.id === hitTargetId);
        console.log(`[Server] Target search result for ID ${hitTargetId}: Index = ${targetIndex}`); // Log findIndex result

        if (targetIndex !== -1) {
            console.log(`[Server] Player ${playerName} HIT target ${hitTargetId}`);
            // Target exists, register hit using points from client
            scoreGained = pointsFromClient; // Use the points value sent by the client
            players[socket.id].score += scoreGained;
            console.log(`[Server] Score updated for ${playerName}: +${scoreGained} (Total: ${players[socket.id].score})`); // Log score update

            // Remove target
            const removedTarget = targets.splice(targetIndex, 1)[0];

            // Send hit feedback to the player who shot
            console.log(`[Server] Emitting hitFeedback to ${playerName} for target ${hitTargetId}, Points: ${scoreGained}`); // Log before emitting
            socket.emit('hitFeedback', { points: scoreGained, hitPosition: removedTarget }); // Send actual points scored

            // Broadcast score and target updates
            io.emit('scoreUpdate', players); // Send updated scores to everyone
            io.emit('targetUpdate', targets); // Update targets for everyone

        } else {
            console.log(`[Server] Player ${playerName} shot at non-existent target ${hitTargetId} (Points ignored)`);
             socket.emit('feedback', { message: "Iska!" });
        }
    } else {
        // Handle miss (no target ID sent or points were 0)
        console.log(`[Server] Player ${playerName} missed (TargetID: ${hitTargetId}, Points: ${pointsFromClient})`);
        socket.emit('feedback', { message: "Iska!" });
    }

    // Check if turn ends
    if (remainingShots <= 0) {
        console.log(`[Server] Turn ended for ${playerName}. Calling nextTurn.`);
        nextTurn();
    } else {
        // Update remaining shots for the current player
        io.emit('gameStateUpdate', getGameStateData());
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const disconnectedPlayer = players[socket.id];
    if (!disconnectedPlayer) return; // Player wasn't fully registered

    const wasInLobby = lobbyPlayers.includes(socket.id);
    const wasPlaying = playerTurnOrder.includes(socket.id);
    const username = disconnectedPlayer.username || 'Unknown';

    // Remove from relevant list
    if (wasInLobby) {
        lobbyPlayers = lobbyPlayers.filter(id => id !== socket.id);
        console.log(`Removed ${username} from lobby.`);
        // If they were the last one needed to be ready, cancel countdown?
        if (gameState === 'COUNTDOWN' && !checkAllReady()) {
             console.log("Player left during countdown, not all ready anymore. Resetting to WAITING.");
             if(countdownTimerInterval) clearInterval(countdownTimerInterval); countdownTimerInterval = null;
             gameState = 'WAITING';
             // Reset ready status for remaining players?
             lobbyPlayers.forEach(id => { if(players[id]) players[id].status = 'WAITING'; });
        }
    } else if (wasPlaying) {
        const playerIndex = playerTurnOrder.indexOf(socket.id);
        playerTurnOrder.splice(playerIndex, 1);
        console.log(`Removed ${username} from active game.`);
        // Adjust current player index logic (as before)
        if (playerIndex < currentPlayerIndex) currentPlayerIndex--;
        if (currentPlayerIndex >= playerTurnOrder.length) currentPlayerIndex = 0;
        // If it was their turn, advance turn (as before)
        if (playerIndex === currentPlayerIndex && playerTurnOrder.length > 0) { // Need to re-check index
             console.log(`It was ${username}'s turn. Advancing turn.`);
             nextTurn();
        }
    } else {
         console.log(`Disconnected player ${username} was spectating.`);
    }

    // Remove from main players object
    delete players[socket.id];

    // Check game end conditions / update state
     if (playerTurnOrder.length === 0 && gameState === 'PLAYING') {
         console.log("Last playing player left. Ending game.");
         endGame();
     } else if (lobbyPlayers.length === 0 && gameState === 'WAITING') {
         console.log("Lobby is now empty.");
         // Stay in WAITING state
     } else {
        // Otherwise, just notify remaining players about the disconnection and updated state
        io.emit('gameStateUpdate', getGameStateData());
        console.log(`Player left. Lobby: ${lobbyPlayers.length}, Playing: ${playerTurnOrder.length}`);
     }
  });

});

// Game loop: spawn and move targets
setInterval(() => {
  if (gameState !== 'PLAYING') return; // Only run loop if game is active

  spawnTarget(); // Try to spawn targets if needed

  // Move existing targets
  targets.forEach(t => {
    t.x += t.dir * t.speed;
    // Make movement bounds slightly larger so they go off-screen a bit
    if (t.x > 7 || t.x < -7) {
        t.dir *= -1;
        t.x = Math.max(-7, Math.min(7, t.x)); // Clamp to prevent getting stuck far off
        // Optional: Randomize y position slightly when changing direction?
        // t.y = 1 + Math.random() * 3;
    }

  });
  // Only emit target updates if there are targets to update
  if(targets.length > 0) {
      io.emit('targetUpdate', targets);
  }
}, 1000 / 30); // Update slightly less frequently? 30 FPS for target movement/spawning


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}); 