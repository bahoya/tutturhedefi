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
const MAX_TARGETS = 5;
const SHOTS_PER_TURN = 3;
const COUNTDOWN_SECONDS = 5;
let countdownTimerInterval = null;
let countdownValue = COUNTDOWN_SECONDS;
const MIN_SPAWN_DISTANCE_SQ = 4.0; // Minimum distance squared (2*2) between targets
const MAX_SPAWN_ATTEMPTS = 10; // Max tries to find a free spot
const TOTAL_ROUNDS = 5;
const MAJOR_TURNS_PER_ROUND = 3;
let currentRound = 1;
let currentMajorTurn = 1;
let turnTimerTimeout = null; // <<< ADDED: To store the turn timer timeout ID
const TURN_DURATION_SECONDS = 15; // <<< ADDED: Duration for each player's turn

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
    potentialPos.y = 6 + Math.random() * 5;  // New Y range: 6 to 11 (lifted slightly)
    potentialPos.z = 0 + Math.random() * 4; // New Z range: 0 to 4 (much closer, in front of fences)

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
    dir: Math.random() < 0.5 ? 1 : -1, // Horizontal direction
    speed: 0.06 + Math.random() * 0.08, // Horizontal speed
    dirY: Math.random() < 0.5 ? 1 : -1, // Vertical direction
    speedY: 0.03 + Math.random() * 0.05 // Vertical speed (adjust as needed)
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
        currentRound: gameState === 'PLAYING' ? currentRound : null,
        totalRounds: TOTAL_ROUNDS,
        currentMajorTurn: gameState === 'PLAYING' ? currentMajorTurn : null,
        totalMajorTurns: MAJOR_TURNS_PER_ROUND,
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
    currentRound = 1; // Initialize round
    currentMajorTurn = 1; // Initialize major turn
    targets = []; // Clear existing targets

    // Set player statuses to PLAYING
    playerTurnOrder.forEach(id => {
        if (players[id]) players[id].status = 'PLAYING';
    });

    // Spawn initial targets
    for(let i = 0; i < MAX_TARGETS; i++) spawnTarget();

    io.emit('gameStateUpdate', getGameStateData());
    console.log(`Game started. Round ${currentRound}/${TOTAL_ROUNDS}, Major Turn ${currentMajorTurn}/${MAJOR_TURNS_PER_ROUND}. Current player:`, players[playerTurnOrder[currentPlayerIndex]]?.username);
}

