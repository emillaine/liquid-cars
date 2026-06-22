"use strict";

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const restartButton = document.getElementById("restartButton");
const aiCountSelect = document.getElementById("aiCount");
const roundLengthSelect = document.getElementById("roundLength");
const scoreboard = document.getElementById("scoreboard");
const timeLeftEl = document.getElementById("timeLeft");
const leaderNameEl = document.getElementById("leaderName");
const lastCaptureEl = document.getElementById("lastCapture");
const message = document.getElementById("message");
const messageTitle = document.getElementById("messageTitle");
const messageBody = document.getElementById("messageBody");

const WORLD_W = 1280;
const WORLD_H = 800;
const GRID_W = 256;
const GRID_H = 160;
const CELL_COUNT = GRID_W * GRID_H;
const CELL_W = WORLD_W / GRID_W;
const CELL_H = WORLD_H / GRID_H;
const MAX_PLAYERS = 6;
const PAINT_RADIUS = 8;
const CAPTURE_MIN_CELLS = 24;
const TICK_RATE = 1 / 60;
const TWO_PI = Math.PI * 2;

const palette = [
  { name: "You", color: "#37f2a3", rgb: [55, 242, 163] },
  { name: "Ruby", color: "#ff4f86", rgb: [255, 79, 134] },
  { name: "Volt", color: "#ffe45c", rgb: [255, 228, 92] },
  { name: "Azure", color: "#58a6ff", rgb: [88, 166, 255] },
  { name: "Ember", color: "#ff8f3d", rgb: [255, 143, 61] },
  { name: "Violet", color: "#b78cff", rgb: [183, 140, 255] }
];

const keys = new Set();
let players = [];
let owners = new Int16Array(CELL_COUNT);
let scores = new Int32Array(MAX_PLAYERS);
let solidCells = new Uint8Array(CELL_COUNT);
let captureVisited = new Uint8Array(CELL_COUNT);
let captureQueue = new Int32Array(CELL_COUNT);
let solidCellsReady = false;
let imageData = new ImageData(GRID_W, GRID_H);
let paintCanvas = document.createElement("canvas");
let paintCtx = paintCanvas.getContext("2d");
let lastTime = performance.now();
let accumulator = 0;
let roundTime = 90;
let finished = false;
let cameraShake = 0;
let captureEffects = [];

paintCanvas.width = GRID_W;
paintCanvas.height = GRID_H;
paintCtx.imageSmoothingEnabled = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= TWO_PI;
  while (angle < -Math.PI) angle += TWO_PI;
  return angle;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = String(safe % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function buildSolidCells() {
  if (solidCellsReady) return;
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const worldX = (x + 0.5) * CELL_W;
      const worldY = (y + 0.5) * CELL_H;
      solidCells[y * GRID_W + x] = isInsideIsland(worldX, worldY) ? 1 : 0;
    }
  }
  solidCellsReady = true;
}

function resetRound() {
  buildSolidCells();
  const aiCount = Number(aiCountSelect.value);
  const totalPlayers = clamp(aiCount + 1, 2, MAX_PLAYERS);
  owners.fill(-1);
  scores.fill(0);
  players = [];
  roundTime = Number(roundLengthSelect.value);
  finished = false;
  cameraShake = 0;
  captureEffects = [];
  lastCaptureEl.textContent = "-";
  message.hidden = true;

  const starts = [
    [WORLD_W * 0.5, WORLD_H * 0.84, -Math.PI / 2],
    [WORLD_W * 0.18, WORLD_H * 0.2, 0.25],
    [WORLD_W * 0.82, WORLD_H * 0.2, Math.PI - 0.25],
    [WORLD_W * 0.18, WORLD_H * 0.78, -0.2],
    [WORLD_W * 0.82, WORLD_H * 0.78, Math.PI + 0.2],
    [WORLD_W * 0.5, WORLD_H * 0.14, Math.PI / 2]
  ];

  for (let id = 0; id < totalPlayers; id += 1) {
    const [x, y, angle] = starts[id];
    players.push({
      id,
      name: palette[id].name,
      color: palette[id].color,
      rgb: palette[id].rgb,
      human: id === 0,
      x,
      y,
      vx: Math.cos(angle) * 80,
      vy: Math.sin(angle) * 80,
      angle,
      steer: 0,
      throttle: 0,
      brake: 0,
      boost: 0,
      aiTimer: 0,
      aiTarget: angle,
      captureTimer: 0.22 + id * 0.07,
      wobble: Math.random() * TWO_PI
    });
  }

  for (const player of players) {
    paintAt(player, PAINT_RADIUS + 5);
  }

  updatePaintTexture();
  renderScoreboard();
}

