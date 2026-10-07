// Initialize Kaplay
kaplay({
    global: true, // Enable global functions (add, scene, go, etc.)
    background: [15, 18, 21], // Match CSS --bg-color
    width: 900,
    height: 500,
    canvas: document.getElementById("game-canvas"),
    scale: 1,
    debug: false, // Turn off debug for cleaner look
});

// Load Custom Font
// loadFont("fredoka", "https://fonts.gstatic.com/s/fredokaone/v13/k3kUo8kEI-tA1RRcTZGmGmHHEzy05GI.ttf");

// --- Audio System ---
let audioCtx = null;

const Sound = {
    init: () => {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    },
    playTone: (freq, type, duration, vol = 0.1) => {
        if (!audioCtx) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    },
    select: () => Sound.playTone(440, 'sine', 0.1),
    deselect: () => Sound.playTone(330, 'sine', 0.1),
    move: () => Sound.playTone(600, 'sine', 0.15),
    invalid: () => Sound.playTone(150, 'sawtooth', 0.3, 0.2),
    click: () => Sound.playTone(800, 'sine', 0.05, 0.05), // UI Click
    win: () => {
        setTimeout(() => Sound.playTone(523.25, 'sine', 0.1), 0);
        setTimeout(() => Sound.playTone(659.25, 'sine', 0.1), 100);
        setTimeout(() => Sound.playTone(783.99, 'sine', 0.2), 200);
    },
    gameOver: () => {
        Sound.playTone(100, 'sawtooth', 0.5, 0.3);
    }
};

// --- Game State & Data ---

const state = {
    level: 1,
    gold: 0,
    score: 0,
    lives: 3,
    maxLives: 3,
    moves: 0,
    isPlaying: false,
    disks: 3,
    targetTowerIndex: 2,
    prevTargetTowerIndex: 2,
    moveGoldMin: 1,
    moveGoldMax: 2,
    levelBonusMin: 30,
    levelBonusMax: 70
};

const modifiers = {
    comboDecayRate: 0.3,
    goldPerMove: 1,
    goldMultiplier: 1,
    scoreMultiplier: 1,
    comboGain: 30
};

const combo = {
    value: 0,
    multiplier: 1.0,
    active: false
};

// Colors - Vibrant Kaplay Style
const COLORS = {
    bg: '#1a1a1a', // Darker bg for contrast
    tower: '#4a5568',
    base: '#2c3e50',
    accent: '#60d394', // Kaplay Green
    accentHighlight: '#aaf0d1',
    gold: '#ffd700',
    danger: '#ff6b6b', // Vibrant Red
    text: '#ffffff',
    outline: '#000000',
    disks: [
        '#ff8da1', // Pink
        '#f6ad55', // Orange
        '#f6e05e', // Yellow
        '#68d391', // Green
        '#4fd1c5', // Teal
        '#63b3ed', // Blue
        '#7f9cf5', // Indigo
        '#b794f4'  // Purple
    ]
};

// --- Kaplay-style Visual Helpers ---

// Dot-grid backdrop drawn behind every scene
function drawBackdrop() {
    const step = 40;
    for (let x = step / 2; x < width(); x += step) {
        for (let y = step / 2; y < height(); y += step) {
            drawCircle({ pos: vec2(x, y), radius: 1.5, color: rgb(255, 255, 255), opacity: 0.07 });
        }
    }
}

// Slowly drifting, bobbing disks for the menu background
function spawnFloatingDisks(count) {
    for (let i = 0; i < count; i++) {
        add([
            rect(rand(50, 110), 18, { radius: 9 }),
            pos(rand(0, width()), rand(0, height())),
            anchor("center"),
            color(Color.fromHex(COLORS.disks[i % COLORS.disks.length])),
            opacity(0.18),
            outline(3, COLORS.outline),
            z(-50),
            {
                speed: rand(12, 30),
                phase: rand(0, Math.PI * 2),
                update() {
                    this.pos.y -= this.speed * dt();
                    this.phase += dt();
                    this.angle = Math.sin(this.phase) * 8;
                    if (this.pos.y < -40) this.pos.y = height() + 40;
                }
            }
        ]);
    }
}

