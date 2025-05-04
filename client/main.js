// client/main.js

// Import Three.js components as modules
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.142.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.142.0/examples/jsm/loaders/GLTFLoader.js';
// ADDED: Import Audio components
import { AudioListener, AudioLoader, Audio } from 'three';

// Socket.io is loaded globally via script tag, still accessible as io()
// const socket = io(); // This should still work

document.addEventListener('DOMContentLoaded', () => {
  console.log("DOM Loaded, initializing script...");

  // Connect to the deployed Render server
  const socket = io('https://tutturhedefi.onrender.com'); // <<< UPDATED with Render URL

  // Overlay elements
  const overlay = document.getElementById('overlay');
  const usernameInput = document.getElementById('username');
  const joinBtn = document.getElementById('joinBtn');
  const scoreboardDiv = document.getElementById('scoreboard');
  const crosshairDiv = document.getElementById('crosshair');
  const gameStatusDiv = document.getElementById('gameStatus'); // Add div for status messages
  const timerDiv = document.getElementById('timer'); // Add div for timer
  const pauseOverlay = document.getElementById('pauseOverlay'); // Get pause overlay
  const resumeBtn = document.getElementById('resumeBtn'); // Get resume button
  const gameOverOverlay = document.getElementById('gameOverOverlay'); // Get Game Over overlay
  const gameOverScoresDiv = document.getElementById('gameOverScores'); // Get div for scores inside overlay
  const playAgainBtn = document.getElementById('playAgainBtn'); // Get Play Again button
  const lobbyInfoDiv = document.getElementById('lobbyInfo'); // Lobby container
  const playerListUl = document.getElementById('playerList'); // Player list in lobby
  const readyBtn = document.getElementById('readyBtn'); // Ready button
  const countdownDisplayDiv = document.getElementById('countdownDisplay'); // Countdown text
  const turnNotificationDiv = document.getElementById('turnNotification'); // <<< Get notification element

  if (!overlay || !usernameInput || !joinBtn || !scoreboardDiv || !crosshairDiv || !gameStatusDiv || !timerDiv || !pauseOverlay || !resumeBtn || !gameOverOverlay || !gameOverScoresDiv || !playAgainBtn || !lobbyInfoDiv || !playerListUl || !readyBtn || !countdownDisplayDiv || !turnNotificationDiv) {
    console.error("Required DOM elements not found! Check index.html.");
    return;
  }

  // --- Loading Manager --- Start
  const loadingManager = new THREE.LoadingManager();
  const loadingOverlay = document.getElementById('loadingOverlay');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');

  if (!loadingOverlay || !progressBar || !progressText) {
      console.error("Loading screen elements not found!");
  } else {
      loadingManager.onStart = function ( url, itemsLoaded, itemsTotal ) {
          console.log( 'Started loading file: ' + url + '.\nLoaded ' + itemsLoaded + ' of ' + itemsTotal + ' files.' );
          loadingOverlay.style.display = 'flex'; // Ensure loading screen is visible
      };

      loadingManager.onLoad = function ( ) {
          console.log( 'Loading complete!');
          if (loadingOverlay) loadingOverlay.style.display = 'none'; // Hide loading screen
          const initialOverlay = document.getElementById('overlay'); // Show the lobby overlay now
          if (initialOverlay) initialOverlay.style.display = 'flex';
      };

      loadingManager.onProgress = function ( url, itemsLoaded, itemsTotal ) {
          console.log( 'Loading file: ' + url + '.\nLoaded ' + itemsLoaded + ' of ' + itemsTotal + ' files.' );
          const progress = (itemsLoaded / itemsTotal) * 100;
          if (progressBar) progressBar.style.width = progress + '%';
          if (progressText) progressText.innerText = Math.round(progress) + '%';
      };

      loadingManager.onError = function ( url ) {
          console.error( 'There was an error loading ' + url );
          if (progressText) progressText.innerText = "Yükleme Hatası!";
          // Optionally, keep the loading screen visible or show an error message
      };
  }
  // --- Loading Manager --- End

  // --- Client-side State ---
  let myClientId = null; // Store this client's socket ID
  let myPlayerStatus = null; // Store this client's status (WAITING, READY, PLAYING, SPECTATING)
  let players = {}; // Will store all player data { id: { username, score, status } }
  const targets = {};
  const projectiles = [];
  let currentGameState = 'WAITING';
  let currentTurnPlayerId = null;
  let currentTurnUsername = 'N/A';
  let myTurn = false;
  let shotsLeft = 0;
  let gameEndTime = 0;
  let gameTimerInterval = null; // For client-side timer display update
  let countdownValue = null;
  // let targetModel = null; // To hold the loaded target model <- REMOVED
  // let gunModel = null; // To hold the loaded gun model <- COMMENTED OUT
  // let muzzlePosition = new THREE.Object3D(); // Helper to find muzzle world position <- COMMENTED OUT
  // ADDED: Audio variables
  let listener = null;
  let backgroundMusic = null;
  let shootSound = null;
  let hitSound = null;
  // Zoom variables
  let isZooming = false;
  const defaultFov = 75;
  const zoomedFov = 40;
  const zoomSpeed = 5.0; // Adjust for faster/slower zoom animation

  // --- Three.js Setup ---
  console.log("Setting up Three.js...");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB); // Initial sky blue

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  // Move camera further back and slightly higher
  camera.position.set(0, 6, 25); // Z position set to 25 (was 35)
  camera.rotation.order = 'YXZ';
  let cameraPitch = 0;
  let cameraYaw = 0;
  const mouseSensitivity = 0.002;

  // ADDED: Audio Listener Setup
  listener = new THREE.AudioListener();
  camera.add(listener); // Attach listener to the camera

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // --- Pointer Lock Triggering --- 
  // Flag to track if the first click to lock has happened (still useful? maybe not)
  let firstClickLocked = false; 
  renderer.domElement.addEventListener('click', () => {
       // Always attempt lock on canvas click if game is playing and not already locked
       if (currentGameState === 'PLAYING' && myPlayerStatus === 'PLAYING' && document.pointerLockElement !== renderer.domElement) { 
           console.log("[Client] Canvas click while PLAYING. Requesting pointer lock on canvas (with timeout)...");
           // Use setTimeout to ensure the request is made after the current event stack clears
           setTimeout(() => {
               renderer.domElement.requestPointerLock(); // Request lock on canvas
           }, 0);
           // Hide pause menu if it was visible (e.g., after ESC or Resume)
           pauseOverlay.style.display = 'none';
       }
   });

  const clock = new THREE.Clock();

  // --- Lighting --- 
  const ambientLight = new THREE.AmbientLight(0xcccccc, 0.6); // Softer ambient light
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8); // Brighter directional light
  directionalLight.position.set(5, 15, 10); // Adjust angle for sunlight feel
  directionalLight.castShadow = true; // Optional: enable shadows later
  scene.add(directionalLight);

  // --- Environment --- 
  const textureLoader = new THREE.TextureLoader(loadingManager);

  // Grass Texture (as before)
  const grassTexture = textureLoader.load('assets/textures/grass.png');
  grassTexture.wrapS = THREE.RepeatWrapping;
  grassTexture.wrapT = THREE.RepeatWrapping;
  const textureRepeat = 30; // Repeat more on larger terrain
  grassTexture.repeat.set(textureRepeat, textureRepeat);

  // Ground Plane with Segments for Displacement
  const terrainSize = 150;
  const terrainSegments = 100;
  const terrainMaxHeight = 8;
  const planeGeo = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);

  // Use MeshStandardMaterial for better lighting on terrain
  const planeMat = new THREE.MeshStandardMaterial({
       map: grassTexture,
       roughness: 0.9,
       metalness: 0.1,
       side: THREE.DoubleSide
   });
  const groundPlane = new THREE.Mesh(planeGeo, planeMat);
  groundPlane.rotation.x = -Math.PI / 2; // Rotate plane to be the ground
  groundPlane.receiveShadow = true;
  scene.add(groundPlane);

  // Load Heightmap and Apply Displacement in onLoad Callback
  console.log("Loading heightmap...");
  textureLoader.load(
      'assets/textures/heightmap.png', // Path to heightmap
      // onLoad callback
      (heightmapTexture) => {
          console.log("Heightmap texture loaded successfully. Applying displacement...");
          const canvas = document.createElement('canvas');
          // Ensure image dimensions are available
           if (!heightmapTexture.image) { 
               console.error("Heightmap texture loaded but image data is missing.");
               return;
           }
          canvas.width = heightmapTexture.image.width;
          canvas.height = heightmapTexture.image.height;
          const context = canvas.getContext('2d');
          context.drawImage(heightmapTexture.image, 0, 0);
          const heightmapData = context.getImageData(0, 0, canvas.width, canvas.height).data;

          const vertices = planeGeo.attributes.position.array;
          const width = canvas.width;
          const height = canvas.height;

          for (let i = 0, j = 0, l = vertices.length; i < l; i++, j += 3) {
              const u = (vertices[j] / terrainSize + 0.5);
              const v = (vertices[j + 1] / terrainSize + 0.5);
              if (u >= 0 && u < 1 && v >= 0 && v < 1) {
                  const xPixel = Math.floor(u * (width - 1));
                  const yPixel = Math.floor((1 - v) * (height - 1));
                  const position = (xPixel + yPixel * width) * 4;
                  const elevation = heightmapData[position] / 255.0;
                  vertices[j + 2] = elevation * terrainMaxHeight;
              }
          }
          planeGeo.attributes.position.needsUpdate = true;
          planeGeo.computeVertexNormals();
          console.log("Terrain displacement applied.");
      },
      // onProgress callback (optional)
      undefined, 
      // onError callback
      (error) => {
          console.error('Error loading heightmap texture:', error);
      }
  );

  // --- Skybox --- (as before)
  const cubeTextureLoader = new THREE.CubeTextureLoader(loadingManager);
  cubeTextureLoader.setPath('assets/skybox/');
  const skyboxTexture = cubeTextureLoader.load([
      'px.png', 'nx.png', 'py.png', 'nz.png', 'pz.png', 'nz.png'
  ]);
  scene.background = skyboxTexture;
  console.log("Skybox setup attempt complete.");

  // --- Fog --- 
  // Adjust fog to account for larger terrain and potential height
  scene.fog = new THREE.Fog(0x87CEEB, 70, 180); // Start further, end further

  // --- Fences --- // RE-ENABLED and MODIFIED
  // Function to create a fence section along the Z-axis
  function createFenceSection(length = 15, height = 0.8, postInterval = 2, woodColor = 0x8B4513) {
      const fenceGroup = new THREE.Group();
      const postGeo = new THREE.BoxGeometry(0.2, height, 0.2); // Increased thickness again (X and Z)
      const postMat = new THREE.MeshLambertMaterial({ color: woodColor });
      const plankGeo = new THREE.BoxGeometry(0.1, 0.12, postInterval); // Increased thickness (X and Y), adjusted for Z-axis alignment
      const plankMat = new THREE.MeshLambertMaterial({ color: woodColor });

      const numSections = Math.ceil(length / postInterval);
      const startZ = -length / 2; // Center the fence segment

      for (let i = 0; i <= numSections; i++) {
          const currentZ = startZ + i * postInterval;
          // Post
          const post = new THREE.Mesh(postGeo, postMat);
          post.position.set(0, height / 2, currentZ);
          post.castShadow = true;
          fenceGroup.add(post);

          // Planks (except after last post)
          if (i < numSections) {
              const plankZ = currentZ + postInterval / 2;
              const plank1 = new THREE.Mesh(plankGeo, plankMat);
              // Position planks between posts along Z, slightly offset on X
              plank1.position.set(0.025, height * 0.7, plankZ);
              plank1.castShadow = true;
              fenceGroup.add(plank1);

              const plank2 = new THREE.Mesh(plankGeo, plankMat);
              plank2.position.set(0.025, height * 0.3, plankZ);
              plank2.castShadow = true;
              fenceGroup.add(plank2);
          }
      }
      return fenceGroup;
  }

  const fenceLength = 40; // How long the fences are along Z - INCREASED from 25
  const fenceOffset = 6; // How far from the center X line - DECREASED from 8
  const fenceStartZ = 5; // Start Z position - MOVED FORWARD to 5 (was 15)
  const fenceYPos = 3.5; // Base height on the ground - RAISED from 2.0
  const fenceHeight = 1.5; // NEW variable for fence height

  // Left Fence
  const fenceLeft = createFenceSection(fenceLength, fenceHeight);
  fenceLeft.position.set(-fenceOffset, fenceYPos, fenceStartZ + fenceLength / 2);
  scene.add(fenceLeft);

  // Right Fence
  const fenceRight = createFenceSection(fenceLength, fenceHeight);
  fenceRight.position.set(fenceOffset, fenceYPos, fenceStartZ + fenceLength / 2);
  scene.add(fenceRight);

  console.log("Fences created along Z-axis.");

  // Function to create a target mesh with different scoring zones
  function createTargetMesh() {
      const group = new THREE.Group();

      // Outer ring (1 point)
      const outerGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.1, 32);
      const outerMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }); // White, double side for visibility
      const outerRing = new THREE.Mesh(outerGeo, outerMat);
      outerRing.name = 'outerRing'; // Identifier for scoring
      outerRing.userData.points = 1;
      group.add(outerRing);

      // Middle ring (5 points)
      const middleGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.11, 32); // Slightly thicker
      const middleMat = new THREE.MeshLambertMaterial({ color: 0x0000ff, side: THREE.DoubleSide }); // Blue
      const middleRing = new THREE.Mesh(middleGeo, middleMat);
      middleRing.position.z = 0.001; // Position slightly in front (relative to group Z)
      middleRing.name = 'middleRing';
      middleRing.userData.points = 5;
      group.add(middleRing);

      // Bullseye (10 points)
      const bullseyeGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.12, 32); // Thickest
      const bullseyeMat = new THREE.MeshLambertMaterial({ color: 0xff0000, side: THREE.DoubleSide }); // Red
      const bullseye = new THREE.Mesh(bullseyeGeo, bullseyeMat);
      bullseye.position.z = 0.002; // Position slightly in front
      bullseye.name = 'bullseye';
      bullseye.userData.points = 10;
      group.add(bullseye);

      // Rotate the whole target to face the camera approximately
      // We'll make targets always face the camera later if needed.
      group.rotation.x = Math.PI / 2;

      return group;
  }

  // Function to update Timer Display
  function updateTimerDisplay() {
      if (currentGameState !== 'PLAYING') {
          timerDiv.innerText = '-';
          if (gameTimerInterval) clearInterval(gameTimerInterval);
          gameTimerInterval = null;
          return;
      }

      const now = Date.now();
      const remainingMs = Math.max(0, gameEndTime - now);
      const remainingSeconds = Math.floor(remainingMs / 1000);
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      timerDiv.innerText = `Süre: ${minutes}:${seconds.toString().padStart(2, '0')}`;

      if (remainingMs === 0 && gameTimerInterval) {
           clearInterval(gameTimerInterval);
           gameTimerInterval = null;
      }
  }

  // Function to update Game Status Display (Handles spectating)
  function updateGameStatusDisplay() {
       crosshairDiv.style.display = 'none'; // Default hide
       gameStatusDiv.innerText = '-'; // Default text

       if (currentGameState === 'WAITING') {
           gameStatusDiv.innerText = 'Lobide bekleniyor...';
       } else if (currentGameState === 'COUNTDOWN') {
            gameStatusDiv.innerText = `Oyun ${countdownValue} saniye içinde başlıyor...`;
       } else if (currentGameState === 'PLAYING') {
            if (myPlayerStatus === 'PLAYING') {
                 const turnText = myTurn ? `Sıra Sende (${shotsLeft} atış)` : `Sıra: ${currentTurnUsername} (${shotsLeft} atış)`;
                 gameStatusDiv.innerText = turnText;
                 crosshairDiv.style.display = document.pointerLockElement === renderer.domElement ? 'block' : 'none';
             } else if (myPlayerStatus === 'SPECTATING') {
                 gameStatusDiv.innerText = `İzleyici - Sıra: ${currentTurnUsername}`;
            }
       } else if (currentGameState === 'ENDED') {
           gameStatusDiv.innerText = 'Oyun Bitti!';
       }
   }

  // Function to show/hide main game UI
  function setGameUIVisibility(visible) {
      const display = visible ? 'block' : 'none';
      // Scoreboard might have different visibility rules later
      scoreboardDiv.style.display = display;
      gameStatusDiv.style.display = display;
      timerDiv.style.display = display;
      // Crosshair is handled in updateGameStatusDisplay based on pointer lock
  }

  // Function to update Scoreboard Display (Handles spectating)
  function updateScoreboard() {
      if (currentGameState !== 'PLAYING' && currentGameState !== 'ENDED') return; // Only show during play/end

       // Use allPlayers from server data, filter for non-spectators for score display?
       // Or just display everyone?
       // Let's display Playing/Ended players for scores.
       let playersToDisplay = Object.entries(players).filter(([,p]) => p.status === 'PLAYING' || p.status === 'ENDED_IN_GAME'); // Need a way to mark who played
       // Simplification: Display all non-spectators
       playersToDisplay = Object.entries(players).filter(([,p]) => p.status !== 'SPECTATING');

       let sortedPlayers = playersToDisplay.sort(([,a],[,b]) => b.score - a.score);
       let html = `<h3>Skorlar</h3>`;
       if (currentGameState === 'ENDED') {
           html = '<h3>Final Skorları</h3>';
           // scoreboardDiv yerine gameOverScoresDiv'i güncellemek daha mantıklı olabilir?
           // Şimdilik ikisini de güncelleyelim veya sadece gameOverScoresDiv'i?
           // Sadece gameOverScoresDiv'i güncelleyelim:
           gameOverScoresDiv.innerHTML = html + sortedPlayers.map(([id, p]) => {
               let highlight = (id === myClientId) ? ' (Siz)' : '';
               return `<div>${p.username}: ${p.score}${highlight}</div>`;
           }).join('');
           scoreboardDiv.innerHTML = ''; // Oyun bitince skorbordu temizle?
           return; // Game over ekranı gösterildiği için normal skorbordu güncelleme
       }

       sortedPlayers.forEach(([id, p]) => {
           let highlight = (id === myClientId) ? ' (Siz)' : '';
           html += `<div>${p.username}: ${p.score}${highlight}</div>`;
       });
       scoreboardDiv.innerHTML = html;
    }

  // Function to update Lobby UI
   function updateLobbyUI(lobbyPlayerData) {
       playerListUl.innerHTML = ''; // Clear previous list
       let allReady = lobbyPlayerData.length > 0;
       lobbyPlayerData.forEach(p => {
           const statusClass = p.status === 'READY' ? 'status-ready' : 'status-waiting';
           // Turkish status translation
           let statusText = 'Bekliyor';
           if (p.status === 'READY') statusText = 'Hazır';
           else if (p.status === 'PLAYING') statusText = 'Oynuyor'; // Should not happen in lobby, but for completeness
           else if (p.status === 'SPECTATING') statusText = 'İzliyor';

           const isMe = p.id === myClientId ? ' (Siz)' : '';
           const li = document.createElement('li');
           li.innerHTML = `<span>${p.username}${isMe}</span> <span class="${statusClass} player-status-text">${statusText}</span>`;
           playerListUl.appendChild(li);
           if (p.status !== 'READY') allReady = false;
       });

       // Show/hide ready button based on player status
       if (myPlayerStatus === 'WAITING') {
            readyBtn.style.display = 'block';
            readyBtn.disabled = false;
            readyBtn.innerText = 'Hazır';
        } else if (myPlayerStatus === 'READY') {
            readyBtn.style.display = 'block';
            readyBtn.disabled = true; // Or allow unready?
            readyBtn.innerText = 'Hazırsın!'; // Updated text
        } else {
            readyBtn.style.display = 'none'; // Hide for playing/spectating
        }

        // Show countdown text if applicable
         if(currentGameState === 'COUNTDOWN') {
             countdownDisplayDiv.innerText = `Başlıyor: ${countdownValue}...`; // Updated text
             readyBtn.style.display = 'none'; // Hide ready button during countdown
         } else {
            countdownDisplayDiv.innerText = '';
        }
   }

  // Join game button click - Now also unlocks audio context
   joinBtn.addEventListener('click', () => {
       const username = usernameInput.value.trim();
       if (!username) return alert('Kullanıcı adı girin!'); // Translated alert
       console.log("Join button clicked, emitting joinGame");
       socket.emit('joinGame', username);
       usernameInput.style.display = 'none';
       joinBtn.style.display = 'none';

       // <<< Unlock Audio Context >>>
       if (listener && listener.context.state === 'suspended') {
            listener.context.resume();
            console.log("AudioContext resumed on user interaction.");
       }
       // Play and immediately stop a sound to ensure playback is allowed
       // (Use a short sound if available, or background music briefly)
       if (backgroundMusic && !backgroundMusic.isPlaying) {
            console.log("Attempting to unlock audio playback...");
           try {
               // Play might throw an error if context is still locked, though resume should handle it.
               // A short, silent buffer could also be used here.
                backgroundMusic.play();
                backgroundMusic.stop(); // Stop immediately after starting
                console.log("Audio playback likely unlocked.");
           } catch (error) {
               console.error("Error attempting to unlock audio:", error);
           }
       }
       // <<< End Unlock Audio Context >>>
   });

  // Ready button click
  readyBtn.addEventListener('click', () => {
      if (currentGameState === 'WAITING' && myPlayerStatus === 'WAITING') {
          console.log("Ready button clicked, emitting playerReady");
          socket.emit('playerReady');
          readyBtn.disabled = true;
          readyBtn.innerText = 'Bekleniyor...'; // Feedback
      }
  });

  // Raycaster for projectile collision detection
  const projectileRaycaster = new THREE.Raycaster();

  // Handle server events
  socket.on('connect', () => {
    console.log("Connected to server with ID:", socket.id);
    myClientId = socket.id;
    // If we reconnect, maybe we were in a game? Request initial state.
    // Server already sends state on connect, so this might be redundant.
    // socket.emit('requestInitialState'); // Or similar if needed
  });

  // Central handler for all game state updates from server
  socket.on('gameStateUpdate', (data) => {
    console.log("[Client] Received gameStateUpdate:", data);
    const previousGameState = currentGameState; // Store previous state
    const wasMyTurn = myTurn; // Store previous turn state
    currentGameState = data.gameState;
    players = data.allPlayers; // Use allPlayers from server
    myPlayerStatus = players[myClientId]?.status; // Update my status

    // Update state specific vars if game is PLAYING
    if (currentGameState === 'PLAYING') {
        currentTurnPlayerId = data.currentTurnPlayerId;
        currentTurnUsername = data.username || 'N/A';
        shotsLeft = data.remainingShots;
        gameEndTime = data.gameEndTime;
        myTurn = (currentTurnPlayerId === myClientId);

        // Show turn notification if it just became our turn
        if (myTurn && !wasMyTurn && currentGameState === 'PLAYING') {
            showTurnNotification();
        }

        // ADDED: Start background music if not already playing
        if (backgroundMusic && !backgroundMusic.isPlaying && previousGameState !== 'PLAYING') {
            console.log("Starting background music.");
            backgroundMusic.play();
        }
    } else {
        // Reset turn-specific vars if not playing
        currentTurnPlayerId = null; currentTurnUsername = 'N/A'; shotsLeft = 0; myTurn = false; gameEndTime = 0;

        // ADDED: Stop background music if it's playing
        if (backgroundMusic && backgroundMusic.isPlaying) {
            console.log("Stopping background music.");
            backgroundMusic.stop();
        }
    }
    // Update countdown value
     countdownValue = data.countdownValue;

    // Reset firstClickLocked flag when not playing
    if (currentGameState !== 'PLAYING') {
        firstClickLocked = false;
    }

    // --- UI Visibility Management --- 
    overlay.style.display = 'none';
    pauseOverlay.style.display = 'none';
    gameOverOverlay.style.display = 'none';
    setGameUIVisibility(false); // Hide game UI by default
    lobbyInfoDiv.style.display = 'none'; // Hide lobby info by default

    if (currentGameState === 'WAITING' || currentGameState === 'COUNTDOWN') {
        overlay.style.display = 'flex'; // Show the main overlay for lobby
        lobbyInfoDiv.style.display = 'block'; // Show lobby details within overlay
        // Hide initial join elements if we have a status (i.e., we are already joined)
        if (myPlayerStatus) {
             usernameInput.style.display = 'none';
             joinBtn.style.display = 'none';
        }
         updateLobbyUI(data.lobbyPlayers);
        if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
        // Clear visuals (already handled in previous version)
    } else if (currentGameState === 'PLAYING') {
        console.log("[Client] State is PLAYING. Set game UI visible. Click canvas to lock pointer.");
        setGameUIVisibility(true);
        updateScoreboard(); // Update scoreboard content
    } else if (currentGameState === 'ENDED') {
        gameOverOverlay.style.display = 'flex';
        // Populate final scores (using all non-spectators)
        let playersToDisplay = Object.entries(players).filter(([,p]) => p.status !== 'SPECTATING');
        let sortedPlayers = playersToDisplay.sort(([,a],[,b]) => b.score - a.score);
        let finalScoresHtml = '';
        sortedPlayers.forEach(([id, p]) => {
            let highlight = (id === myClientId) ? ' (You)' : '';
            finalScoresHtml += `<div>${p.username}: ${p.score}${highlight}</div>`;
        });
        gameOverScoresDiv.innerHTML = finalScoresHtml;
        if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
        // Clear visuals (already handled)
    }
    // --- End UI Visibility --- 

    updateGameStatusDisplay(); // Update status text always

    // Manage client-side timer display interval
    if (currentGameState === 'PLAYING' && !gameTimerInterval) {
        updateTimerDisplay();
        gameTimerInterval = setInterval(updateTimerDisplay, 1000);
    } else if (currentGameState !== 'PLAYING' && gameTimerInterval) {
        updateTimerDisplay();
        clearInterval(gameTimerInterval);
        gameTimerInterval = null;
    }
  });

  // Handle target updates (position, creation, deletion)
  socket.on('targetUpdate', (serverTargets) => {
       if (currentGameState !== 'PLAYING') return;

      // Log the raw data received from the server - COMMENTED OUT
      // console.log("[Client] Received targetUpdate data:", JSON.stringify(serverTargets));

      // Safer mapping: Ensure 't' exists before accessing 'id'
      const serverTargetIds = new Set(serverTargets.map(t => t?.id).filter(id => id));

      // Remove targets that no longer exist
      Object.keys(targets).forEach(id => {
        if (!serverTargetIds.has(id)) {
          if (targets[id] && targets[id].mesh) { // Check mesh exists before removing
               scene.remove(targets[id].mesh);
               delete targets[id];
           }
        }
      });
      // Add or update targets
      serverTargets.forEach(targetData => {
          // <<< ADDED VALIDATION CHECK >>>
          if (!targetData || typeof targetData.id === 'undefined' || typeof targetData.x === 'undefined' || typeof targetData.y === 'undefined' || typeof targetData.z === 'undefined') {
              console.error("[Client] Received invalid target data, skipping:", targetData);
              return; // Skip this invalid entry
          }
          // <<< END VALIDATION CHECK >>>

          const targetId = targetData.id; // Use validated ID

          if (!targets[targetId]) {
              // Target doesn't exist locally, create it using geometry function
              targets[targetId] = {
                  mesh: null
              };

              // Use createTargetMesh instead of loading a model
              const targetMeshGroup = createTargetMesh(); // Call the function to create the geometry
              // Use validated position data
              targetMeshGroup.position.set(targetData.x, targetData.y, targetData.z);
              targetMeshGroup.userData.id = targetId; // <<< ENSURE ID IS SET HERE >>>
              scene.add(targetMeshGroup);
              targets[targetId].mesh = targetMeshGroup; // Store the created group
              console.log(`Created target mesh for ID: ${targetId}`); // Add log

          } else {
              // Target exists, update its position
              if (targets[targetId].mesh) {
                   // Use validated position data - Create a temporary Vector3 for lerp
                  const targetPositionVec = new THREE.Vector3(targetData.x, targetData.y, targetData.z);
                  targets[targetId].mesh.position.lerp(targetPositionVec, 0.1); // Smooth movement
              }
          }
      });
    });

  // Feedback messages from server (e.g., "Not your turn!")
  socket.on('feedback', (data) => {
      console.log("Feedback:", data.message);
      // Translate common feedback messages
      let feedbackMessage = data.message;
      if (data.message === "Not your turn or game not active!") {
          feedbackMessage = "Sıra sizde değil veya oyun aktif değil!";
      } else if (data.message === "Out of shots!") {
          feedbackMessage = "Atış hakkınız bitti!";
      } else if (data.message === "Miss!") {
          feedbackMessage = "Iska!";
      }
      // Optional: Display this message to the user briefly
      gameStatusDiv.innerText = feedbackMessage; // Show feedback temporarily
      setTimeout(updateGameStatusDisplay, 1500); // Revert after 1.5s
  });

  // Resume button click - Now also sets firstClickLocked flag
   resumeBtn.addEventListener('click', () => {
       console.log("[Client] Resume button clicked.");
       if (currentGameState === 'PLAYING') {
           console.log("[Client] Game is PLAYING. Hiding pause overlay.");
           pauseOverlay.style.display = 'none'; // Just hide overlay
           setGameUIVisibility(true); // Show game UI again
           // DO NOT request pointer lock here
           firstClickLocked = false; // Allow subsequent canvas click to lock pointer
       } else {
           console.log(`[Client] Resume ignored: Game state is ${currentGameState}`);
       }
   });

  // Play Again button click
  playAgainBtn.addEventListener('click', () => {
      console.log("[Client] Play Again button clicked. Emitting requestRestart...");
      socket.emit('requestRestart');
      gameOverOverlay.style.display = 'none';
  });

  // --- Load Models --- 
  const loader = new GLTFLoader(loadingManager);
  // ADDED: Audio Loader
  const audioLoader = new THREE.AudioLoader(loadingManager);

  // Load Target Model
  loader.load(
      'assets/models/target.glb', // Adjust path if needed
      (gltf) => {
          console.log("Target model loaded successfully.");
          targetModel = gltf.scene;
          // Optional: Apply initial scale/rotation adjustments if needed
          // targetModel.scale.set(0.5, 0.5, 0.5);
      },
      undefined, // onProgress
      (error) => {
          console.error('Error loading target model:', error);
      }
  );

  // ADDED: Load Audio Files
  // Background Music
  audioLoader.load('assets/audio/background_music.mp3', function( buffer ) {
      console.log("Background music loaded.");
      backgroundMusic = new THREE.Audio( listener );
      backgroundMusic.setBuffer( buffer );
      backgroundMusic.setLoop( true );
      backgroundMusic.setVolume( 0.3 ); // Reverted to 0.3
      // Don't play yet, start based on game state
  }, undefined, function ( err ) {
      console.error( 'Error loading background music:', err );
  });

  // Shoot Sound
  audioLoader.load( 'assets/audio/shoot.wav', function( buffer ) {
      console.log("Shoot sound loaded.");
      shootSound = new THREE.Audio( listener );
      shootSound.setBuffer( buffer );
      shootSound.setVolume( 0.6 ); // Adjust volume
  }, undefined, function ( err ) {
      console.error( 'Error loading shoot sound:', err );
  });

  // Hit Sound
  audioLoader.load( 'assets/audio/hit_target.wav', function( buffer ) {
      console.log("Hit sound loaded.");
      hitSound = new THREE.Audio( listener );
      hitSound.setBuffer( buffer );
      hitSound.setVolume( 0.4 ); // Reduced volume from 0.7 to 0.4
  }, undefined, function ( err ) {
      console.error( 'Error loading hit sound:', err );
  });

  // --- Shooting Mechanic --- 
  // Raycaster for aiming direction
  const aimRaycaster = new THREE.Raycaster();

  window.addEventListener('click', (event) => {
      console.log(`[Client] Click detected. Pointer locked: ${document.pointerLockElement === renderer.domElement}, State: ${currentGameState}, Status: ${myPlayerStatus}, Turn: ${myTurn}`); // <<< Check renderer.domElement
      if (document.pointerLockElement === renderer.domElement && currentGameState === 'PLAYING' && myPlayerStatus === 'PLAYING' && myTurn) {

           console.log("Firing shot!");

           // --- Raycast to find hit target ID and Points ---
           let hitTargetId = null;
           let hitPoints = 0; // Default points for miss or unknown hit
           aimRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera); // Ray from screen center
           const targetMeshesForRaycast = [];
           Object.values(targets).forEach(targetData => {
               if (targetData && targetData.mesh) {
                   // Add the main group mesh for intersection test
                   targetMeshesForRaycast.push(targetData.mesh);
               }
           });

           const intersects = aimRaycaster.intersectObjects(targetMeshesForRaycast, true); // true for recursive

           if (intersects.length > 0) {
               const intersectedObject = intersects[0].object; // The specific part hit (e.g., bullseye mesh)
               let parentGroup = intersectedObject;

               // Traverse up to find the main group that has the ID and check points on the way
               while (parentGroup && parentGroup.type !== 'Scene') {
                   if (parentGroup.userData.id) { // Found the main target group
                       hitTargetId = parentGroup.userData.id;
                       // Get points from the originally intersected object
                       if (intersectedObject.userData.points) {
                            hitPoints = intersectedObject.userData.points;
                       } else {
                            console.warn("Hit object part has no points defined, defaulting to 1", intersectedObject.name);
                            hitPoints = 1; // Fallback points if specific part has no points
                       }
                       console.log(`Raycast hit target ID: ${hitTargetId}, Part: ${intersectedObject.name}, Points: ${hitPoints}`);
                       break; // Exit loop once ID is found
                   }
                   parentGroup = parentGroup.parent;
               }

               if (!hitTargetId) {
                   // This case might happen if the hierarchy is unexpected
                   console.log("Raycast hit an object, but couldn't find parent group with ID.", intersectedObject);
                   // Optionally, assign default points if a hit is detected but ID/points fail
                   // hitPoints = 1;
               }
           }

           // --- Send shoot event with target ID and points ---
           console.log(`[Client] Sending shoot event. TargetID: ${hitTargetId}, Points: ${hitPoints}`);
           socket.emit('shoot', { targetId: hitTargetId, points: hitPoints }); // Send ID and points

           // Play Shoot Sound
           if (shootSound && shootSound.isPlaying) {
                shootSound.stop(); // Stop previous instance if rapid firing
           }
           if (shootSound) {
               shootSound.play();
           }

           // --- Visual projectile from CAMERA --- <- RE-ENABLED
           // /* <- Removed comment start
           // 1. Determine Target Point (where the player is aiming)
           aimRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera); // Ray already set above, reuse direction
           const worldDirection = aimRaycaster.ray.direction;
           // Define a target point far away in the aiming direction
            const targetPoint = new THREE.Vector3();
            targetPoint.copy(aimRaycaster.ray.origin).addScaledVector(worldDirection, 100); // 100 units away

           // 2. Get Start Position (Camera Position)
           const startPosition = camera.position.clone(); // Start from camera

           // 3. Create Projectile Mesh at Start Position
           const projectileSpeed = 60;
           const projectileGeo = new THREE.SphereGeometry(0.04, 8, 8); // Reduced radius from 0.05
           const projectileMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); // Changed color to black
           const projectileMesh = new THREE.Mesh(projectileGeo, projectileMat);
           projectileMesh.position.copy(startPosition); // Use camera position

           // 4. Calculate Velocity towards Target Point from Start Position
           const velocity = new THREE.Vector3();
           velocity.subVectors(targetPoint, startPosition).normalize().multiplyScalar(projectileSpeed);

           // 5. Add to scene and tracking array
           scene.add(projectileMesh);
           projectiles.push({ mesh: projectileMesh, velocity: velocity });
           // */ <- Removed comment end

       } else {
           // ... (ignore logging)
       }
   });

    // --- Add Pointer Lock and Mouse Look Logic --- 

    function updateCameraRotation(event) {
        // Check if pointer is actually locked when this is called
        if (document.pointerLockElement !== renderer.domElement) {
            console.warn("[Client] updateCameraRotation called but pointer is not locked!");
            return; // Don't rotate if not locked
        }
        console.log("[Client] updateCameraRotation - Mouse Move Detected"); // <<< Added Log
        const movementX = event.movementX || 0;
        const movementY = event.movementY || 0;
        if (movementX === 0 && movementY === 0) return;
        
         cameraYaw -= movementX * mouseSensitivity;
         cameraPitch -= movementY * mouseSensitivity;
         cameraPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cameraPitch)); // Clamp vertical

         // Apply rotation directly to camera
         camera.rotation.y = cameraYaw;
         camera.rotation.x = cameraPitch;
    }

    document.addEventListener('pointerlockchange', () => {
        console.log("[Client] Pointer Lock Change triggered."); // Log event trigger
        if (document.pointerLockElement === renderer.domElement) {
            console.log('[Client] Pointer Locked. (document.pointerLockElement === renderer.domElement is TRUE)');
            pauseOverlay.style.display = 'none';
            // Ensure game UI is visible when lock is acquired during PLAYING state
            if (currentGameState === 'PLAYING') {
                console.log('[Client] Game state is PLAYING, ensuring UI is visible.');
                setGameUIVisibility(true);
            }
            console.log('[Client] Adding mousemove listener for updateCameraRotation...');
            document.addEventListener("mousemove", updateCameraRotation, false);
        } else {
            // Pointer unlocked
            console.log('[Client] Pointer Unlocked. (document.pointerLockElement === renderer.domElement is FALSE)');
            document.removeEventListener("mousemove", updateCameraRotation, false);
            console.log('[Client] Removed mousemove listener.');
            firstClickLocked = false; // Allow canvas click to re-lock pointer
            // Show pause menu only if game is PLAYING and player is PLAYING
            if (currentGameState === 'PLAYING' && myPlayerStatus === 'PLAYING') {
                console.log('[Client] Showing pause overlay because pointer unlocked during PLAYING.');
                pauseOverlay.style.display = 'flex';
                // Hide other game UI when paused
                scoreboardDiv.style.display = 'none';
                gameStatusDiv.style.display = 'none';
                timerDiv.style.display = 'none';
            }
        }
        console.log("[Client] Calling updateGameStatusDisplay after pointerlockchange.");
        updateGameStatusDisplay(); // Update crosshair visibility etc.
    });

    document.addEventListener('pointerlockerror', (error) => {
        console.error('[Client] Pointer Lock Error:', error);
    });

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (currentGameState === 'PLAYING' || projectiles.length > 0) { // Update projectiles even if paused for visuals
           // 1. Update Projectiles
           const targetMeshes = [];
           Object.values(targets).forEach(targetData => {
               if (targetData && targetData.mesh) { // Check if targetData and its mesh exist
                   targetMeshes.push(targetData.mesh); // Push the actual mesh
               }
           });

           for (let i = projectiles.length - 1; i >= 0; i--) {
              const projData = projectiles[i];
              const projectileMesh = projData.mesh;
              const velocity = projData.velocity;
              const moveDistance = velocity.clone().multiplyScalar(delta);
              const newPosition = projectileMesh.position.clone().add(moveDistance);

              // Collision Detection - VISUAL ONLY - Does NOT emit shoot anymore
              projectileRaycaster.set(projectileMesh.position, velocity.clone().normalize());
              const intersects = projectileRaycaster.intersectObjects(targetMeshes, true); // Recursive check
              let visualHitDetected = false;
              if (intersects.length > 0 && intersects[0].distance <= moveDistance.length()) {
                  visualHitDetected = true; // Visual hit detected
              }

              // Update or remove projectile
              if (visualHitDetected) {
                  // Remove projectile immediately on visual hit
                  scene.remove(projectileMesh);
                  projectiles.splice(i, 1);
                  // console.log("Visual projectile removed due to hit."); // Optional log
              } else {
                  // No visual hit, check other removal conditions (distance, height)
                  if (projectileMesh.position.length() > 200 || newPosition.y < -5) { 
                      scene.remove(projectileMesh);
                      projectiles.splice(i, 1);
                      // console.log("Visual projectile removed due to distance or height."); // Optional log
                  } else {
                      // No hit and still within bounds, update position
                      projectileMesh.position.copy(newPosition);
                  }
              }
           }
    }

    // 2. Update Camera FOV for Zoom
    const targetFov = isZooming ? zoomedFov : defaultFov;
    if (Math.abs(camera.fov - targetFov) > 0.01) { // Only update if needed
        camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, zoomSpeed * delta);
        camera.updateProjectionMatrix(); // IMPORTANT: Update matrix after FOV change
    }

    // 3. Render scene
    renderer.render(scene, camera);
  }

  console.log("Starting animation loop...");
  animate();

  // Handle window resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    console.log("Window resized");
  });

  // ADDED: Listener for Hit Feedback from Server
  socket.on('hitFeedback', (data) => {
      console.log("[Client] Received hitFeedback:", data);
      if (hitSound && hitSound.isPlaying) {
          hitSound.stop(); // Stop previous sound if it's still playing
      }
      if (hitSound) {
          // Optional: Could adjust volume or playback rate based on data.points
          // hitSound.setPlaybackRate(data.points > 5 ? 1.2 : 1.0);
          hitSound.play();
      }
      // Optional: Add visual feedback at data.hitPosition
  });

  // <<< Function to show the turn notification >>>
  function showTurnNotification() {
      if (!turnNotificationDiv) return;
      turnNotificationDiv.innerText = "Sıra Sende!";
      turnNotificationDiv.classList.add('show');

      // Hide the notification after a delay (e.g., 1.5 seconds)
      setTimeout(() => {
          turnNotificationDiv.classList.remove('show');
      }, 1500); // Duration the notification is visible
  }

  // Zoom controls
  document.addEventListener('keydown', (event) => {
      if (event.key === 'Control') {
          isZooming = true;
      }
  });

  document.addEventListener('keyup', (event) => {
      if (event.key === 'Control') {
          isZooming = false;
      }
  });

}); // End of DOMContentLoaded listener 