function isInsideIsland(x, y) {
  const cx = WORLD_W * 0.5;
  const cy = WORLD_H * 0.5;
  const dx = (x - cx) / 180;
  const dy = (y - cy) / 92;
  return dx * dx + dy * dy < 1;
}

function sampleOwner(worldX, worldY) {
  const gx = Math.floor(clamp(worldX / CELL_W, 0, GRID_W - 1));
  const gy = Math.floor(clamp(worldY / CELL_H, 0, GRID_H - 1));
  return owners[gy * GRID_W + gx];
}

function claimCell(index, playerId) {
  const previous = owners[index];
  if (previous === playerId) return false;
  if (previous >= 0) scores[previous] -= 1;
  owners[index] = playerId;
  scores[playerId] += 1;
  return true;
}

function paintAt(player, radius) {
  const gx = Math.floor(player.x / CELL_W);
  const gy = Math.floor(player.y / CELL_H);
  const rx = Math.ceil(radius / CELL_W);
  const ry = Math.ceil(radius / CELL_H);
  let painted = 0;

  for (let y = gy - ry; y <= gy + ry; y += 1) {
    if (y < 0 || y >= GRID_H) continue;
    for (let x = gx - rx; x <= gx + rx; x += 1) {
      if (x < 0 || x >= GRID_W) continue;
      const worldX = (x + 0.5) * CELL_W;
      const worldY = (y + 0.5) * CELL_H;
      const dx = worldX - player.x;
      const dy = worldY - player.y;
      const ripple = 1 + 0.14 * Math.sin((x * 0.47 + y * 0.31 + performance.now() * 0.004) + player.id);
      if (dx * dx + dy * dy > radius * radius * ripple) continue;
      if (isInsideIsland(worldX, worldY)) continue;

      const index = y * GRID_W + x;
      if (claimCell(index, player.id)) painted += 1;
    }
  }

  return painted;
}

function canFlood(index, playerId) {
  return solidCells[index] === 0 && owners[index] !== playerId;
}

function pushFloodCell(index, playerId, queueState) {
  if (captureVisited[index] || !canFlood(index, playerId)) return queueState;
  captureVisited[index] = 1;
  captureQueue[queueState.tail] = index;
  queueState.tail += 1;
  return queueState;
}

function captureEnclosedAreas(player) {
  captureVisited.fill(0);
  let queueState = { head: 0, tail: 0 };

  for (let x = 0; x < GRID_W; x += 1) {
    queueState = pushFloodCell(x, player.id, queueState);
    queueState = pushFloodCell((GRID_H - 1) * GRID_W + x, player.id, queueState);
  }
  for (let y = 1; y < GRID_H - 1; y += 1) {
    queueState = pushFloodCell(y * GRID_W, player.id, queueState);
    queueState = pushFloodCell(y * GRID_W + GRID_W - 1, player.id, queueState);
  }

  while (queueState.head < queueState.tail) {
    const index = captureQueue[queueState.head];
    queueState.head += 1;

    const x = index % GRID_W;
    if (x > 0) queueState = pushFloodCell(index - 1, player.id, queueState);
    if (x < GRID_W - 1) queueState = pushFloodCell(index + 1, player.id, queueState);
    if (index >= GRID_W) queueState = pushFloodCell(index - GRID_W, player.id, queueState);
    if (index < CELL_COUNT - GRID_W) queueState = pushFloodCell(index + GRID_W, player.id, queueState);
  }

  let captured = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (captureVisited[i] || solidCells[i] || owners[i] === player.id) continue;
    captured += 1;
    sumX += i % GRID_W;
    sumY += Math.floor(i / GRID_W);
  }

  if (captured < CAPTURE_MIN_CELLS) return 0;

  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (captureVisited[i] || solidCells[i] || owners[i] === player.id) continue;
    claimCell(i, player.id);
  }

  const centerX = ((sumX / captured) + 0.5) * CELL_W;
  const centerY = ((sumY / captured) + 0.5) * CELL_H;
  captureEffects.push({
    x: centerX,
    y: centerY,
    radius: clamp(Math.sqrt(captured) * 7.2, 42, 220),
    color: player.color,
    life: 0.85,
    total: 0.85,
    amount: captured
  });
  lastCaptureEl.textContent = `${player.name} +${captured}`;
  cameraShake = Math.max(cameraShake, clamp(captured / 90, 3, 10));
  return captured;
}