// Little dust puff when a disk lands
function spawnBurst(p, hex) {
    const life = 0.45;
    for (let i = 0; i < 8; i++) {
        const angle = rand(0, Math.PI * 2);
        const speed = rand(60, 140);
        add([
            circle(rand(2, 4)),
            pos(p.x, p.y),
            color(Color.fromHex(hex)),
            z(50),
            {
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 40,
                update() {
                    this.pos.x += this.vx * dt();
                    this.pos.y += this.vy * dt();
                    this.vy += 300 * dt(); // gravity
                    this.life = (this.life ?? life) - dt();
                    this.opacity = Math.max(0, this.life / life);
                    if (this.life <= 0) destroy(this);
                }
            }
        ]);
    }
}

// --- UI Components ---
function addButton(txt, p, f, width = 200, height = 60, opts = {}) {
    const isFixed = opts.fixed || false;
    const zIndex = opts.z || 0;

    // Shadow (for 3D effect)
    add([
        rect(width, height, { radius: 16 }),
        pos(p.add(vec2(4, 4))),
        anchor("center"),
        color(0, 0, 0),
        opacity(0.3),
        ...(isFixed ? [fixed()] : []),
        z(zIndex > 0 ? zIndex - 1 : 0),
        "ui-shadow"
    ]);

    const btn = add([
        rect(width, height, { radius: 16 }),
        pos(p),
        area(),
        scale(1),
        anchor("center"),
        color(COLORS.accent),
        outline(4, COLORS.outline), // Thick outline
        ...(isFixed ? [fixed()] : []),
        z(zIndex),
        "ui-button"
    ]);
    
    btn.add([
        text(txt, { size: 28, align: "center" }),
        anchor("center"),
        color(0, 0, 0),
    ]);

    btn.onClick(() => {
        Sound.click();
        f();
    });

    btn.onHoverUpdate(() => {
        btn.scale = vec2(1.05);
        btn.color = Color.fromHex(COLORS.accentHighlight);
        setCursor("pointer");
    });

    btn.onHoverEnd(() => {
        btn.scale = vec2(1);
        btn.color = Color.fromHex(COLORS.accent);
        setCursor("default");
    });

    return btn;
}

function addPanel(width, height, p, opts = {}) {
    const isFixed = opts.fixed || false;
    const zIndex = opts.z || 0;

    // Panel Shadow
    add([
        rect(width, height, { radius: 24 }),
        pos(p.add(vec2(8, 8))),
        anchor("center"),
        color(0, 0, 0),
        opacity(0.3),
        ...(isFixed ? [fixed()] : []),
        z(zIndex > 0 ? zIndex - 1 : 0),
    ]);

    // Main Panel
    return add([
        rect(width, height, { radius: 24 }),
        pos(p),
        anchor("center"),
        color(Color.fromHex(COLORS.base)),
        outline(6, COLORS.outline),
        ...(isFixed ? [fixed()] : []),
        z(zIndex),
    ]);
}

// --- Scene Management ---

function fadeTransition() {
    const f = add([
        rect(width(), height()),
        color(0, 0, 0),
        opacity(1),
        fixed(),
        z(1000),
        "transition"
    ]);
    tween(1, 0, 0.5, (val) => f.opacity = val, easings.easeOutQuad)
        .onEnd(() => destroy(f));
}

// Every scene starts here: backdrop layer + fade in
function enterScene() {
    add([z(-100), fixed(), { draw: drawBackdrop }]);
    fadeTransition();
}

