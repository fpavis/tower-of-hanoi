document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const towers = document.querySelectorAll('.tower');
    const moveCountSpan = document.getElementById('move-count');
    
    // Screens & Modals
    const startScreen = document.getElementById('start-screen');
    const hud = document.getElementById('hud');
    const gameControls = document.getElementById('game-controls');
    const gameBoard = document.getElementById('game-board');
    const messageModal = document.getElementById('message');
    const shopScreen = document.getElementById('shop-screen');
    const comboContainer = document.getElementById('combo-container');

    // Buttons
    const startBtn = document.getElementById('start-btn');
    const menuBtn = document.getElementById('menu-btn'); // "Abort Run"
    const toShopBtn = document.getElementById('to-shop-btn');
    const nextLevelBtn = document.getElementById('next-level-btn');

    // Displays
    const levelDisplay = document.getElementById('level-display');
    const goldDisplay = document.getElementById('gold-display');
    const scoreDisplay = document.getElementById('score-display');
    const livesDisplay = document.getElementById('lives-display');
    const comboMultiplierDisplay = document.getElementById('combo-multiplier');
    const comboBarFill = document.getElementById('combo-bar-fill');
    const finalMovesSpan = document.getElementById('final-moves');
    const earnedGoldSpan = document.getElementById('earned-gold');
    const shopGoldDisplay = document.getElementById('shop-gold');
    const shopItemsContainer = document.getElementById('shop-items');

    // Game State
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

    // Upgrades / Modifiers
    const modifiers = {
        comboDecayRate: 0.3, // Percent per frame
        goldPerMove: 1,
        goldMultiplier: 1,
        scoreMultiplier: 1,
        comboGain: 30 // Percent added per move
    };

    // Combo System
    const combo = {
        value: 0, // 0 to 100
        multiplier: 1.0,
        active: false,
        lastFrameTime: 0
    };

    // Selection State
    let selectedDisk = null;
    let selectedTower = null;

    // --- Core Game Loop ---

    function initRun() {
        state.level = 1;
        state.gold = 0;
        state.score = 0;
        state.lives = 3;
        state.maxLives = 3;
        state.prevTargetTowerIndex = 2;
        
        // Reset Modifiers
        modifiers.comboDecayRate = 0.3;
        modifiers.goldPerMove = 1;
        modifiers.goldMultiplier = 1;
        modifiers.scoreMultiplier = 1;

        updateHUD();
        startLevel();
    }

    function startLevel() {
        state.moves = 0;
        state.isPlaying = true;
        
        // Calculate disks based on level (slow progression)
        // Level 1-2: 3 disks
        // Level 3-4: 4 disks
        // Level 5-6: 5 disks...
        state.disks = 3 + Math.floor((state.level - 1) / 2);
        if (state.disks > 8) state.disks = 8; // Cap at 8 for CSS reasons

        // Choose destination tower for this level (must be 1 or 2 and not repeat last)
        const possibleTargets = [1, 2].filter(i => i !== state.prevTargetTowerIndex);
        const nextTarget = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
        state.targetTowerIndex = nextTarget;
        state.prevTargetTowerIndex = nextTarget;

        // Randomize coin ranges for this level
        const baseMin = 1 + Math.floor((state.level - 1) / 3);
        const baseMax = baseMin + 2 + Math.floor(Math.random() * 3); // Wider range later
        state.moveGoldMin = baseMin;
        state.moveGoldMax = baseMax;

        const bonusBase = 20 + state.level * 10;
        state.levelBonusMin = bonusBase;
        state.levelBonusMax = bonusBase + 40;

        // UI Updates
        startScreen.classList.add('hidden');
        shopScreen.classList.add('hidden');
        messageModal.classList.add('hidden');
        
        hud.classList.remove('hidden');
        gameControls.classList.remove('hidden');
        gameBoard.classList.remove('hidden');
        comboContainer.classList.remove('hidden');

        moveCountSpan.textContent = 0;
        updateHUD();

        // Reset Board
        setupBoard();

        // Reset Combo
        combo.value = 0;
        combo.multiplier = 1.0;
        combo.active = true;
        combo.lastFrameTime = 0;
        requestAnimationFrame(gameLoop);
    }

    function setupBoard() {
        towers.forEach(tower => {
            const disks = tower.querySelectorAll('.disk');
            disks.forEach(disk => disk.remove());
            tower.classList.remove('selected-tower');
            tower.classList.remove('target-tower');
        });

        const startTower = towers[0];
        for (let i = state.disks; i >= 1; i--) {
            const disk = document.createElement('div');
            disk.classList.add('disk');
            disk.dataset.size = i;
            startTower.appendChild(disk);
        }

        // Mark target tower visually
        towers[state.targetTowerIndex].classList.add('target-tower');
    }

    // --- Game Logic ---

    function handleTowerClick(tower) {
        if (!state.isPlaying) return;

        if (!selectedDisk) {
            const topDisk = getTopDisk(tower);
            if (topDisk) {
                selectDisk(tower, topDisk);
            }
        } else {
            if (tower === selectedTower) {
                deselectDisk();
            } else {
                attemptMove(tower);
            }
        }
    }

    function getTopDisk(tower) {
        const disks = tower.querySelectorAll('.disk');
        if (disks.length === 0) return null;
        return disks[disks.length - 1];
    }

    function selectDisk(tower, disk) {
        selectedDisk = disk;
        selectedTower = tower;
        disk.classList.add('selected');
        tower.classList.add('selected-tower');
    }

    function deselectDisk() {
        if (selectedDisk) {
            selectedDisk.classList.remove('selected');
            selectedDisk = null;
        }
        if (selectedTower) {
            selectedTower.classList.remove('selected-tower');
            selectedTower = null;
        }
    }

    function attemptMove(targetTower) {
        const topDiskTarget = getTopDisk(targetTower);
        const selectedSize = parseInt(selectedDisk.dataset.size);
        const targetSize = topDiskTarget ? parseInt(topDiskTarget.dataset.size) : Infinity;

        if (selectedSize < targetSize) {
            executeMove(targetTower);
        } else {
            handleInvalidMove(targetTower);
        }
    }

    function executeMove(targetTower) {
        targetTower.appendChild(selectedDisk);
        state.moves++;
        moveCountSpan.textContent = state.moves;
        
        // Rewards (randomized per move within this level's range)
        const baseRoll = randomInt(state.moveGoldMin, state.moveGoldMax);
        const moveGold = Math.ceil((baseRoll + modifiers.goldPerMove) * combo.multiplier);
        state.gold += moveGold;
        state.score += Math.round(moveGold * 10 * modifiers.scoreMultiplier);
        
        // Combo Boost
        combo.value += modifiers.comboGain;
        if (combo.value > 100) {
            combo.value = 100;
            combo.multiplier += 0.1; // Bonus for maintaining max
        }
        
        // Base multiplier increase based on current meter
        // Actually, let's make multiplier discrete steps based on meter?
        // Or just let meter be a buffer for the multiplier not to drop.
        // Let's go with: Meter > 0 keeps multiplier alive. Meter hitting 100 boosts multiplier.
        // Simplified: Multiplier is static 1.0 + (Meter / 100). No that's too volatile.
        // Let's stick to: Meter decays. Every move adds Meter. 
        // If Meter is > 50%, Multiplier = 1.5x. > 80% = 2.0x.
        updateComboMultiplier();

        updateHUD();
        deselectDisk();
        checkWin();
    }

    function handleInvalidMove(tower) {
        shakeTower(tower);
        // Penalty
        state.lives--;
        combo.multiplier = 1.0;
        combo.value = 0;
        updateHUD();
        
        if (state.lives <= 0) {
            gameOver();
        }
    }

    function shakeTower(tower) {
        tower.animate([
            { transform: 'translateX(0)' },
            { transform: 'translateX(-5px)' },
            { transform: 'translateX(5px)' },
            { transform: 'translateX(0)' }
        ], { duration: 200 });
    }

    function checkWin() {
        const targetTower = towers[state.targetTowerIndex];
        const diskCount = targetTower.querySelectorAll('.disk').length;

        if (diskCount === state.disks) {
            state.isPlaying = false;
            combo.active = false;
            setTimeout(showLevelComplete, 500);
        }
    }

    function showLevelComplete() {
        const levelBonus = randomInt(state.levelBonusMin, state.levelBonusMax);
        state.gold += levelBonus;
        
        finalMovesSpan.textContent = state.moves;
        earnedGoldSpan.textContent = levelBonus; // Just showing bonus here for now
        messageModal.classList.remove('hidden');
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function gameOver() {
        state.isPlaying = false;
        alert(`Game Over! Run ended at Level ${state.level}. Score: ${state.score}`);
        // Reset to title
        startScreen.classList.remove('hidden');
        hud.classList.add('hidden');
        gameControls.classList.add('hidden');
        gameBoard.classList.add('hidden');
        comboContainer.classList.add('hidden');
    }

    // --- Combo System ---

    function gameLoop(timestamp) {
        if (!state.isPlaying) return;

        if (!combo.lastFrameTime) combo.lastFrameTime = timestamp;
        const deltaTime = timestamp - combo.lastFrameTime;

        // Decay combo
        if (combo.value > 0) {
            combo.value -= modifiers.comboDecayRate; // * (deltaTime / 16);
            if (combo.value < 0) combo.value = 0;
        }

        // Drop multiplier if combo empty
        if (combo.value === 0 && combo.multiplier > 1.0) {
            combo.multiplier = 1.0;
        }

        // Visual Update
        comboBarFill.style.width = `${combo.value}%`;
        
        // Color shift based on heat
        if (combo.value > 80) comboBarFill.style.background = '#00f3ff';
        else if (combo.value > 50) comboBarFill.style.background = '#ffaa00';
        else comboBarFill.style.background = '#ff0055';

        comboMultiplierDisplay.textContent = combo.multiplier.toFixed(1);

        combo.lastFrameTime = timestamp;
        requestAnimationFrame(gameLoop);
    }

    function updateComboMultiplier() {
        // Simple logic: If meter is high, bump multiplier slightly
        // Or just let the moves naturally build it up.
        // Let's just cap it.
        if (combo.multiplier > 5.0) combo.multiplier = 5.0;
    }

    // --- Shop System ---

    const upgrades = [
        { id: 'life', name: 'Stability Patch', desc: '+1 Max Life', cost: 50, action: () => { state.maxLives++; state.lives++; } },
        { id: 'gold', name: 'Bit Miner', desc: '+1 Bit per Move', cost: 100, action: () => { modifiers.goldPerMove++; } },
        { id: 'decay', name: 'Neural Link', desc: 'Slower Combo Decay', cost: 75, action: () => { modifiers.comboDecayRate *= 0.8; } },
        { id: 'boost', name: 'Overclock', desc: '+0.5x Base Multiplier', cost: 150, action: () => { combo.multiplier += 0.5; } },
        { id: 'heal', name: 'Emergency Repair', desc: 'Restore 1 Life', cost: 30, action: () => { if(state.lives < state.maxLives) state.lives++; } },
    ];

    function openShop() {
        messageModal.classList.add('hidden');
        shopScreen.classList.remove('hidden');
        shopGoldDisplay.textContent = state.gold;
        renderShopItems();
    }

    function renderShopItems() {
        shopItemsContainer.innerHTML = '';
        upgrades.forEach(item => {
            const div = document.createElement('div');
            div.classList.add('shop-item');
            if (state.gold < item.cost) div.classList.add('disabled');
            
            div.innerHTML = `
                <h3>${item.name}</h3>
                <p>${item.desc}</p>
                <div class="price">${item.cost} Bits</div>
            `;
            
            div.addEventListener('click', () => buyItem(item));
            shopItemsContainer.appendChild(div);
        });
    }

    function buyItem(item) {
        if (state.gold >= item.cost) {
            state.gold -= item.cost;
            item.action();
            updateHUD();
            shopGoldDisplay.textContent = state.gold;
            renderShopItems(); // Re-render to update disabled states
        }
    }

    function nextLevel() {
        state.level++;
        startLevel();
    }

    function updateHUD() {
        levelDisplay.textContent = state.level;
        goldDisplay.textContent = state.gold;
        scoreDisplay.textContent = state.score;
        livesDisplay.textContent = '♥'.repeat(state.lives);
    }

    // --- Event Listeners ---
    
    towers.forEach(tower => {
        tower.addEventListener('click', () => handleTowerClick(tower));
    });

    startBtn.addEventListener('click', initRun);
    
    menuBtn.addEventListener('click', () => {
        if (confirm('Abort Run? Progress will be lost.')) {
            startScreen.classList.remove('hidden');
            hud.classList.add('hidden');
            gameControls.classList.add('hidden');
            gameBoard.classList.add('hidden');
            comboContainer.classList.add('hidden');
            shopScreen.classList.add('hidden');
            state.isPlaying = false;
        }
    });

    toShopBtn.addEventListener('click', openShop);
    nextLevelBtn.addEventListener('click', nextLevel);
});