function updatePaintTexture() {
  const data = imageData.data;
  for (let i = 0; i < owners.length; i += 1) {
    const owner = owners[i];
    const px = i * 4;
    if (owner < 0) {
      const x = i % GRID_W;
      const y = Math.floor(i / GRID_W);
      const checker = (x + y) % 2;
      const shade = checker ? 24 : 20;
      data[px] = shade;
      data[px + 1] = shade + 2;
      data[px + 2] = shade + 7;
      data[px + 3] = 255;
      continue;
    }

    const [r, g, b] = palette[owner].rgb;
    const gloss = 0.84 + (((i * 17) % 11) / 100);
    data[px] = Math.round(r * gloss);
    data[px + 1] = Math.round(g * gloss);
    data[px + 2] = Math.round(b * gloss);
    data[px + 3] = 236;
  }
  paintCtx.putImageData(imageData, 0, 0);
}

function readHumanInput(player) {
  const left = keys.has("arrowleft") || keys.has("a");
  const right = keys.has("arrowright") || keys.has("d");
  const up = keys.has("arrowup") || keys.has("w");
  const down = keys.has("arrowdown") || keys.has("s");
  const handbrake = keys.has(" ");

  player.steer = Number(right) - Number(left);
  player.throttle = up ? 1 : 0.42;
  player.brake = down ? 1 : 0;
  player.boost = handbrake ? 1 : 0;
}

function evaluateDirection(player, angle) {
  let score = 0;
  const speed = Math.hypot(player.vx, player.vy);
  const lookAhead = 82 + speed * 0.38;

  for (let step = 1; step <= 5; step += 1) {
    const dist = lookAhead * (step / 5);
    const x = player.x + Math.cos(angle) * dist;
    const y = player.y + Math.sin(angle) * dist;
    if (x < 35 || x > WORLD_W - 35 || y < 35 || y > WORLD_H - 35 || isInsideIsland(x, y)) {
      score -= 260 / step;
      continue;
    }

    const owner = sampleOwner(x, y);
    if (owner === -1) score += 46;
    else if (owner !== player.id) score += 72;
    else score -= 18;
  }

  for (const other of players) {
    if (other === player) continue;
    const dx = other.x - player.x;
    const dy = other.y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 95) {
      const away = wrapAngle(Math.atan2(-dy, -dx) - angle);
      score += Math.cos(away) * 40;
    }
  }

  return score;
}

function updateAi(player, dt) {
  player.aiTimer -= dt;
  const speed = Math.hypot(player.vx, player.vy);

  if (player.aiTimer <= 0) {
    player.aiTimer = 0.22 + Math.random() * 0.2;
    let bestAngle = player.angle;
    let bestScore = -Infinity;

    for (let i = -4; i <= 4; i += 1) {
      const candidate = player.angle + i * 0.36;
      const score = evaluateDirection(player, candidate) + Math.random() * 16;
      if (score > bestScore) {
        bestScore = score;
        bestAngle = candidate;
      }
    }

    player.aiTarget = bestAngle;
  }

  const angleDelta = wrapAngle(player.aiTarget - player.angle);
  player.steer = clamp(angleDelta * 2.2, -1, 1);
  player.throttle = speed < 330 ? 1 : 0.58;
  player.brake = Math.abs(angleDelta) > 1.7 && speed > 210 ? 0.4 : 0;
  player.boost = Math.abs(angleDelta) > 1.1 ? 0.45 : 0;
}