// Menu Scene
scene("menu", () => {
    enterScene();

    spawnFloatingDisks(7);

    // Title: chunky outlined text that bobs gently
    add([
        text("Tower of Hanoi", { size: 64, align: "center" }),
        pos(center().x, 150),
        anchor("center"),
        color(COLORS.accent),
        outline(6, COLORS.outline),
        {
            baseY: 150,
            update() {
                this.pos.y = this.baseY + Math.sin(time() * 2) * 4;
            }
        }
    ]);
    
    add([
        text("Roguelite Edition", { size: 32, letterSpacing: 4 }),
        pos(center().x, 210),
        anchor("center"),
        color(COLORS.text),
        outline(3, COLORS.outline),
    ]);

    addButton("Start Run", vec2(center().x, 350), () => {
        initRun();
    });

    // Bean Mascot
    const bean = add([
        rect(60, 100, { radius: 28 }),
        pos(width() - 100, height() - 50),
        anchor("bot"),
        color(COLORS.accent),
        outline(4, COLORS.outline),
    ]);
    
    // Eyes
    bean.add([
        circle(8),
        pos(-15, -60),
        color(BLACK)
    ]);
    bean.add([
        circle(8),
        pos(15, -60),
        color(BLACK)
    ]);
    
    // Mouth
    bean.add([
        rect(20, 5, { radius: 2 }),
        pos(0, -40),
        anchor("center"),
        color(BLACK)
    ]);
    
    // Animation
    bean.onUpdate(() => {
        bean.angle = Math.sin(time() * 4) * 5;
        bean.scale = vec2(1, 1 + Math.sin(time() * 8) * 0.05);
    });
});

// Shop Scene
scene("shop", () => {
    enterScene();

    add([
        text("Upgrade Module", { size: 48 }),
        pos(center().x, 40),
        anchor("center"),
        color(COLORS.accent),
        outline(5, COLORS.outline),
    ]);

    add([
        text(`Bits: ${state.gold}`, { size: 32 }),
        pos(center().x, 90),
        anchor("center"),
        color(COLORS.gold),
    ]);

    let yPos = 140;
    upgrades.forEach(item => {
        const itemBtn = add([
            rect(500, 50, { radius: 12 }),
            pos(center().x, yPos),
            anchor("center"),
            area(),
            color(state.gold >= item.cost ? rgb(255, 255, 255) : rgb(200, 200, 200)),
            outline(3, COLORS.outline),
        ]);

        itemBtn.add([
            text(`${item.name} (${item.cost})`, { size: 20 }),
            pos(-230, 0),
            anchor("left"),
            color(0, 0, 0),
        ]);
        
        itemBtn.add([
            text(item.desc, { size: 16 }),
            pos(230, 0),
            anchor("right"),
            color(rgb(80, 80, 80)),
        ]);

        itemBtn.onClick(() => {
            if (state.gold >= item.cost) {
                Sound.click();
                state.gold -= item.cost;
                item.action();
                go("shop"); // Refresh shop
            } else {
                Sound.invalid();
                shake(2);
            }
        });
        
        // Hover effect for shop items
        itemBtn.onHoverUpdate(() => {
            if (state.gold >= item.cost) {
                itemBtn.scale = vec2(1.02);
                setCursor("pointer");
            }
        });
        
        itemBtn.onHoverEnd(() => {
            itemBtn.scale = vec2(1);
            setCursor("default");
        });

        yPos += 60;
    });

    addButton("Next Level", vec2(center().x, 450), () => {
        state.level++;
        startLevel();
    });
});

// Game Over Scene
scene("gameover", () => {
    enterScene();

    addPanel(500, 300, center());

    add([
        text("Game Over", { size: 64 }),
        pos(center().x, 180),
        anchor("center"),
        color(COLORS.danger),
        outline(6, COLORS.outline),
    ]);

    add([
        text(`Score: ${state.score}\nLevel: ${state.level}`, { size: 32, align: "center" }),
        pos(center().x, 280),
        anchor("center"),
        color(COLORS.text),
    ]);

    addButton("Main Menu", vec2(center().x, 380), () => {
        go("menu");
    });
});