// Function to end the game
function endGame() {
    console.log("Game ending!");
    gameState = 'ENDED';
    if (turnTimerTimeout) clearTimeout(turnTimerTimeout); turnTimerTimeout = null; // Clear turn timer
    if (countdownTimerInterval) clearInterval(countdownTimerInterval); countdownTimerInterval = null; // Clear countdown if active
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

// Function to switch to the next player's turn (handles minor turns, major turns, and rounds)
function nextTurn() {
    // Clear any existing timer for the previous player
    if (turnTimerTimeout) clearTimeout(turnTimerTimeout); turnTimerTimeout = null;

    if (gameState !== 'PLAYING' || playerTurnOrder.length === 0) {
        console.log("nextTurn called inappropriately, game not playing or no players.");
        return;
    }

    currentPlayerIndex = (currentPlayerIndex + 1) % playerTurnOrder.length;
    remainingShots = SHOTS_PER_TURN; // Reset shots for the next minor turn

    // Check if a full cycle of players (minor turn) is complete
    if (currentPlayerIndex === 0) {
        currentMajorTurn++;
        console.log(`--- All players completed minor turn. Starting Major Turn ${currentMajorTurn}/${MAJOR_TURNS_PER_ROUND} ---`);

        // Check if a full round is complete
        if (currentMajorTurn > MAJOR_TURNS_PER_ROUND) {
            currentRound++;
            currentMajorTurn = 1; // Reset major turn for new round
            console.log(`====== Round ${currentRound - 1} Complete! Starting Round ${currentRound}/${TOTAL_ROUNDS} ======`);

            // Check if the game ended
            if (currentRound > TOTAL_ROUNDS) {
                console.log("########## Game Over! All rounds completed. ##########");
                endGame();
                return; // Stop further processing
            }
             // Optional: Add logic here for things to happen at the start of a new round
        }
    }

    const nextPlayerId = playerTurnOrder[currentPlayerIndex];
    console.log(`Next minor turn: Player ${players[nextPlayerId]?.username} (${remainingShots} shots). Round ${currentRound}/${TOTAL_ROUNDS}, Major Turn ${currentMajorTurn}/${MAJOR_TURNS_PER_ROUND}.`);
    io.emit('gameStateUpdate', getGameStateData());

    // Start timer for the new player's turn
    const currentTurnPlayerIdForTimeout = nextPlayerId; // Capture current player ID for the timeout check
    turnTimerTimeout = setTimeout(() => {
        // Check if game is still playing and if it's STILL this player's turn
        if (gameState === 'PLAYING' && playerTurnOrder.length > 0 && playerTurnOrder[currentPlayerIndex] === currentTurnPlayerIdForTimeout) {
            console.log(`[Server] Turn timed out for ${players[currentTurnPlayerIdForTimeout]?.username}. Forcing next turn.`);
            // Optionally, send feedback to the timed-out player?
            io.to(currentTurnPlayerIdForTimeout).emit('feedback', { message: "Süren doldu!" });
            nextTurn(); // Force the turn change
        }
    }, TURN_DURATION_SECONDS * 1000);
}

// Function to reset the game (called on restart request or auto-reset)
function resetGame() {
    console.log("[Server] Resetting game state requested.");
    gameState = 'WAITING';
    if (turnTimerTimeout) clearTimeout(turnTimerTimeout); turnTimerTimeout = null; // Clear turn timer
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
    // Reset round/turn counters
    currentRound = 1;
    currentMajorTurn = 1;

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

  // <<< NEW 'shotFired' HANDLER >>>
  socket.on('shotFired', () => {
    // Check if it's the player's turn and game is playing
    if (gameState !== 'PLAYING' || !playerTurnOrder || playerTurnOrder.length === 0 || socket.id !== playerTurnOrder[currentPlayerIndex]) {
        return socket.emit('feedback', { message: "Atış sırası sizde değil veya oyun aktif değil!" }); // "Not your turn or game not active!"
    }
    if (remainingShots <= 0) {
        // This shouldn't normally happen if turn timer works, but good safeguard
        console.log(`[Server] shotFired received from ${players[socket.id]?.username} but remainingShots is already <= 0.`);
        return socket.emit('feedback', { message: "Atış hakkınız bitti!" }); // "Out of shots!"
    }

    const playerName = players[socket.id]?.username || socket.id;
    console.log(`[Server] Received shotFired event from ${playerName}.`);

    // Decrement shots and check for turn end
    remainingShots--;
    console.log(`[Server] ${playerName} has ${remainingShots} shots left this turn.`);

    // Check if turn ends
    if (remainingShots <= 0) {
        console.log(`[Server] Turn ended for ${playerName} (used all shots). Calling nextTurn.`);
        if (turnTimerTimeout) clearTimeout(turnTimerTimeout); turnTimerTimeout = null; // Clear timer as turn completed normally
        nextTurn(); // Switch to next player
    } else {
        // Only update remaining shots for the current player (and everyone for UI update)
        io.emit('gameStateUpdate', getGameStateData());
    }
  });

  // Handler for when a projectile physically hits a target (sent from client)
  // const POINTS_PER_HIT = 5; // Vuruş başına verilecek sabit puan (Variable already exists below)

  socket.on('projectileHit', (data) => {
    // Basic validation: Is game playing and data valid?
    if (gameState !== 'PLAYING' || !data || typeof data.targetId === 'undefined') {
        // Added points check - make sure points are sent
        if (gameState !== 'PLAYING') console.log(`[Server] projectileHit ignored: Game not PLAYING.`);
        else console.log(`[Server] projectileHit ignored: Invalid data from ${socket.id}:`, data);
        return;
    }

    const targetId = data.targetId;
    const points = data.points || 0; // Get points from client data, default to 0
    const playerId = socket.id;

    // Stop if player disconnected or not found
    if (!players[playerId]) {
        console.log(`[Server] projectileHit ignored: Player ${playerId} not found.`);
        return;
    }
    const playerName = players[playerId].username || playerId;

    // Find the target in the server's list
    const targetIndex = targets.findIndex(t => t.id === targetId);

    // Check if target exists
    if (targetIndex !== -1) {
        // Target found! Process the hit.
        // Note: We no longer check if it's the player's turn here, as the hit is physics-based.
        // Any active projectile from any player could potentially hit.
        // However, scoring should likely only happen if it *was* their turn when they shot?
        // For simplicity now, any hit scores points for the owner of the projectile (socket.id)
        console.log(`[Server] projectileHit registered for target ${targetId} by ${playerName}.`);

        const removedTarget = targets[targetIndex]; // Details of removed target (optional for feedback)

        // --- Server-Side Scoring --- <<< USE POINTS FROM CLIENT >>>
        let scoreGained = points; // Use points determined by the client's hit detection
        players[playerId].score += scoreGained;
        console.log(`[Server] Score updated for ${playerName}: +${scoreGained} (Total: ${players[playerId].score})`);

        // Remove the target from the array
        targets.splice(targetIndex, 1);

        // --- Broadcast Updates ---
        // Send updated target list to everyone (target removed)
        io.emit('targetUpdate', targets);

        // Send hit feedback to the player who hit
        console.log(`[Server] Sending hitFeedback to ${playerName} for target ${targetId}, Points: ${scoreGained}`);
        socket.emit('hitFeedback', {
             points: scoreGained
        });

        // Broadcast the general state update so UIs refresh scores
        io.emit('gameStateUpdate', getGameStateData());

    } else {
        // Target not found (maybe another projectile hit it fractionally earlier?)
        console.log(`[Server] projectileHit for non-existent target ${targetId} by ${playerName} (ignored).`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const disconnectedPlayer = players[socket.id];
    if (!disconnectedPlayer) return; // Player wasn't fully registered

    const wasInLobby = lobbyPlayers.includes(socket.id);
    const wasPlaying = playerTurnOrder.includes(socket.id);
    const isCurrentTurn = wasPlaying && socket.id === playerTurnOrder[currentPlayerIndex]; // Check if it was their turn
    const username = disconnectedPlayer.username || 'Unknown';

    // Clear turn timer if the disconnecting player was the current player
    if (isCurrentTurn && turnTimerTimeout) {
        console.log(`[Server] Clearing turn timer for disconnecting player ${username}.`);
        clearTimeout(turnTimerTimeout);
        turnTimerTimeout = null;
    }

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
        if (isCurrentTurn && playerTurnOrder.length > 0) { // Use isCurrentTurn flag
             console.log(`It was ${username}'s turn. Advancing turn due to disconnect.`);
             // Note: nextTurn() will clear and reset the timer for the *next* player
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
  const targetVerticalBounds = { minY: 5, maxY: 12 }; // Adjust vertical bounds to match spawning: ~5 to ~12
  targets.forEach(t => {
    // Horizontal movement
    t.x += t.dir * t.speed;
    if (t.x > 7 || t.x < -7) {
        t.dir *= -1;
        t.x = Math.max(-7, Math.min(7, t.x));
    }

    // Vertical movement
    t.y += t.dirY * t.speedY;
    if (t.y > targetVerticalBounds.maxY || t.y < targetVerticalBounds.minY) {
        t.dirY *= -1; // Reverse vertical direction
        t.y = Math.max(targetVerticalBounds.minY, Math.min(targetVerticalBounds.maxY, t.y)); // Clamp position
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