function movePlayer(player, dt) {
  if (player.human) readHumanInput(player);
  else updateAi(player, dt);

  const speed = Math.hypot(player.vx, player.vy);
  const steerPower = lerp(2.55, 1.35, clamp(speed / 420, 0, 1));
  player.angle += player.steer * steerPower * dt;

  const forwardX = Math.cos(player.angle);
  const forwardY = Math.sin(player.angle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const forwardSpeed = player.vx * forwardX + player.vy * forwardY;
  const sideSpeed = player.vx * sideX + player.vy * sideY;

  const acceleration = player.throttle * 360 - player.brake * 420;
  player.vx += forwardX * acceleration * dt;
  player.vy += forwardY * acceleration * dt;

  const grip = player.boost > 0 ? 2.1 : 7.8;
  player.vx -= sideX * sideSpeed * grip * dt;
  player.vy -= sideY * sideSpeed * grip * dt;

  const drag = player.boost > 0 ? 0.995 : 0.988;
  player.vx *= drag;
  player.vy *= drag;

  const maxSpeed = player.boost > 0 ? 390 : 335;
  const nextSpeed = Math.hypot(player.vx, player.vy);
  if (nextSpeed > maxSpeed) {
    player.vx = (player.vx / nextSpeed) * maxSpeed;
    player.vy = (player.vy / nextSpeed) * maxSpeed;
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;

  bounceFromBounds(player);
  bounceFromIsland(player);
  paintAt(player, PAINT_RADIUS + clamp(speed / 85, 0, 5));

  player.captureTimer -= dt;
  if (player.captureTimer <= 0) {
    player.captureTimer = 0.24 + player.id * 0.025;
    captureEnclosedAreas(player);
  }
}

function bounceFromBounds(player) {
  const margin = 18;
  if (player.x < margin) {
    player.x = margin;
    player.vx = Math.abs(player.vx) * 0.66;
    cameraShake = Math.max(cameraShake, 4);
  } else if (player.x > WORLD_W - margin) {
    player.x = WORLD_W - margin;
    player.vx = -Math.abs(player.vx) * 0.66;
    cameraShake = Math.max(cameraShake, 4);
  }

  if (player.y < margin) {
    player.y = margin;
    player.vy = Math.abs(player.vy) * 0.66;
    cameraShake = Math.max(cameraShake, 4);
  } else if (player.y > WORLD_H - margin) {
    player.y = WORLD_H - margin;
    player.vy = -Math.abs(player.vy) * 0.66;
    cameraShake = Math.max(cameraShake, 4);
  }
}

function bounceFromIsland(player) {
  const cx = WORLD_W * 0.5;
  const cy = WORLD_H * 0.5;
  const rx = 190;
  const ry = 102;
  const dx = (player.x - cx) / rx;
  const dy = (player.y - cy) / ry;
  const depth = dx * dx + dy * dy;
  if (depth >= 1) return;

  const angle = Math.atan2(dy, dx);
  player.x = cx + Math.cos(angle) * rx;
  player.y = cy + Math.sin(angle) * ry;
  const normalX = Math.cos(angle);
  const normalY = Math.sin(angle);
  const dot = player.vx * normalX + player.vy * normalY;
  player.vx -= dot * normalX * 1.75;
  player.vy -= dot * normalY * 1.75;
  cameraShake = Math.max(cameraShake, 5);
}

function update(dt) {
  if (finished) return;

  roundTime -= dt;
  if (roundTime <= 0) {
    roundTime = 0;
    finishRound();
    return;
  }

  for (const player of players) {
    movePlayer(player, dt);
  }

  cameraShake = Math.max(0, cameraShake - dt * 14);
  for (const effect of captureEffects) {
    effect.life -= dt;
  }
  captureEffects = captureEffects.filter((effect) => effect.life > 0);
  updatePaintTexture();
  renderScoreboard();
}

function getRankedPlayers() {
  const totalPainted = Math.max(1, scores.reduce((sum, score, index) => {
    return index < players.length ? sum + Math.max(0, score) : sum;
  }, 0));

  return players
    .map((player) => ({
      ...player,
      score: scores[player.id],
      percent: (scores[player.id] / totalPainted) * 100
    }))
    .sort((a, b) => b.score - a.score);
}

function renderScoreboard() {
  const ranked = getRankedPlayers();
  const leader = ranked[0];
  leaderNameEl.textContent = leader ? leader.name : "-";
  timeLeftEl.textContent = formatTime(roundTime);

  scoreboard.innerHTML = "";
  for (const player of ranked) {
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `
      <span class="swatch" style="background:${player.color}"></span>
      <strong class="score-name">${player.name}</strong>
      <span class="score-value">${player.percent.toFixed(1)}%</span>
      <span class="meter"><span style="width:${clamp(player.percent, 0, 100)}%; background:${player.color}"></span></span>
    `;
    scoreboard.appendChild(row);
  }
}

function finishRound() {
  finished = true;
  renderScoreboard();
  const ranked = getRankedPlayers();
  const winner = ranked[0];
  messageTitle.textContent = `${winner.name} wins`;
  messageBody.textContent = `${winner.percent.toFixed(1)}% of painted floor. Restart to test another mix.`;
  message.hidden = false;
}

function drawFloor() {
  ctx.save();
  if (cameraShake > 0) {
    ctx.translate((Math.random() - 0.5) * cameraShake, (Math.random() - 0.5) * cameraShake);
  }

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(paintCanvas, 0, 0, WORLD_W, WORLD_H);

  ctx.strokeStyle = "rgba(255,255,255,0.055)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= WORLD_W; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD_H);
    ctx.stroke();
  }
  for (let y = 0; y <= WORLD_H; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD_W, y);
    ctx.stroke();
  }

  drawIsland();
  ctx.restore();
}