// Main Game Scene
scene("game", () => {
    enterScene();

    console.log("Entering Game Scene");
    
    // --- HUD ---
    const hudLayer = add([
        fixed(),
        z(100)
    ]);

    // Top Left Stats Panel
    hudLayer.add([
        rect(220, 130, { radius: 12 }),
        pos(10, 10),
        color(0, 0, 0),
        opacity(0.5),
        outline(2, COLORS.outline),
    ]);

    // Level
    const levelLabel = hudLayer.add([
        text(`Level: ${state.level}`, { size: 24 }),
        pos(25, 25),
        color(255, 255, 255),
        "hud-level"
    ]);

    // Gold
    const goldLabel = hudLayer.add([
        text(`Bits: ${state.gold}`, { size: 24 }),
        pos(25, 55),
        color(COLORS.gold),
        "hud-gold"
    ]);

    // Score
    const scoreLabel = hudLayer.add([
        text(`Score: ${state.score}`, { size: 24 }),
        pos(25, 85),
        color(255, 255, 255),
        "hud-score"
    ]);

    // Lives
    const livesLabel = hudLayer.add([
        text(`Lives: ${state.lives}`, { size: 24 }),
        pos(25, 115),
        color(COLORS.danger),
        "hud-lives"
    ]);

    // Combo
    const comboLabel = hudLayer.add([
        text(`x${combo.multiplier.toFixed(1)}`, { size: 48 }),
        pos(width() - 30, 50),
        anchor("topright"),
        color(COLORS.accent),
        outline(4, COLORS.outline),
        "hud-combo"
    ]);

    // Abort Button (Small)
    const abortBtn = hudLayer.add([
        rect(100, 40, { radius: 8 }),
        pos(width() - 70, 125),
        anchor("center"),
        area(),
        color(COLORS.danger),
        outline(2, COLORS.outline),
    ]);
    
    abortBtn.add([
        text("Abort", { size: 20 }),
        anchor("center"),
        color(255, 255, 255)
    ]);
    
    abortBtn.onClick(() => {
        if (state.isPlaying) {
             Sound.click();
             go("menu");
        }
    });
    
    abortBtn.onHoverUpdate(() => {
        abortBtn.scale = vec2(1.1);
        setCursor("pointer");
    });
    abortBtn.onHoverEnd(() => {
        abortBtn.scale = vec2(1);
        setCursor("default");
    });

    // Helper to update HUD
    function updateGameHUD() {
        if (levelLabel) levelLabel.text = `Level: ${state.level}`;
        if (goldLabel) goldLabel.text = `Bits: ${state.gold}`;
        if (scoreLabel) scoreLabel.text = `Score: ${state.score}`;
        if (livesLabel) livesLabel.text = `Lives: ${state.lives}`;
        if (comboLabel) {
            comboLabel.text = `x${combo.multiplier.toFixed(1)}`;
            comboLabel.color = combo.value > 80 ? Color.fromHex(COLORS.accent) : (combo.value > 50 ? Color.fromHex(COLORS.gold) : Color.fromHex(COLORS.danger));
            // Pulse combo text if high
            if (combo.value > 80) {
                comboLabel.scale = vec2(1 + Math.sin(time() * 10) * 0.1);
            } else {
                comboLabel.scale = vec2(1);
            }
        }
    }

    // Update HUD loop
    hudLayer.onUpdate(updateGameHUD);

    // Tower setup
    const towerWidth = 16; // Thicker poles
    const towerHeight = 250;
    const baseWidth = 240;
    const baseHeight = 24;
    const towerGap = 280;
    const startX = width() / 2 - towerGap;
    const groundY = height() - 50;

    const towers = [];
    
    // Selection state
    let selectedDisk = null;
    let selectedTowerIdx = null;

    // Create Towers
    for (let i = 0; i < 3; i++) {
        const xPos = startX + (i * towerGap);
        
        // Base drop shadow (same offset language as the buttons)
        add([
            rect(baseWidth, baseHeight, { radius: 8 }),
            pos(xPos + 4, groundY + 4),
            anchor("bot"),
            color(0, 0, 0),
            opacity(0.35),
            z(-2),
        ]);

        // Base
        add([
            rect(baseWidth, baseHeight, { radius: 8 }),
            pos(xPos, groundY),
            anchor("bot"),
            color(Color.fromHex(COLORS.base)),
            outline(2, COLORS.outline),
            area(),
            "base"
        ]);

        // Pole
        const pole = add([
            rect(towerWidth, towerHeight, { radius: 8 }),
            pos(xPos, groundY),
            anchor("bot"),
            color(Color.fromHex(COLORS.tower)),
            outline(2, COLORS.outline),
            area(),
            "pole",
            { towerId: i }
        ]);

        // Rounded cap on top of the pole
        pole.add([
            circle(towerWidth * 0.75),
            pos(0, -towerHeight),
            anchor("center"),
            color(Color.fromHex(COLORS.disks[5])),
            outline(2, COLORS.outline),
        ]);
        
        // Hitbox for clicking the tower area
        const clickArea = add([
            rect(baseWidth, towerHeight + 40),
            pos(xPos, groundY),
            anchor("bot"),
            opacity(0),
            area(),
            "towerClick",
            { towerId: i }
        ]);

        // Target marker (visual)
        if (i === state.targetTowerIndex) {
            const glow = add([
                rect(baseWidth + 30, towerHeight + 50, { radius: 16 }),
                pos(xPos, groundY + 10),
                anchor("bot"),
                color(Color.fromHex(COLORS.accent)),
                opacity(0.1),
                outline(3, COLORS.accent),
                z(-1)
            ]);

            add([
                text("TARGET", { size: 16 }),
                pos(xPos, groundY - towerHeight - 28),
                anchor("center"),
                color(Color.fromHex(COLORS.accent)),
                outline(3, COLORS.outline),
                z(5),
            ]);
            
            // Pulse effect
            glow.onUpdate(() => {
                glow.opacity = wave(0.05, 0.2, time() * 3);
            });
        }

        towers.push({
            disks: [], // Array of disk objects
            id: i
        });

        // Click handler
        clickArea.onClick(() => {
            handleTowerClick(i);
        });
        
        clickArea.onHoverUpdate(() => {
            setCursor("pointer");
        });
        clickArea.onHoverEnd(() => {
            setCursor("default");
        });
    }

    // Spawn Disks
    const startTower = towers[0];
    const diskHeight = 30; // Thicker disks
    const maxDiskWidth = 200;
    const minDiskWidth = 60;
    
    const towerPolePos = { x: startX, y: groundY }; // Tower 0 position

    for (let i = state.disks; i >= 1; i--) {
        const sizeRatio = (i - 1) / 7; // 0 to 1
        // Clamp i to max 8 for colors
        const colorIdx = Math.min(i - 1, 7);
        const diskWidth = minDiskWidth + (sizeRatio * (maxDiskWidth - minDiskWidth));
        
        // Let's stack them properly
        const stackIndex = startTower.disks.length;
        const diskY = groundY - baseHeight - (stackIndex * (diskHeight + 3));
        
        const disk = add([
            rect(diskWidth, diskHeight, { radius: 10 }),
            pos(towerPolePos.x, diskY),
            anchor("bot"),
            color(Color.fromHex(COLORS.disks[colorIdx])),
            outline(3, COLORS.outline), // Bold outlines
            area(),
            z(10), // Ensure disks are above everything
            "disk",
            { 
                size: i,
                towerId: 0 
            }
        ]);

        // Glossy highlight strip for a chunky, toy-like look
        disk.add([
            rect(diskWidth - 28, 5, { radius: 3 }),
            pos(0, -diskHeight + 7),
            anchor("center"),
            color(255, 255, 255),
            opacity(0.35),
        ]);

        startTower.disks.push(disk);
    }

    // --- Game Logic Helpers ---

    function handleTowerClick(towerIdx) {
        if (!state.isPlaying) return;

        const tower = towers[towerIdx];

        if (!selectedDisk) {
            // Select top disk
            if (tower.disks.length > 0) {
                const topDisk = tower.disks[tower.disks.length - 1];
                selectDisk(topDisk, towerIdx);
            }
        } else {
            // Move or Deselect
            if (towerIdx === selectedTowerIdx) {
                deselectDisk();
            } else {
                attemptMove(towerIdx);
            }
        }
    }

    function selectDisk(disk, towerIdx) {
        selectedDisk = disk;
        selectedTowerIdx = towerIdx;
        Sound.select();
        
        // Visual feedback
        disk.scale = vec2(1.1);
        
        // Float animation
        tween(disk.pos.y, disk.pos.y - 40, 0.2, (val) => disk.pos.y = val, easings.easeOutQuad);
    }

    function deselectDisk() {
        if (!selectedDisk) return;
        Sound.deselect();
        
        const disk = selectedDisk; // Capture reference for tween
        const tower = towers[selectedTowerIdx];
        const targetY = groundY - baseHeight - ((tower.disks.length - 1) * (diskHeight + 3));
        
        // Reset visuals
        disk.scale = vec2(1);
        
        // Return to position
        tween(disk.pos.y, targetY, 0.2, (val) => disk.pos.y = val, easings.easeOutQuad);
        
        selectedDisk = null;
        selectedTowerIdx = null;
    }

    function attemptMove(targetTowerIdx) {
        const targetTower = towers[targetTowerIdx];
        const topTargetDisk = targetTower.disks.length > 0 ? targetTower.disks[targetTower.disks.length - 1] : null;
        
        const selectedSize = selectedDisk.size;
        const targetSize = topTargetDisk ? topTargetDisk.size : Infinity;

        if (selectedSize < targetSize) {
            executeMove(targetTowerIdx);
        } else {
            handleInvalidMove(targetTowerIdx);
        }
    }

    function executeMove(targetTowerIdx) {
        const sourceTower = towers[selectedTowerIdx];
        const targetTower = towers[targetTowerIdx];
        
        // Capture disk reference for animation
        const disk = selectedDisk;
        
        // Remove from source
        sourceTower.disks.pop();
        
        // Add to target
        targetTower.disks.push(disk);
        disk.towerId = targetTowerIdx;
        
        Sound.move();

        // Animate move
        // Calculate target position
        // x is tower x
        const towerX = startX + (targetTowerIdx * towerGap);
        const targetY = groundY - baseHeight - ((targetTower.disks.length - 1) * (diskHeight + 3));
        
        const moveTime = 0.3;
        
        // Reset selection visuals first
        disk.scale = vec2(1);

        // Move Animation
        tween(disk.pos.x, towerX, moveTime, (val) => disk.pos.x = val, easings.easeInOutQuad);
        tween(disk.pos.y, targetY, moveTime, (val) => disk.pos.y = val, easings.easeOutBack);

        // Landing juice: squash and dust burst
        wait(moveTime, () => {
            disk.scale = vec2(1.12, 0.88);
            tween(disk.scale, vec2(1), 0.25, (val) => disk.scale = val, easings.easeOutQuad);
            spawnBurst(vec2(towerX, targetY), COLORS.disks[Math.min(disk.size - 1, 7)]);
        });
        
        // Update State
        state.moves++;
        
        // Rewards
        const baseRoll = randomInt(state.moveGoldMin, state.moveGoldMax);
        const moveGold = Math.ceil((baseRoll + modifiers.goldPerMove) * combo.multiplier);
        state.gold += moveGold;
        state.score += Math.round(moveGold * 10 * modifiers.scoreMultiplier);
        
        // Combo
        combo.value += modifiers.comboGain;
        if (combo.value > 100) {
            combo.value = 100;
            combo.multiplier += 0.1;
        }
        updateComboMultiplier();
        
        // Reset Selection
        selectedDisk = null;
        selectedTowerIdx = null;
        
        // Check Win
        checkWin();
    }

    function handleInvalidMove(towerIdx) {
        shake(5); // Screen shake
        Sound.invalid();
        
        // Penalty
        state.lives--;
        combo.multiplier = 1.0;
        combo.value = 0;
        
        deselectDisk();
        
        if (state.lives <= 0) {
            go("gameover");
        }
    }

    // Check Win
    function checkWin() {
        const targetTower = towers[state.targetTowerIndex];
        if (targetTower.disks.length === state.disks) {
            state.isPlaying = false;
            combo.active = false;
            Sound.win();
            spawnConfetti(); // Celebration!
            wait(0.5, () => {
                showLevelComplete();
            });
        }
    }

    function spawnConfetti() {
        for (let i = 0; i < 80; i++) {
            const p = vec2(rand(0, width()), rand(-20, -100));
            const c = add([
                rect(rand(8, 16), rand(8, 16)),
                pos(p),
                color(choose(COLORS.disks)),
                opacity(1),
                rotate(rand(0, 360)),
                "confetti"
            ]);
            
            // Assign properties directly to the object
            c.speed = rand(200, 400);
            c.drift = rand(-50, 50);
            c.spin = rand(-5, 5);
        }
    }
    
    // Confetti Logic
    onUpdate("confetti", (c) => {
        c.move(c.drift, c.speed);
        c.angle += c.spin;
        if (c.pos.y > height()) {
            destroy(c);
        }
    });

    // Combo Loop
    onUpdate(() => {
        if (!state.isPlaying) return;
        
        if (combo.value > 0) {
            combo.value -= modifiers.comboDecayRate;
            if (combo.value < 0) combo.value = 0;
        }
        
        if (combo.value === 0 && combo.multiplier > 1.0) {
            combo.multiplier = 1.0;
        }
    });
});

// --- System Functions ---

function initRun() {
    Sound.init(); // Initialize audio context on user gesture
    
    state.level = 1;
    state.gold = 0;
    state.score = 0;
    state.lives = 3;
    state.maxLives = 3;
    state.prevTargetTowerIndex = 2;
    
    modifiers.comboDecayRate = 0.3;
    modifiers.goldPerMove = 1;
    modifiers.goldMultiplier = 1;
    modifiers.scoreMultiplier = 1;

    startLevel();
}

function startLevel() {
    state.moves = 0;
    state.isPlaying = true;
    
    state.disks = 3 + Math.floor((state.level - 1) / 2);
    if (state.disks > 8) state.disks = 8;

    const possibleTargets = [1, 2].filter(i => i !== state.prevTargetTowerIndex);
    const nextTarget = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
    state.targetTowerIndex = nextTarget;
    state.prevTargetTowerIndex = nextTarget;

    const baseMin = 1 + Math.floor((state.level - 1) / 3);
    const baseMax = baseMin + 2 + Math.floor(Math.random() * 3);
    state.moveGoldMin = baseMin;
    state.moveGoldMax = baseMax;

    const bonusBase = 20 + state.level * 10;
    state.levelBonusMin = bonusBase;
    state.levelBonusMax = bonusBase + 40;

    // Reset Combo
    combo.value = 0;
    combo.multiplier = 1.0;
    combo.active = true;

    // Start Kaplay Scene
    go("game");
}