function drawIsland() {
  const cx = WORLD_W * 0.5;
  const cy = WORLD_H * 0.5;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.82, 1);
  ctx.beginPath();
  ctx.arc(0, 0, 56, 0, TWO_PI);
  ctx.fillStyle = "#262a32";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.font = "700 15px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("DRY ROCK", cx, cy + 5);
}

function drawCaptureEffects() {
  for (const effect of captureEffects) {
    const t = 1 - effect.life / effect.total;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.75;
    ctx.strokeStyle = effect.color;
    ctx.lineWidth = 5 + t * 10;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, effect.radius * (0.45 + t * 0.75), 0, TWO_PI);
    ctx.stroke();
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.fillStyle = effect.color;
    ctx.font = "900 18px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(`+${effect.amount}`, effect.x, effect.y - effect.radius * 0.28);
    ctx.restore();
  }
}

function drawVehicle(player) {
  const speed = Math.hypot(player.vx, player.vy);
  const length = 34;
  const width = 19;
  const skid = player.boost > 0 ? 1 : 0;

  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);

  ctx.globalAlpha = 0.28;
  ctx.fillStyle = player.color;
  ctx.beginPath();
  ctx.ellipse(-18, 0, 26 + speed * 0.02, 13 + skid * 4, 0, 0, TWO_PI);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#111319";
  ctx.fillRect(-length * 0.5 - 3, -width * 0.5 - 3, length + 6, width + 6);
  ctx.fillStyle = player.color;
  roundedRect(-length * 0.5, -width * 0.5, length, width, 5);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillRect(2, -5, 10, 10);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(-14, -11, 8, 5);
  ctx.fillRect(-14, 6, 8, 5);
  ctx.fillRect(10, -11, 8, 5);
  ctx.fillRect(10, 6, 8, 5);

  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(11, -5);
  ctx.lineTo(11, 5);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
}

function render() {
  ctx.clearRect(0, 0, WORLD_W, WORLD_H);
  drawFloor();
  drawCaptureEffects();

  for (const player of players) {
    drawVehicle(player);
  }

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, WORLD_W - 4, WORLD_H - 4);
  ctx.restore();
}

function loop(now) {
  const elapsed = Math.min(0.08, (now - lastTime) / 1000);
  lastTime = now;
  accumulator += elapsed;

  while (accumulator >= TICK_RATE) {
    update(TICK_RATE);
    accumulator -= TICK_RATE;
  }

  render();
  requestAnimationFrame(loop);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
    event.preventDefault();
  }
  keys.add(key);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

restartButton.addEventListener("click", resetRound);
aiCountSelect.addEventListener("change", resetRound);
roundLengthSelect.addEventListener("change", resetRound);

resetRound();
requestAnimationFrame(loop);