function updateComboMultiplier() {
    if (combo.multiplier > 5.0) combo.multiplier = 5.0;
}

function showLevelComplete() {
    const levelBonus = randomInt(state.levelBonusMin, state.levelBonusMax);
    state.gold += levelBonus;
    
    add([
        rect(width(), height()),
        color(0,0,0),
        opacity(0.8),
        fixed(),
        z(200)
    ]);
    
    addPanel(600, 400, center(), { fixed: true, z: 201 });
    
    add([
        text("Level Complete!", { size: 48 }),
        pos(center().x, 150),
        anchor("center"),
        fixed(),
        z(202),
        color(Color.fromHex(COLORS.accent)),
        outline(5, COLORS.outline)
    ]);

    add([
        text(`Moves: ${state.moves}\nBonus: ${levelBonus}`, { size: 32, align: "center" }),
        pos(center().x, 250),
        anchor("center"),
        fixed(),
        z(202),
        color(COLORS.text)
    ]);

    addButton("Enter Shop", vec2(center().x, 350), () => {
        go("shop");
    }, 200, 60, { fixed: true, z: 202 });
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// --- Shop System ---

const upgrades = [
    { id: 'life', name: 'Stability Patch', desc: '+1 Max Life', cost: 50, action: () => { state.maxLives++; state.lives++; } },
    { id: 'gold', name: 'Bit Miner', desc: '+1 Bit per Move', cost: 100, action: () => { modifiers.goldPerMove++; } },
    { id: 'decay', name: 'Neural Link', desc: 'Slower Combo Decay', cost: 75, action: () => { modifiers.comboDecayRate *= 0.8; } },
    { id: 'boost', name: 'Overclock', desc: '+0.5x Base Multiplier', cost: 150, action: () => { combo.multiplier += 0.5; } },
    { id: 'heal', name: 'Emergency Repair', desc: 'Restore 1 Life', cost: 30, action: () => { if(state.lives < state.maxLives) state.lives++; } },
];

// Initialize
go("menu");
